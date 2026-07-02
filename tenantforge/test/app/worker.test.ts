import { describe, expect, it, vi } from 'vitest';
import { runWorkerCycle } from '../../src/app/worker.js';
import type { ConsumeReport } from '../../src/adapters/lifecycle-consumer.js';
import type { ErasureSweepReport, EvidencePruneReport, TenantForge } from '../../src/app/lib.js';

/** A lifecycle consumer stub returning a fixed drain report. */
function fakeConsumer(report: Partial<ConsumeReport> = {}): {
  drain: () => Promise<ConsumeReport>;
} {
  return {
    drain: () => Promise.resolve({ processed: 0, skipped: 0, deadLettered: 0, ...report }),
  };
}

/** A TenantForge stub exposing the two sweeps the worker cycle runs. */
function fakeTf(
  sweep: () => Promise<ErasureSweepReport>,
  prune: () => Promise<EvidencePruneReport> = () => Promise.resolve({ pruned: 0 }),
): Pick<TenantForge, 'erasureSweep' | 'evidencePrune'> {
  return { erasureSweep: () => sweep(), evidencePrune: () => prune() };
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

describe('runWorkerCycle — evidence retention prune wiring (gap #1)', () => {
  const okSweep = (): Promise<ErasureSweepReport> =>
    Promise.resolve({ scanned: 0, processed: [], skipped: [], failed: [] });

  it('runs the evidence-prune sweep each cycle and reports a non-empty prune', async () => {
    const prune = vi.fn((): Promise<EvidencePruneReport> => Promise.resolve({ pruned: 3 }));
    const lines: string[] = [];
    await runWorkerCycle(fakeConsumer(), fakeTf(okSweep, prune), (l) => lines.push(l));
    expect(prune).toHaveBeenCalledTimes(1);
    expect(lines.some((l) => l.includes('evidence-prune') && l.includes('3'))).toBe(true);
  });

  it('an evidence-prune failure is logged but never crashes the cycle', async () => {
    const lines: string[] = [];
    await expect(
      runWorkerCycle(
        fakeConsumer(),
        fakeTf(okSweep, () => Promise.reject(new Error('evidence store down'))),
        (l) => lines.push(l),
      ),
    ).resolves.toBeUndefined();
    expect(
      lines.some((l) => l.includes('evidence-prune error') && l.includes('evidence store down')),
    ).toBe(true);
  });

  it('a no-op prune (nothing expired) produces no evidence-prune log line', async () => {
    const lines: string[] = [];
    await runWorkerCycle(
      fakeConsumer(),
      fakeTf(okSweep, () => Promise.resolve({ pruned: 0 })),
      (l) => lines.push(l),
    );
    expect(lines.some((l) => l.includes('evidence-prune'))).toBe(false);
  });
});
