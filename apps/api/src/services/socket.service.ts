import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { EventPubSubMessageSchema, type EventPubSubMessage } from '@hookpilot/shared';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { socketAuthMiddleware } from '../middlewares/socket-auth.middleware.js';
import {
  type MembershipRepository,
  membershipRepository as defaultMembershipRepo,
} from '../repositories/membership.repository.js';

export interface SocketServerOptions {
  redisUrl?: string;
  membershipRepo?: MembershipRepository;
  pubClient?: Redis;
  subClient?: Redis;
  eventsSubClient?: Redis;
  corsOrigin?: string;
  disableRedisAdapter?: boolean;
}

export interface ExtendedSocketServer extends Server {
  cleanup?: () => Promise<void>;
}

/**
 * Creates and initializes a Socket.IO server backed by Redis adapter and pub/sub.
 */
export function createSocketServer(
  httpServer: HttpServer,
  options: SocketServerOptions = {},
): ExtendedSocketServer {
  const membershipRepo = options.membershipRepo || defaultMembershipRepo;
  const redisUrl = options.redisUrl || env.REDIS_URL;
  const corsOrigin = options.corsOrigin || env.CORS_ORIGIN;

  const io: ExtendedSocketServer = new Server(httpServer, {
    cors: {
      origin: corsOrigin,
      credentials: true,
    },
    pingInterval: 25000,
    pingTimeout: 20000,
    transports: ['websocket', 'polling'],
  });

  let pubClient: Redis | null = null;
  let subClient: Redis | null = null;
  let eventsSubClient: Redis | null = null;

  // Set up Redis Adapter if not explicitly disabled
  if (!options.disableRedisAdapter) {
    try {
      pubClient =
        options.pubClient ||
        new Redis(redisUrl, {
          maxRetriesPerRequest: null,
          retryStrategy: (times) => Math.min(times * 200, 3000),
        });

      subClient = options.subClient || pubClient.duplicate();

      io.adapter(createAdapter(pubClient, subClient));
      logger.info('Socket.IO Redis adapter configured');
    } catch (err) {
      logger.error({ err }, 'Failed to initialize Socket.IO Redis adapter');
    }
  }

  // Set up Redis subscriber for 'events' channel
  try {
    eventsSubClient =
      options.eventsSubClient ||
      (pubClient ? pubClient.duplicate() : new Redis(redisUrl, { maxRetriesPerRequest: null }));

    eventsSubClient.subscribe('events', (err) => {
      if (err) {
        logger.error({ err }, "Failed to subscribe to Redis 'events' channel");
      } else {
        logger.info("Subscribed to Redis 'events' channel for Socket.IO realtime emissions");
      }
    });

    eventsSubClient.on('message', (channel: string, message: string) => {
      if (channel !== 'events') return;

      try {
        const rawJson = JSON.parse(message);
        const parsed = EventPubSubMessageSchema.safeParse(rawJson);

        const data: EventPubSubMessage = parsed.success ? parsed.data : rawJson;
        if (!data.workspaceId) return;

        const room = `ws:${data.workspaceId}`;

        if (data.type === 'event.created') {
          io.local.to(room).emit('event:created', data);
        } else {
          // 'event.status_changed', 'event.dead', or other updates
          io.local.to(room).emit('event:update', data);
        }
      } catch (parseErr) {
        logger.error({ err: parseErr }, "Error processing message from 'events' channel");
      }
    });
  } catch (err) {
    logger.error({ err }, "Failed to establish Redis subscriber for 'events' channel");
  }

  // Authentication middleware
  io.use(socketAuthMiddleware);

  // Connection handler
  io.on('connection', async (socket: Socket) => {
    const user = socket.data.user;
    logger.debug({ socketId: socket.id, userId: user?.id }, 'Socket.IO client connected');

    // Auto-join workspace room if specified in handshake auth
    const initialWorkspaceId = socket.handshake.auth?.workspaceId;
    if (initialWorkspaceId && typeof initialWorkspaceId === 'string' && user?.id) {
      try {
        const membership = await membershipRepo.findByWorkspaceAndUser(initialWorkspaceId, user.id);
        if (membership) {
          await socket.join(`ws:${initialWorkspaceId}`);
          logger.debug(
            { socketId: socket.id, workspaceId: initialWorkspaceId },
            'Socket auto-joined workspace room via handshake',
          );
        }
      } catch (err) {
        logger.warn({ err, workspaceId: initialWorkspaceId }, 'Failed handshake auto-join');
      }
    }

    // Join workspace room dynamically with membership validation
    socket.on(
      'join:workspace',
      async (
        payload: { workspaceId?: string },
        ack?: (res: { success: boolean; error?: string }) => void,
      ) => {
        try {
          const workspaceId = payload?.workspaceId;
          if (!workspaceId) {
            ack?.({ success: false, error: 'WORKSPACE_ID_REQUIRED' });
            return;
          }

          if (!user?.id) {
            ack?.({ success: false, error: 'UNAUTHORIZED' });
            return;
          }

          const membership = await membershipRepo.findByWorkspaceAndUser(workspaceId, user.id);
          if (!membership) {
            socket.emit('error', {
              code: 'FORBIDDEN',
              message: 'You are not a member of this workspace',
            });
            ack?.({ success: false, error: 'FORBIDDEN' });
            return;
          }

          await socket.join(`ws:${workspaceId}`);
          logger.debug(
            { socketId: socket.id, workspaceId, userId: user.id },
            'Socket joined workspace room',
          );
          ack?.({ success: true });
        } catch (err) {
          logger.error({ err, socketId: socket.id }, 'Error during join:workspace');
          ack?.({ success: false, error: 'INTERNAL_ERROR' });
        }
      },
    );

    // Leave workspace room
    socket.on(
      'leave:workspace',
      async (payload: { workspaceId?: string }, ack?: (res: { success: boolean }) => void) => {
        if (payload?.workspaceId) {
          await socket.leave(`ws:${payload.workspaceId}`);
        }
        ack?.({ success: true });
      },
    );

    socket.on('disconnect', (reason) => {
      logger.debug({ socketId: socket.id, reason }, 'Socket.IO client disconnected');
    });
  });

  // Attach cleanup helper
  io.cleanup = async () => {
    io.close();
    if (eventsSubClient) {
      try {
        await eventsSubClient.unsubscribe();
        await eventsSubClient.quit();
      } catch {
        eventsSubClient.disconnect();
      }
    }
    if (subClient && subClient !== eventsSubClient) {
      try {
        await subClient.quit();
      } catch {
        subClient.disconnect();
      }
    }
    if (pubClient) {
      try {
        await pubClient.quit();
      } catch {
        pubClient.disconnect();
      }
    }
  };

  return io;
}
