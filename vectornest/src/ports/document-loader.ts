import type { SourceDocument } from '../core/domain.js';

/**
 * Port: resolves a source reference into a stream of documents.
 *
 * Streaming (async iterable) keeps ingest resumable and bounded for large inputs — the caller can
 * process and checkpoint per document rather than buffering the whole corpus.
 */
export interface DocumentLoader {
  /**
   * Load documents from a source.
   *
   * @param source - A loader-specific reference (e.g. a directory path or URL).
   * @returns An async iterable of documents, each with its content hash already computed.
   */
  load(source: string): AsyncIterable<SourceDocument>;
}
