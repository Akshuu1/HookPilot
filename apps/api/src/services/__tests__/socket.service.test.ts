/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { createSocketServer } from '../socket.service.js';
import type { MembershipRepository } from '../../repositories/membership.repository.js';
import type { EndpointRepository } from '../../repositories/endpoint.repository.js';
import type { IMembership } from '../../models/Membership.js';
import type { IEndpoint } from '../../models/Endpoint.js';

describe('SocketService Unit Tests', () => {
  let httpServer: HttpServer;
  let mockMembershipRepo: MembershipRepository;
  let mockEndpointRepo: EndpointRepository;
  let mockPubClient: any;
  let mockSubClient: any;
  let mockEventsSubClient: any;
  let messageListeners: Record<string, ((...args: any[]) => void)[]> = {};

  beforeEach(() => {
    httpServer = createServer();
    messageListeners = {};

    mockMembershipRepo = {
      create: vi.fn(),
      findByWorkspaceAndUser: vi.fn(),
      findByWorkspace: vi.fn(),
      findByUser: vi.fn(),
      updateRole: vi.fn(),
      delete: vi.fn(),
      countByWorkspace: vi.fn(),
    };

    mockEndpointRepo = {
      create: vi.fn(),
      findById: vi.fn(),
      findBySlug: vi.fn(),
      findByWorkspace: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };

    mockPubClient = {
      on: vi.fn(),
      duplicate: vi.fn(),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
      publish: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue('OK'),
      disconnect: vi.fn(),
    };

    mockSubClient = {
      on: vi.fn(),
      psubscribe: vi.fn((_p, cb) => cb?.(null)),
      punsubscribe: vi.fn((_p, cb) => cb?.(null)),
      subscribe: vi.fn((_c, cb) => cb?.(null)),
      unsubscribe: vi.fn((_c, cb) => cb?.(null)),
      quit: vi.fn().mockResolvedValue('OK'),
      disconnect: vi.fn(),
    };

    mockEventsSubClient = {
      on: vi.fn((event: string, cb: (...args: any[]) => void) => {
        if (!messageListeners[event]) messageListeners[event] = [];
        messageListeners[event].push(cb);
      }),
      subscribe: vi.fn((_ch1: string, _ch2: string, cb?: (err: null | Error) => void) => {
        cb?.(null);
      }),
      unsubscribe: vi.fn().mockResolvedValue('OK'),
      quit: vi.fn().mockResolvedValue('OK'),
      disconnect: vi.fn(),
    };
  });

  afterEach(() => {
    httpServer.close();
  });

  it('initializes socket server with pub/sub clients and cleanup handler', async () => {
    const io = createSocketServer(httpServer, {
      membershipRepo: mockMembershipRepo,
      endpointRepo: mockEndpointRepo,
      pubClient: mockPubClient,
      subClient: mockSubClient,
      eventsSubClient: mockEventsSubClient,
    });

    expect(io).toBeDefined();
    expect(mockEventsSubClient.subscribe).toHaveBeenCalledWith(
      'events',
      'tunnel:requests',
      expect.any(Function),
    );

    await io.cleanup?.();
    expect(mockEventsSubClient.quit).toHaveBeenCalled();
    expect(mockPubClient.quit).toHaveBeenCalled();
  });

  it('handles message events on eventsSubClient safely without throwing', async () => {
    const io = createSocketServer(httpServer, {
      membershipRepo: mockMembershipRepo,
      endpointRepo: mockEndpointRepo,
      pubClient: mockPubClient,
      subClient: mockSubClient,
      eventsSubClient: mockEventsSubClient,
    });

    const listener = messageListeners['message']?.[0];
    expect(listener).toBeDefined();

    // Valid tunnel request
    expect(() =>
      listener('tunnel:requests', JSON.stringify({ endpointId: 'ep_test_123', eventId: 'evt_1' })),
    ).not.toThrow();

    // Invalid tunnel request JSON
    expect(() => listener('tunnel:requests', 'invalid-json')).not.toThrow();

    // Valid events messages
    expect(() =>
      listener(
        'events',
        JSON.stringify({
          type: 'event.created',
          workspaceId: 'ws_999',
          eventId: 'evt_new',
          status: 'pending',
        }),
      ),
    ).not.toThrow();

    expect(() =>
      listener(
        'events',
        JSON.stringify({
          type: 'event.status_changed',
          workspaceId: 'ws_999',
          endpointId: 'ep_1',
          eventId: 'evt_new',
          status: 'delivered',
        }),
      ),
    ).not.toThrow();

    expect(() =>
      listener(
        'events',
        JSON.stringify({
          type: 'event.dead',
          workspaceId: 'ws_999',
          endpointId: 'ep_1',
          eventId: 'evt_dead',
          status: 'dead',
        }),
      ),
    ).not.toThrow();

    // Unrelated channel
    expect(() => listener('other:channel', '{}')).not.toThrow();

    // Malformed events payload
    expect(() => listener('events', 'not-valid-json')).not.toThrow();

    await io.cleanup?.();
  });

  it('handles socket connection events for workspace rooms and CLI tunnel', async () => {
    const io = createSocketServer(httpServer, {
      membershipRepo: mockMembershipRepo,
      endpointRepo: mockEndpointRepo,
      pubClient: mockPubClient,
      subClient: mockSubClient,
      eventsSubClient: mockEventsSubClient,
    });

    const socketListeners: Record<string, (...args: any[]) => void> = {};
    const mockSocket: any = {
      id: 'socket_test_1',
      data: { user: { id: 'usr_1', email: 'test@example.com' } },
      handshake: { auth: { workspaceId: 'ws_initial' } },
      join: vi.fn(),
      leave: vi.fn(),
      emit: vi.fn(),
      on: vi.fn((event: string, cb: (...args: any[]) => void) => {
        socketListeners[event] = cb;
      }),
    };

    vi.mocked(mockMembershipRepo.findByWorkspaceAndUser).mockResolvedValue({
      id: 'm_1',
      workspaceId: 'ws_initial',
      userId: 'usr_1',
      role: 'admin',
    } as unknown as IMembership);

    const connectionHandler =
      (io as any)._events?.['connection'] || (io as any).listeners('connection')[0];
    await connectionHandler(mockSocket);

    // Handshake auto-join
    expect(mockSocket.join).toHaveBeenCalledWith('ws:ws_initial');

    // join:workspace - missing workspaceId
    const badJoinAck = vi.fn();
    await socketListeners['join:workspace']({}, badJoinAck);
    expect(badJoinAck).toHaveBeenCalledWith({ success: false, error: 'WORKSPACE_ID_REQUIRED' });

    // join:workspace - success
    const joinAck = vi.fn();
    await socketListeners['join:workspace']({ workspaceId: 'ws_target' }, joinAck);
    expect(joinAck).toHaveBeenCalledWith({ success: true });

    // leave:workspace
    const leaveAck = vi.fn();
    await socketListeners['leave:workspace']({ workspaceId: 'ws_target' }, leaveAck);
    expect(mockSocket.leave).toHaveBeenCalledWith('ws:ws_target');
    expect(leaveAck).toHaveBeenCalledWith({ success: true });

    // tunnel:join - missing slug
    const badSlugAck = vi.fn();
    await socketListeners['tunnel:join']({}, badSlugAck);
    expect(badSlugAck).toHaveBeenCalledWith({ success: false, error: 'ENDPOINT_SLUG_REQUIRED' });

    // tunnel:join - endpoint not found
    vi.mocked(mockEndpointRepo.findBySlug).mockResolvedValue(null);
    const notFoundAck = vi.fn();
    await socketListeners['tunnel:join']({ endpointSlug: 'non-existent' }, notFoundAck);
    expect(notFoundAck).toHaveBeenCalledWith({ success: false, error: 'ENDPOINT_NOT_FOUND' });

    // tunnel:join - valid slug
    vi.mocked(mockEndpointRepo.findBySlug).mockResolvedValue({
      id: 'ep_tunnel_1',
      workspaceId: 'ws_initial',
      isActive: true,
      slug: 'my-tunnel-slug',
    } as unknown as IEndpoint);

    const tunnelJoinAck = vi.fn();
    await socketListeners['tunnel:join']({ endpointSlug: 'my-tunnel-slug' }, tunnelJoinAck);
    expect(tunnelJoinAck).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, endpointId: 'ep_tunnel_1' }),
    );
    expect(mockPubClient.set).toHaveBeenCalledWith(
      'tunnel:endpoint:ep_tunnel_1',
      'socket_test_1',
      'EX',
      30,
    );

    // tunnel:heartbeat
    const hbAck = vi.fn();
    await socketListeners['tunnel:heartbeat']({ endpointSlug: 'my-tunnel-slug' }, hbAck);
    expect(hbAck).toHaveBeenCalledWith({ success: true });

    // tunnel:response
    await socketListeners['tunnel:response']({
      eventId: 'evt_123',
      responseStatus: 200,
      durationMs: 45,
    });
    expect(mockPubClient.publish).toHaveBeenCalledWith(
      'tunnel:response:evt_123',
      expect.stringContaining('"responseStatus":200'),
    );

    // disconnect cleanup
    await socketListeners['disconnect']('transport close');
    expect(mockPubClient.del).toHaveBeenCalledWith('tunnel:endpoint:ep_tunnel_1');

    await io.cleanup?.();
  });
});
