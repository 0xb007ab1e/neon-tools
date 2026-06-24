import { describe, expect, it, vi } from 'vitest';
import { runWorkerCycle } from '../../src/app/worker.js';
import type { ConsumeReport } from '../../src/adapters/lifecycle-consumer.js';
import type { ErasureSweepReport, TenantForge } from '../../src/app/lib.js';

/** A lifecycle consumer stub returning a fixed drain report. */
function fakeConsumer(report: Partial<ConsumeReport> = {}): {
  drain: () => Promise<ConsumeReport>;
} {
  return {
    drain: () => Promise.resolve({ processed: 0, skipped: 0, deadLettered: 0, ...report }),
  };
}

/** A TenantForge stub exposing only `erasureSweep`. */
function fakeTf(sweep: () => Promise<ErasureSweepReport>): Pick<TenantForge, 'erasureSweep'> {
  return { erasureSweep: () => sweep() };
}

describe('runWorkerCycle — erasure sweep wiring (M2)', () => {
  it('drains the lifecycle queue AND runs the erasure sweep each cycle', async () => {
    const sweep = vi.fn(
      (): Promise<ErasureSweepReport> =>
        Promise.resolve({ scanned: 1, processed: ['e-1'], skipped: [], failed: [] }),
    );
    const lines: string[] = [];
    await runWorkerCycle(fakeConsumer(), fakeTf(sweep), (l) => lines.push(l));
    expect(sweep).toHaveBeenCalledTimes(1);
    // A non-empty sweep is reported on the diagnostics sink.
    expect(lines.some((l) => l.includes('erasure-sweep') && l.includes('e-1'))).toBe(true);
  });

  it('an erasure-sweep failure is logged but never crashes the cycle (worker keeps running)', async () => {
    const lines: string[] = [];
    await expect(
      runWorkerCycle(
        fakeConsumer(),
        fakeTf(() => Promise.reject(new Error('store down'))),
        (l) => lines.push(l),
      ),
    ).resolves.toBeUndefined();
    expect(lines.some((l) => l.includes('erasure-sweep error') && l.includes('store down'))).toBe(
      true,
    );
  });

  it('a no-op sweep (nothing due) produces no erasure-sweep log line', async () => {
    const lines: string[] = [];
    await runWorkerCycle(
      fakeConsumer(),
      fakeTf(() => Promise.resolve({ scanned: 0, processed: [], skipped: [], failed: [] })),
      (l) => lines.push(l),
    );
    expect(lines.some((l) => l.includes('erasure-sweep'))).toBe(false);
  });
});
