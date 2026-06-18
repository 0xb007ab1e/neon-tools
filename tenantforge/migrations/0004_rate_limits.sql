-- Cross-instance HTTP rate-limit counters (the shared-store realization of the per-principal limit).
-- A fixed-window counter keyed by principal; `increment` upserts atomically (see the pg
-- RateLimitStore adapter). Metadata only — no tenant data.
CREATE TABLE IF NOT EXISTS tf_rate_limits (
  key             text PRIMARY KEY,        -- the rate-limit key (authenticated principal id)
  window_start_ms bigint NOT NULL,         -- epoch-ms start of the current fixed window
  count           int NOT NULL DEFAULT 0   -- requests counted in that window
);
