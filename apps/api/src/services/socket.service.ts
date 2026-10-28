import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { EventPubSubMessageSchema, type EventPubSubMessage } from '@hookpilot/shared';
import { env } from '../config/env.js';
import { isOriginAllowed } from '../config/cors.js';
import { logger } from '../config/logger.js';
import { deliveryAttemptsTotal } from '../config/metrics.js';
import { socketAuthMiddleware } from '../middlewares/socket-auth.middleware.js';
import {
  type MembershipRepository,
  membershipRepository as defaultMembershipRepo,
} from '../repositories/membership.repository.js';
import {
  type EndpointRepository,
  endpointRepository as defaultEndpointRepo,
} from '../repositories/endpoint.repository.js';

export interface SocketServerOptions {
  redisUrl?: string;
  membershipRepo?: MembershipRepository;
  endpointRepo?: EndpointRepository;
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
  const endpointRepo = options.endpointRepo || defaultEndpointRepo;
  const redisUrl = options.redisUrl || env.REDIS_URL;

  const io: ExtendedSocketServer = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!options.corsOrigin) {
          if (isOriginAllowed(origin)) {
            callback(null, true);
          } else {
            callback(new Error(`Origin '${origin}' not permitted by Socket CORS policy`));
          }
        } else {
          // If explicitly overridden in options (e.g. tests)
          if (!origin || options.corsOrigin === '*' || options.corsOrigin === origin) {
            callback(null, true);
          } else {
            callback(new Error(`Origin '${origin}' not permitted by Socket CORS policy`));
          }
        }
      },
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
      pubClient.on('error', (err) => logger.warn({ err }, 'Redis pubClient connection error'));

      subClient = options.subClient || pubClient.duplicate();
      subClient.on('error', (err) => logger.warn({ err }, 'Redis subClient connection error'));

      io.adapter(createAdapter(pubClient, subClient));
      logger.info('Socket.IO Redis adapter configured');
    } catch (err) {
      logger.error({ err }, 'Failed to initialize Socket.IO Redis adapter');
    }
  }

  // Set up Redis subscriber for 'events' and 'tunnel:requests' channels
  try {
    eventsSubClient =
      options.eventsSubClient ||
      (pubClient ? pubClient.duplicate() : new Redis(redisUrl, { maxRetriesPerRequest: null }));
    eventsSubClient.on('error', (err) => logger.warn({ err }, 'Redis eventsSubClient error'));

    eventsSubClient.subscribe('events', 'tunnel:requests', (err) => {
      if (err) {
        logger.error({ err }, "Failed to subscribe to Redis 'events' / 'tunnel:requests' channels");
      } else {
        logger.info("Subscribed to Redis 'events' and 'tunnel:requests' channels");
      }
    });

    eventsSubClient.on('message', (channel: string, message: string) => {
      if (channel === 'tunnel:requests') {
        try {
          const req = JSON.parse(message);
          if (req.endpointId) {
            io.local.to(`tunnel:${req.endpointId}`).emit('tunnel:event', req);
            logger.debug(
              { eventId: req.eventId, endpointId: req.endpointId },
              'Forwarded tunnel request to connected CLI sockets',
            );
          }
        } catch (err) {
          logger.error({ err }, 'Error processing message from tunnel:requests channel');
        }
        return;
      }

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
          const resLabel =
            data.status === 'delivered'
              ? 'success'
              : data.status === 'dead'
                ? 'permanent'
                : 'retryable';
          deliveryAttemptsTotal.inc({ endpoint: data.endpointId, result: resLabel });
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

    // ==========================================
    // Phase 9: CLI Tunnel Handlers
    // ==========================================

    // CLI connects and registers for an endpoint tunnel session
    socket.on(
      'tunnel:join',
      async (
        payload: { endpointSlug?: string },
        ack?: (res: {
          success: boolean;
          error?: string;
          endpointId?: string;
          slug?: string;
        }) => void,
      ) => {
        try {
          const slug = payload?.endpointSlug?.trim();
          if (!slug) {
            ack?.({ success: false, error: 'ENDPOINT_SLUG_REQUIRED' });
            return;
          }

          const endpoint = await endpointRepo.findBySlug(slug);
          if (!endpoint || !endpoint.isActive) {
            ack?.({ success: false, error: 'ENDPOINT_NOT_FOUND' });
            return;
          }

          const endpointId = endpoint.id.toString();
          const endpointWorkspaceId = endpoint.workspaceId.toString();

          // Authorization verification:
          // 1. If CLI authenticated with API Key: verify API key belongs to this workspace
          if (socket.data.isCli && socket.data.workspaceId) {
            if (socket.data.workspaceId !== endpointWorkspaceId) {
              ack?.({ success: false, error: 'FORBIDDEN' });
              return;
            }
          } else if (user?.id) {
            // 2. If session token: verify user has membership in workspace
            const membership = await membershipRepo.findByWorkspaceAndUser(
              endpointWorkspaceId,
              user.id,
            );
            if (!membership) {
              ack?.({ success: false, error: 'FORBIDDEN' });
              return;
            }
          } else {
            ack?.({ success: false, error: 'UNAUTHORIZED' });
            return;
          }

          // Join socket room
          await socket.join(`tunnel:${endpointId}`);
          socket.data.endpointId = endpointId;
          socket.data.endpointSlug = slug;

          // Track active CLI session in Redis with 30s TTL
          if (pubClient) {
            await pubClient.set(`tunnel:endpoint:${endpointId}`, socket.id, 'EX', 30);
            await pubClient.set(`tunnel:slug:${slug}`, socket.id, 'EX', 30);
          }

          logger.info(
            { socketId: socket.id, endpointId, slug, workspaceId: endpointWorkspaceId },
            'CLI client joined tunnel session',
          );

          ack?.({ success: true, endpointId, slug });
        } catch (err) {
          logger.error({ err, socketId: socket.id }, 'Error during tunnel:join');
          ack?.({ success: false, error: 'INTERNAL_ERROR' });
        }
      },
    );

    // CLI sends heartbeat every 10s to keep Redis session alive
    socket.on(
      'tunnel:heartbeat',
      async (payload: { endpointSlug?: string }, ack?: (res: { success: boolean }) => void) => {
        const endpointId = socket.data.endpointId;
        const slug = payload?.endpointSlug || socket.data.endpointSlug;

        if (endpointId && pubClient) {
          try {
            await pubClient.set(`tunnel:endpoint:${endpointId}`, socket.id, 'EX', 30);
            if (slug) {
              await pubClient.set(`tunnel:slug:${slug}`, socket.id, 'EX', 30);
            }
            ack?.({ success: true });
          } catch {
            ack?.({ success: false });
          }
        } else {
          ack?.({ success: false });
        }
      },
    );

    // CLI replies with response from local forward
    socket.on(
      'tunnel:response',
      async (payload: {
        eventId: string;
        responseStatus: number;
        responseHeaders?: Record<string, string>;
        responseBodySnippet?: string;
        durationMs: number;
        error?: string | null;
      }) => {
        if (!payload?.eventId || !pubClient) return;

        try {
          await pubClient.publish(`tunnel:response:${payload.eventId}`, JSON.stringify(payload));
          logger.debug(
            { eventId: payload.eventId, status: payload.responseStatus },
            'Published tunnel response from CLI to Redis',
          );
        } catch (err) {
          logger.error(
            { err, eventId: payload.eventId },
            'Error publishing tunnel response to Redis',
          );
        }
      },
    );

    socket.on('disconnect', async (reason) => {
      logger.debug({ socketId: socket.id, reason }, 'Socket.IO client disconnected');
      if (socket.data.endpointId && pubClient) {
        try {
          await pubClient.del(`tunnel:endpoint:${socket.data.endpointId}`);
          if (socket.data.endpointSlug) {
            await pubClient.del(`tunnel:slug:${socket.data.endpointSlug}`);
          }
        } catch (err) {
          logger.warn({ err }, 'Error cleaning up tunnel Redis keys on disconnect');
        }
      }
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
