import { describe, it, expect, vi } from 'vitest';
import type { Socket } from 'socket.io';
import { socketAuthMiddleware } from '../socket-auth.middleware.js';
import { signAccessToken } from '../../utils/security.js';

describe('socketAuthMiddleware Unit Tests', () => {
  const validUser = {
    userId: 'user-123',
    email: 'test@example.com',
    name: 'Test User',
  };

  it('rejects connection when no token is provided in handshake', () => {
    const mockSocket = {
      handshake: {
        auth: {},
        headers: {},
        query: {},
      },
      data: {},
    } as unknown as Socket;

    const next = vi.fn();
    socketAuthMiddleware(mockSocket, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0][0];
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Authentication required. Missing token.');
  });

  it('rejects connection when token is invalid or malformed', () => {
    const mockSocket = {
      handshake: {
        auth: { token: 'invalid.jwt.token' },
        headers: {},
        query: {},
      },
      data: {},
    } as unknown as Socket;

    const next = vi.fn();
    socketAuthMiddleware(mockSocket, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0][0];
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Invalid or expired token.');
  });

  it('authenticates successfully with token in auth.token', () => {
    const token = signAccessToken(validUser);
    const mockSocket = {
      handshake: {
        auth: { token },
        headers: {},
        query: {},
      },
      data: {},
    } as unknown as Socket;

    const next = vi.fn();
    socketAuthMiddleware(mockSocket, next);

    expect(next).toHaveBeenCalledWith();
    expect(mockSocket.data.user).toEqual({
      id: validUser.userId,
      email: validUser.email,
      name: validUser.name,
    });
  });

  it('authenticates successfully with Bearer token in headers.authorization', () => {
    const token = signAccessToken(validUser);
    const mockSocket = {
      handshake: {
        auth: {},
        headers: { authorization: `Bearer ${token}` },
        query: {},
      },
      data: {},
    } as unknown as Socket;

    const next = vi.fn();
    socketAuthMiddleware(mockSocket, next);

    expect(next).toHaveBeenCalledWith();
    expect(mockSocket.data.user.id).toBe(validUser.userId);
  });

  it('authenticates successfully with query.token', () => {
    const token = signAccessToken(validUser);
    const mockSocket = {
      handshake: {
        auth: {},
        headers: {},
        query: { token },
      },
      data: {},
    } as unknown as Socket;

    const next = vi.fn();
    socketAuthMiddleware(mockSocket, next);

    expect(next).toHaveBeenCalledWith();
    expect(mockSocket.data.user.id).toBe(validUser.userId);
  });
});
