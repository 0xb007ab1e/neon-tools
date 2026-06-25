// @ts-check
/**
 * Stryker mutation testing — validates that the tests for the **critical pure-core modules**
 * actually catch faults, not just execute lines (coverage ≠ quality; master §4 mandates mutation
 * testing on critical paths). Scoped to the money + authorization logic, which is where a silent
 * test gap would mis-bill or mis-authorize. Runs the existing vitest unit suite per mutant.
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  testRunner: 'vitest',
  // Declare the runner explicitly — pnpm's non-flat node_modules defeats Stryker's plugin glob.
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'vitest.config.ts' },
  coverageAnalysis: 'perTest',
  mutate: [
    'src/core/billing.ts', // charge amount, proration, refund bounds, idempotency keys
    'src/core/credit.ts', // credit balance + draw-down
    'src/core/invoice.ts', // included-allowance / overage billing
    'src/core/invoice-email.ts', // invoice rendering + idempotency
    'src/core/cost.ts', // cost/margin estimation
    'src/core/cost-anomaly.ts', // FinOps anomaly classification
    'src/core/dunning.ts', // retry / suspend decisions
    'src/core/authz.ts', // role → permission authorization
    'src/core/erasure.ts', // GDPR erasure certificate + verified post-conditions (privacy/data-handling)
    'src/core/compliance-cert.ts', // signed-compliance-report claim canonicalization + alg-pinned verifier (crypto/privacy)
    'src/core/signup-request.ts', // self-serve signup state + one-time connection-reveal gate
    'src/core/signup-token.ts', // signup-token status / redeemability logic
    'src/core/email-verification.ts', // emailed-code verification (identity)
  ],
  reporters: ['clear-text', 'progress', 'html'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  tempDirName: '.stryker-tmp',
  // Gate: fail under `break`. Set below the measured baseline (~87% — the practical ceiling on these
  // modules, since the remaining survivors are equivalent mutants: proration boundaries that fall
  // through to the same value, and a redundant `typeof` guard before a membership check). This
  // catches a real regression in test quality without being unattainable; ratchet up over time.
  thresholds: { high: 95, low: 85, break: 85 },
  // Reproducible run: don't fan out across an unknown CI core count in a way that changes results.
  concurrency: 2,
};
