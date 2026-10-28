import type { Socket } from 'socket.io';
import { verifyAccessToken, type AccessTokenPayload } from '../utils/security.js';
import { apiKeyService } from '../services/api-key.service.js';

export interface SocketUser {
  id: string;
  email: string;
  name: string;
}

declare module 'socket.io' {
  interface SocketData {
    user: SocketUser;
    workspaceId?: string;
    isCli?: boolean;
    endpointSlug?: string;
    endpointId?: string;
  }
}

/**
 * Socket.IO authentication middleware verifying either a JWT access token or an API key
 * from the handshake auth, headers, or query parameters.
 */
export async function socketAuthMiddleware(
  socket: Socket,
  next: (err?: Error) => void,
): Promise<void> {
  const authPayload = socket.handshake.auth || {};
  const headers = socket.handshake.headers || {};
  const query = socket.handshake.query || {};

  // Check for API Key first (CLI use)
  const apiKeyCandidate =
    (typeof authPayload.apiKey === 'string' ? authPayload.apiKey.trim() : undefined) ||
    (typeof headers['x-api-key'] === 'string' ? headers['x-api-key'].trim() : undefined) ||
    (typeof query.apiKey === 'string' ? (query.apiKey as string).trim() : undefined) ||
    (typeof authPayload.token === 'string' && authPayload.token.startsWith('hp_')
      ? authPayload.token.trim()
      : undefined);

  if (apiKeyCandidate) {
    try {
      const { apiKey, workspaceId } = await apiKeyService.verifyApiKey(apiKeyCandidate);
      socket.data.user = {
        id: apiKey.createdBy.toString(),
        email: `cli-${apiKey.prefix}@hookpilot.internal`,
        name: apiKey.name,
      };
      socket.data.workspaceId = workspaceId;
      socket.data.isCli = true;
      next();
      return;
    } catch {
      next(new Error('Invalid or expired API key.'));
      return;
    }
  }

  // Fallback to JWT access token
  const token =
    (typeof authPayload.token === 'string' ? authPayload.token.trim() : undefined) ||
    (headers.authorization?.startsWith('Bearer ')
      ? headers.authorization.slice(7).trim()
      : undefined) ||
    (typeof query.token === 'string' ? (query.token as string).trim() : undefined);

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
