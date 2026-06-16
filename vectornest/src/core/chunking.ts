import type { Chunk } from './domain.js';

/** Configuration for {@link chunkText}. */
export interface ChunkOptions {
  /** Target maximum characters per chunk. */
  maxChars: number;
  /** Characters of overlap carried from the end of one chunk into the start of the next. */
  overlapChars: number;
}

/** Sensible defaults: ~1000-char chunks with 100-char overlap. */
export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { maxChars: 1000, overlapChars: 100 };

/**
 * Find where to end a chunk that starts at `start` and may run up to `hardEnd`, preferring a
 * natural boundary (newline, then space) so chunks don't cut mid-word. Returns `hardEnd` when no
 * boundary is found within the window.
 *
 * @param text - The full normalized text.
 * @param start - Inclusive start index of the current chunk.
 * @param hardEnd - Exclusive upper bound for the chunk end.
 * @returns The exclusive end index to slice to.
 */
function snapEnd(text: string, start: number, hardEnd: number): number {
  const newline = text.lastIndexOf('\n', hardEnd - 1);
  if (newline > start) return newline;
  const space = text.lastIndexOf(' ', hardEnd - 1);
  if (space > start) return space;
  return hardEnd;
}

/**
 * Split document text into overlapping chunks on natural boundaries.
 *
 * Pure and deterministic: the same text + options always produce the same chunks, so the core is
 * unit-testable without mocks. The strategy is intentionally simple (a boundary-snapping sliding
 * window); richer strategies plug in behind the same signature later.
 *
 * @param text - The document text to chunk.
 * @param options - Chunk size and overlap (defaults to {@link DEFAULT_CHUNK_OPTIONS}).
 * @returns Ordered chunks (ordinal starts at 0); empty when the text is blank.
 * @throws RangeError if the options are invalid.
 */
export function chunkText(text: string, options: ChunkOptions = DEFAULT_CHUNK_OPTIONS): Chunk[] {
  const { maxChars, overlapChars } = options;
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new RangeError('maxChars must be a positive integer');
  }
  if (!Number.isInteger(overlapChars) || overlapChars < 0) {
    throw new RangeError('overlapChars must be a non-negative integer');
  }
  if (overlapChars >= maxChars) {
    throw new RangeError('overlapChars must be less than maxChars');
  }

  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length === 0) return [];

  const chunks: Chunk[] = [];
  let start = 0;
  while (start < normalized.length) {
    const hardEnd = Math.min(start + maxChars, normalized.length);
    const end = hardEnd < normalized.length ? snapEnd(normalized, start, hardEnd) : hardEnd;
    const piece = normalized.slice(start, end).trim();
    if (piece.length > 0) {
      chunks.push({ ordinal: chunks.length, text: piece, metadata: {} });
    }
    if (end >= normalized.length) break;
    const nextStart = end - overlapChars;
    // Guarantee forward progress even when the boundary lands close to `start`.
    start = nextStart > start ? nextStart : end;
  }
  return chunks;
}
