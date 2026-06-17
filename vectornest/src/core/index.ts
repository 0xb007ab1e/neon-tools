/**
 * The pure core: deterministic, I/O-free logic (chunking, model-registry, ranking) plus the
 * domain types. Unit-testable without mocks (ARCHITECTURE §3).
 */
export * from './domain.js';
export { chunkText, DEFAULT_CHUNK_OPTIONS, type ChunkOptions } from './chunking.js';
export { parseModelName, knownDimension, type ParsedModel } from './model-registry.js';
export { cosineDistanceToScore, rankByScore } from './ranking.js';
export { isFullyEmbedded, assertActivatable, type ModelCoverage } from './reembed.js';
export {
  scoreRanking,
  aggregate,
  meetsThresholds,
  type EvalCase,
  type QueryOutcome,
  type EvalReport,
  type EvalThresholds,
} from './eval.js';
