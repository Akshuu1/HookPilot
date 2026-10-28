import { env } from './env.js';

/**
 * Returns array of allowed origin strings or wildcard patterns.
 * e.g., "http://localhost:5173,https://hookpilot.vercel.app,https://*.vercel.app"
 */
export function getCorsOrigins(): string[] {
  return env.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Validates whether an incoming HTTP request origin is permitted by the CORS allowlist.
 */
export function isOriginAllowed(origin: string | undefined): boolean {
  // Allow requests with no origin header (e.g. mobile apps, curl, server-to-server)
  if (!origin) return true;

  // Automatically allow all Vercel domains (production, preview, branch URLs)
  if (/^https:\/\/([a-zA-Z0-9-_.]+\.)?vercel\.app$/.test(origin)) return true;

  // Automatically allow localhost on any port
  if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return true;

  // Automatically allow Render domains
  if (/^https:\/\/([a-zA-Z0-9-_.]+\.)?onrender\.com$/.test(origin)) return true;

  const allowedOrigins = getCorsOrigins();
  if (allowedOrigins.includes('*')) return true;

  return allowedOrigins.some((pattern) => {
    if (pattern === origin) return true;
    if (pattern.includes('*')) {
      // Escape regex special chars except *
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      const regex = new RegExp(`^${escaped}$`, 'i');
      return regex.test(origin);
    }
    return false;
  });
}
