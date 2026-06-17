import { describe, expect, it, vi } from 'vitest';
import type { TenantEvent } from '../../src/core/observability.js';
import { createJsonEventSink, createNoopEventSink } from '../../src/adapters/event-sink.js';

const event: TenantEvent = {
  event: 'tenant.transition',
  at: '2026-06-17T00:00:00.000Z',
  outcome: 'ok',
  tenantId: 't1',
  context: { from: 'active', to: 'suspended' },
};

describe('createJsonEventSink', () => {
  it('writes one JSON line per event', () => {
    const lines: string[] = [];
    createJsonEventSink((l) => lines.push(l)).emit(event);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0]!)).toEqual(event);
  });

  it('defaults to writing to process.stdout', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      createJsonEventSink().emit(event);
      expect(spy).toHaveBeenCalledWith(`${JSON.stringify(event)}\n`);
    } finally {
      spy.mockRestore();
    }
  });

  it('never throws if the writer fails (best-effort)', () => {
    const sink = createJsonEventSink(() => {
      throw new Error('stdout closed');
    });
    expect(() => sink.emit(event)).not.toThrow();
  });
});

describe('createNoopEventSink', () => {
  it('discards events without throwing', () => {
    expect(() => createNoopEventSink().emit(event)).not.toThrow();
  });
});
