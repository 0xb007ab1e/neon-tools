import type { BillingPeriod, Consumption } from '../core/usage.js';

/**
 * Port: fetch a tenant project's resource consumption over a period, as per-timeframe buckets (the
 * core aggregates them). Backed by the Neon consumption API; the Neon API is an untrusted upstream
 * (timeouts, bounded retries, schema-validated responses — topic-api-consumption).
 */
export interface UsageProvider {
  /**
   * Return the per-timeframe consumption buckets for a Neon project over a period.
   *
   * @param neonProjectId - The project to meter.
   * @param period - The billing period.
   * @returns Per-bucket consumption (empty if the project had no consumption in the period).
   */
  getProjectConsumption(neonProjectId: string, period: BillingPeriod): Promise<Consumption[]>;
}
