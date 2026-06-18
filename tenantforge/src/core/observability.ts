import type { JsonObject, JsonValue } from './domain.js';

/**
 * A structured, tenant-scoped control-plane event (for per-tenant observability — usage, errors,
 * SLOs, support, billing; topic-logging-observability / topic-multi-tenancy).
 *
 * Carries the tenant id so a tenant's activity is traceable end-to-end. Context is always passed
 * through {@link redactSecrets} before emission so a secret can never reach logs/metrics (master §5).
 */
export interface TenantEvent {
  /** Dotted event name, e.g. `tenant.provisioned`, `tenant.transition`, `fleet.migration`. */
  event: string;
  /** Emission instant (ISO-8601 UTC). */
  at: string;
  /** Whether the operation succeeded or failed. */
  outcome: 'ok' | 'error';
  /**
   * The operator who performed the action, for non-repudiation / audit attribution
   * (who-did-what-when — NIST AU, SOC2 change management, OWASP A09). Absent for actions with
   * no request context (e.g. scheduled sweeps). `id` is an operator identity, never a secret.
   */
  actor?: { id: string; role: string };
  /** The tenant the event concerns (absent for fleet-level events). */
  tenantId?: string;
  /** Operation duration in milliseconds. */
  durationMs?: number;
  /** Safe, non-sensitive context (already redacted). */
  context?: JsonObject;
  /** Failure message when `outcome === 'error'` (never includes secrets). */
  error?: string;
}

/** Substrings (case-insensitive) marking a key whose value must never be logged. */
const SECRET_KEY_PATTERNS = [
  'connectionuri',
  'connection_uri',
  'password',
  'secret',
  'token',
  'authorization',
  'apikey',
  'api_key',
];

/** The placeholder substituted for a redacted value. */
const REDACTED = '[redacted]';

/** Whether a key names a secret that must be masked. */
function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_KEY_PATTERNS.some((p) => lower.includes(p));
}

/** Recursively redact secret-keyed values within any JSON value. */
function redactValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') return redactObject(value);
  return value;
}

/** Redact a JSON object: mask secret-keyed values, recurse into the rest. */
function redactObject(obj: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = isSecretKey(key) ? REDACTED : redactValue(value);
  }
  return out;
}

/**
 * Return a copy of `context` with any secret-keyed values masked (e.g. `connectionUri`, `password`,
 * `token`). Recurses into nested objects and arrays. Pure — the redaction guarantee for the
 * observability layer, so an event can never carry a secret into logs/metrics (master §5).
 *
 * @param context - The raw context object.
 * @returns A redacted copy safe to emit.
 */
export function redactSecrets(context: JsonObject): JsonObject {
  return redactObject(context);
}
