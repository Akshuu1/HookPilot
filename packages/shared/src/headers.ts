const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'x-hookpilot-secret',
  'proxy-authorization',
]);

/**
 * Redacts sensitive authentication and session headers.
 * Normalizes all header keys to lowercase.
 */
export function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [key, val] of Object.entries(headers)) {
    if (val === undefined) continue;
    const lowerKey = key.toLowerCase();
    const stringVal = Array.isArray(val) ? val.join(', ') : val;

    if (SENSITIVE_HEADERS.has(lowerKey)) {
      sanitized[lowerKey] = '[REDACTED]';
    } else {
      sanitized[lowerKey] = stringVal;
    }
  }

  return sanitized;
}
