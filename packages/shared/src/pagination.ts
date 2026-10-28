export interface CursorData {
  receivedAt: Date;
  id: string;
}

/**
 * Encodes receivedAt and ID into an opaque, URL-safe base64 string cursor.
 */
export function encodeCursor(receivedAt: Date, id: string): string {
  const payload = `${receivedAt.getTime()}_${id}`;
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * Decodes an opaque base64 string cursor into receivedAt and ID.
 * Returns null if the cursor is invalid or malformed.
 */
export function decodeCursor(cursor: string): CursorData | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const [timeStr, id] = raw.split('_');
    if (!timeStr || !id) return null;

    const timeMs = parseInt(timeStr, 10);
    if (Number.isNaN(timeMs)) return null;

    const receivedAt = new Date(timeMs);
    if (Number.isNaN(receivedAt.getTime())) return null;

    return { receivedAt, id };
  } catch {
    return null;
  }
}
