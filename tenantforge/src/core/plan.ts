import type { IncludedUsage } from './invoice.js';

/**
 * A named **plan** in the operator's catalog — the product tier a tenant is on. Bundles the flat
 * price and the included usage allowances so they can be assigned together. This is *operator
 * product policy* (your pricing tiers); Neon has no notion of it — provisioning is per-project, not
 * per-plan. Quota (hard enforcement) is deliberately separate ({@link import('./quota.js').Quota}).
 */
export interface PlanDefinition {
  /** Stable plan id (e.g. `starter`, `pro`). Non-empty; unique within the catalog. */
  id: string;
  /** Human-readable name for display (defaults to `id` when unset). */
  name?: string;
  /** Flat per-period plan fee (USD, ≥ 0). Unset ⇒ treated as 0 (a free / usage-only plan). */
  priceUsd?: number;
  /** Included usage allowances; usage within them is free, only overage bills. Unset ⇒ none. */
  includedUsage?: IncludedUsage;
}

/** The allowance dimensions validated on a plan (mirrors {@link IncludedUsage}). */
const ALLOWANCE_DIMENSIONS: (keyof IncludedUsage)[] = [
  'computeTimeSeconds',
  'activeTimeSeconds',
  'syntheticStorageBytes',
  'writtenDataBytes',
];

/** Assert a number is finite and non-negative, else throw with context. */
function assertNonNeg(value: number, what: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`plan: ${what} must be a finite, non-negative number, got ${String(value)}`);
  }
}

/**
 * Validate an operator plan catalog (authored config — fail loud, unlike the lenient per-tenant
 * metadata parse). Checks non-empty unique ids and finite, non-negative price + allowance values.
 * Pure and deterministic.
 *
 * @param plans - The raw plan definitions.
 * @returns The same plans (validated).
 * @throws Error on an empty/duplicate id or a negative/non-finite price or allowance.
 */
export function assertPlanCatalog(plans: PlanDefinition[]): PlanDefinition[] {
  const seen = new Set<string>();
  for (const plan of plans) {
    if (typeof plan.id !== 'string' || plan.id.length === 0) {
      throw new Error('plan: each plan needs a non-empty id');
    }
    if (seen.has(plan.id)) throw new Error(`plan: duplicate plan id ${plan.id}`);
    seen.add(plan.id);
    if (plan.priceUsd !== undefined) assertNonNeg(plan.priceUsd, `${plan.id} priceUsd`);
    if (plan.includedUsage !== undefined) {
      for (const dim of ALLOWANCE_DIMENSIONS) {
        const v = plan.includedUsage[dim];
        if (v !== undefined) assertNonNeg(v, `${plan.id} includedUsage.${dim}`);
      }
    }
  }
  return plans;
}

/**
 * Find a plan by id in a catalog.
 *
 * @param plans - The catalog.
 * @param id - The plan id.
 * @returns The plan, or `undefined` when not found.
 */
export function findPlan(plans: PlanDefinition[], id: string): PlanDefinition | undefined {
  return plans.find((p) => p.id === id);
}

/** The metadata a plan assignment writes to a tenant (the plan fully defines its billing). */
export interface PlanAssignment {
  /** The assigned plan id (recorded on the tenant). */
  planId: string;
  /** The flat plan fee (USD) — `plan.priceUsd ?? 0`. */
  priceUsd: number;
  /** The plan's included allowances (`plan.includedUsage ?? {}` — empties clear prior allowances). */
  includedUsage: IncludedUsage;
}

/**
 * Derive the metadata patch for assigning `plan` to a tenant. The plan **fully defines** the
 * tenant's billing: price defaults to 0 and allowances default to empty (clearing any prior
 * per-tenant overrides), so assigning a plan is deterministic. Pure.
 *
 * @param plan - The plan being assigned.
 * @returns The assignment (planId + price + allowances) to merge into tenant metadata.
 */
export function planAssignment(plan: PlanDefinition): PlanAssignment {
  return {
    planId: plan.id,
    priceUsd: plan.priceUsd ?? 0,
    includedUsage: plan.includedUsage ?? {},
  };
}
