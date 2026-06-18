/** A keyset pagination cursor: the sort key of the last item on a page (created_at + id tiebreak). */
export interface TenantCursor {
  /** The last item's creation instant. */
  createdAt: Date;
  /** The last item's id (stable tiebreaker for equal timestamps). */
  id: string;
}

/**
 * Encode a {@link TenantCursor} as an opaque, URL-safe token (base64url of `iso|id`). Opaque so
 * clients treat it as a token, not a queryable structure (topic-api-design keyset pagination).
 *
 * @param cursor - The sort key of the last item on the current page.
 * @returns The opaque cursor token.
 */
export function encodeCursor(cursor: TenantCursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, 'utf8').toString(
    'base64url',
  );
}

/**
 * Decode an opaque cursor token back to a {@link TenantCursor}. Returns null for any malformed token
 * (a bad cursor is a client error, not a crash — the caller responds 400).
 *
 * @param token - The opaque cursor token from a client.
 * @returns The decoded cursor, or null if the token is invalid.
 */
export function decodeCursor(token: string): TenantCursor | null {
  // Node's base64url decoder never throws (it skips invalid chars); structural validation below
  // is what rejects malformed tokens.
  const decoded = Buffer.from(token, 'base64url').toString('utf8');
  const sep = decoded.indexOf('|');
  if (sep <= 0 || sep === decoded.length - 1) return null;
  const iso = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== iso) return null;
  return { createdAt, id };
}
