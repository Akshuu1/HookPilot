import type { Socket } from 'socket.io';
import { verifyAccessToken, type AccessTokenPayload } from '../utils/security.js';

export interface SocketUser {
  id: string;
  email: string;
  name: string;
}

declare module 'socket.io' {
  interface SocketData {
    user: SocketUser;
  }
}

/**
 * Socket.IO authentication middleware verifying the JWT from the handshake.
 * Checks handshake auth token, Authorization header, or query token.
 */
export function socketAuthMiddleware(socket: Socket, next: (err?: Error) => void): void {
  const token =
    (typeof socket.handshake.auth?.token === 'string'
      ? socket.handshake.auth.token.trim()
      : undefined) ||
    (socket.handshake.headers.authorization?.startsWith('Bearer ')
      ? socket.handshake.headers.authorization.slice(7).trim()
      : undefined) ||
    (typeof socket.handshake.query?.token === 'string'
      ? socket.handshake.query.token.trim()
      : undefined);

  if (!token) {
    next(new Error('Authentication required. Missing token.'));
    return;
  }

  try {
    const payload: AccessTokenPayload = verifyAccessToken(token);
    socket.data.user = {
      id: payload.userId,
      email: payload.email,
      name: payload.name,
    };
    next();
  } catch {
    next(new Error('Invalid or expired token.'));
  }
}
