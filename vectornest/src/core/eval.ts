/** A labeled evaluation case: a query and the source URIs (or substrings) that should match. */
export interface EvalCase {
  /** The query text. */
  query: string;
  /** Relevant source URIs; a hit matches if its sourceUri contains any of these. */
  relevant: string[];
}

/** Per-query outcome. */
export interface QueryOutcome {
  /** Whether a relevant document appeared in the ranked results. */
  matched: boolean;
  /** 1/rank of the first relevant hit (0 if none). */
  reciprocalRank: number;
}

/** Aggregate evaluation metrics. */
export interface EvalReport {
  /** Number of eval cases. */
  cases: number;
  /** Fraction of cases with a relevant hit in the top-k. */
  recallAtK: number;
  /** Mean reciprocal rank across cases. */
  mrr: number;
  /** The k used for retrieval. */
  k: number;
}

/** Pass thresholds for gating a swap. */
export interface EvalThresholds {
  /** Minimum acceptable recall@k. */
  minRecall?: number;
  /** Minimum acceptable MRR. */
  minMrr?: number;
}

/**
 * Score a single ranked result list against the relevant set.
 *
 * @param rankedUris - Result source URIs in rank order (best first).
 * @param relevant - Relevant URIs/substrings; a result matches if it contains one.
 * @returns Whether a relevant result was found and its reciprocal rank.
 */
export function scoreRanking(
  rankedUris: readonly string[],
  relevant: readonly string[],
): QueryOutcome {
  for (let i = 0; i < rankedUris.length; i += 1) {
    const uri = rankedUris[i];
    if (uri !== undefined && relevant.some((r) => uri.includes(r))) {
      return { matched: true, reciprocalRank: 1 / (i + 1) };
    }
  }
  return { matched: false, reciprocalRank: 0 };
}

/**
 * Aggregate per-query outcomes into recall@k and MRR.
 *
 * @param outcomes - Per-query outcomes.
 * @param k - The k used for retrieval.
 * @returns The aggregate report.
 */
export function aggregate(outcomes: readonly QueryOutcome[], k: number): EvalReport {
  const cases = outcomes.length;
  if (cases === 0) return { cases: 0, recallAtK: 0, mrr: 0, k };
  const matched = outcomes.filter((o) => o.matched).length;
  const rrSum = outcomes.reduce((sum, o) => sum + o.reciprocalRank, 0);
  return { cases, recallAtK: matched / cases, mrr: rrSum / cases, k };
}

/**
 * Whether a report meets the given thresholds (an unset threshold always passes).
 *
 * @param report - The evaluation report.
 * @param thresholds - Minimum recall/MRR to require.
 * @returns True if all set thresholds are met.
 */
export function meetsThresholds(report: EvalReport, thresholds: EvalThresholds): boolean {
  if (thresholds.minRecall !== undefined && report.recallAtK < thresholds.minRecall) return false;
  if (thresholds.minMrr !== undefined && report.mrr < thresholds.minMrr) return false;
  return true;
}
