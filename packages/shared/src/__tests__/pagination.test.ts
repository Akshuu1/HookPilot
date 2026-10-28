import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../pagination.js';

describe('Cursor Pagination Helpers', () => {
  it('encodes and decodes a date and id round-trip', () => {
    const date = new Date('2026-10-28T12:30:00.000Z');
    const id = '6ae1bb6ba487e16f7469806c';

    const cursor = encodeCursor(date, id);
    expect(typeof cursor).toBe('string');
    expect(cursor).not.toContain(':'); // should be base64url

    const decoded = decodeCursor(cursor);
    expect(decoded).not.toBeNull();
    expect(decoded?.receivedAt.toISOString()).toBe(date.toISOString());
    expect(decoded?.id).toBe(id);
  });

  it('returns null for malformed or invalid cursors', () => {
    expect(decodeCursor('invalid-cursor-value')).toBeNull();
    expect(decodeCursor('')).toBeNull();
    // Valid base64 but invalid date format
    const badDate = Buffer.from('not-a-date:id123').toString('base64url');
    expect(decodeCursor(badDate)).toBeNull();
  });
});
