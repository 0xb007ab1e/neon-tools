import { describe, expect, it } from 'vitest';
import {
  evidenceRetentionUntil,
  isEvidenceExpired,
  EVIDENCE_BUNDLE_ID_BYTES,
  type EvidenceManifest,
} from '../../src/core/evidence-manifest.js';

const HASHES = {
  inventory: 'h1',
  isolation: 'h2',
  residency: 'h3',
  auditExcerpt: 'h4',
  erasureCertificates: 'h5',
} as const;

const manifest = (over: Partial<EvidenceManifest> = {}): EvidenceManifest => ({
  bundleId: 'b-1',
  scope: 'fleet',
  generatedAt: '2026-06-25T00:00:00.000Z',
  storedAt: '2026-06-25T00:00:00.000Z',
  signerKid: 'tenantforge-evidence-bundle',
  contentHashes: { ...HASHES },
  ...over,
});

describe('evidenceRetentionUntil', () => {
  it('computes storedAt + N days (ISO-8601 UTC)', () => {
    const until = evidenceRetentionUntil(new Date('2026-06-25T00:00:00.000Z'), 30);
    expect(until).toBe('2026-07-25T00:00:00.000Z');
  });

  it('returns undefined for indefinite retention (0 or omitted)', () => {
    expect(evidenceRetentionUntil(new Date('2026-06-25T00:00:00.000Z'), 0)).toBeUndefined();
    expect(evidenceRetentionUntil(new Date('2026-06-25T00:00:00.000Z'), undefined)).toBeUndefined();
  });

  it('fails closed on a negative or non-integer window (no silent collapse)', () => {
    expect(() => evidenceRetentionUntil(new Date(), -1)).toThrow(/non-negative integer/);
    expect(() => evidenceRetentionUntil(new Date(), 1.5)).toThrow(/non-negative integer/);
  });

  it('one day is exactly 86_400_000 ms after storedAt', () => {
    const start = new Date('2026-06-25T12:34:56.000Z');
    const until = evidenceRetentionUntil(start, 1)!;
    expect(Date.parse(until) - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe('isEvidenceExpired', () => {
  it('is false for an indefinitely-retained bundle (no retentionUntil) at any time', () => {
    expect(isEvidenceExpired(manifest(), new Date('2099-01-01T00:00:00.000Z'))).toBe(false);
  });

  it('is true exactly at the retention deadline (<= now)', () => {
    const m = manifest({ retentionUntil: '2026-07-25T00:00:00.000Z' });
    expect(isEvidenceExpired(m, new Date('2026-07-25T00:00:00.000Z'))).toBe(true);
  });

  it('is true after, false before the deadline', () => {
    const m = manifest({ retentionUntil: '2026-07-25T00:00:00.000Z' });
    expect(isEvidenceExpired(m, new Date('2026-07-24T23:59:59.999Z'))).toBe(false);
    expect(isEvidenceExpired(m, new Date('2026-07-25T00:00:00.001Z'))).toBe(true);
  });
});

describe('EVIDENCE_BUNDLE_ID_BYTES', () => {
  it('is 16 bytes (128 bits of entropy — non-guessable)', () => {
    expect(EVIDENCE_BUNDLE_ID_BYTES).toBe(16);
  });
});
