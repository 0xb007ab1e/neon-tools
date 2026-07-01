import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isValidSlug, normalizeSlug, assertSlug } from '../../src/core/identifiers.js';
import { KNOWN_REGIONS } from '../../src/core/regions.js';
import { regionJurisdiction, KNOWN_JURISDICTIONS } from '../../src/core/residency.js';
import {
  compliantRegions,
  selectRegion,
  assertRehomeTarget,
  type RegionSelection,
} from '../../src/core/residency-router.js';
import type { Jurisdiction } from '../../src/core/residency.js';

// Build a RegionSelection omitting any undefined-valued key — `exactOptionalPropertyTypes` forbids
// passing `{ jurisdiction: undefined }`, so we only set a key when its value is present.
function mkSelection(
  allowed: readonly string[],
  jurisdiction: Jurisdiction | undefined,
  preferred?: string,
): RegionSelection {
  return {
    allowed,
    ...(jurisdiction !== undefined ? { jurisdiction } : {}),
    ...(preferred !== undefined ? { preferred } : {}),
  };
}

/**
 * Property-based tests for slug + region validation (defense-in-depth over the example-based
 * suites). These target the pure, security-relevant validators that gate tenant identity and data
 * residency — a false accept here is a routing/isolation or compliance defect.
 */

// A generator for the reserved control-plane names (never assignable to a tenant).
const RESERVED = ['admin', 'api', 'internal', 'system', 'tenantforge', 'public'] as const;

// Generate a well-formed, non-reserved slug: lowercase-alphanumeric hyphen-separated groups,
// length 3..63, that is not one of the reserved names. Built from a valid regex, then filtered so
// the (rare) collision with a reserved name is excluded rather than fed as a false counterexample.
const validSlug = fc
  .stringMatching(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .filter((s) => s.length >= 3 && s.length <= 63 && !(RESERVED as readonly string[]).includes(s));

describe('isValidSlug — properties', () => {
  it('accepts every generated well-formed, in-range, non-reserved slug', () => {
    fc.assert(
      fc.property(validSlug, (slug) => {
        expect(isValidSlug(slug)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('never accepts a string containing a disallowed character', () => {
    // A base valid slug with one clearly-disallowed character spliced in must always be rejected —
    // uppercase, whitespace, punctuation, and unicode are all outside the DNS-label-safe alphabet.
    const disallowed = fc.constantFrom(
      ' ',
      '_',
      '.',
      '/',
      '\\',
      '@',
      '#',
      'A',
      'Z',
      'é',
      '\t',
      '\n',
      ':',
      '*',
    );
    fc.assert(
      fc.property(validSlug, disallowed, fc.nat(), (slug, bad, pos) => {
        const at = pos % (slug.length + 1);
        const candidate = slug.slice(0, at) + bad + slug.slice(at);
        expect(isValidSlug(candidate)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('rejects anything shorter than 3 characters', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z0-9]{0,2}$/), (short) => {
        expect(isValidSlug(short)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects anything longer than 63 characters', () => {
    fc.assert(
      fc.property(fc.integer({ min: 64, max: 200 }), (len) => {
        const long = 'a'.repeat(len);
        expect(isValidSlug(long)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('always rejects a reserved name (case/whitespace-insensitively via normalizeSlug)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...RESERVED),
        fc.stringMatching(/^[ \t]*$/),
        fc.stringMatching(/^[ \t]*$/),
        (name, lead, trail) => {
          // A reserved name is invalid even with surrounding whitespace / mixed case after
          // normalization — normalizeSlug trims + lowercases but must not un-reserve it.
          const raw = `${lead}${name.toUpperCase()}${trail}`;
          expect(isValidSlug(normalizeSlug(raw))).toBe(false);
          expect(() => assertSlug(raw)).toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('assertSlug accepts a valid slug and returns its normalized (trimmed+lowercased) form', () => {
    fc.assert(
      fc.property(
        validSlug,
        fc.stringMatching(/^[ \t]*$/),
        fc.stringMatching(/^[ \t]*$/),
        (slug, lead, trail) => {
          // Wrapping a valid slug in surrounding whitespace still validates and normalizes back to
          // the exact slug (the slug is already lowercase, so casing is a no-op here).
          expect(assertSlug(`${lead}${slug}${trail}`)).toBe(slug);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('normalizeSlug is idempotent (normalize∘normalize = normalize)', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const once = normalizeSlug(s);
        expect(normalizeSlug(once)).toBe(once);
      }),
      { numRuns: 200 },
    );
  });
});

describe('selectRegion / compliantRegions — properties', () => {
  // An allow-list drawn from the KNOWN set plus occasional junk entries (which must be ignored).
  const knownSubset = fc.uniqueArray(fc.constantFrom(...KNOWN_REGIONS), {
    maxLength: KNOWN_REGIONS.length,
  });
  const withJunk = fc.uniqueArray(fc.oneof(fc.constantFrom(...KNOWN_REGIONS), fc.string()), {
    maxLength: KNOWN_REGIONS.length + 4,
  });
  const jurisdiction = fc.oneof(fc.constant(undefined), fc.constantFrom(...KNOWN_JURISDICTIONS));

  it('compliantRegions only ever returns known regions in KNOWN_REGIONS order', () => {
    fc.assert(
      fc.property(withJunk, jurisdiction, (allowed, j) => {
        const result = compliantRegions(mkSelection(allowed, j));
        // Every result is a known region (junk allow-list entries are ignored, never selected).
        for (const r of result) expect(KNOWN_REGIONS).toContain(r);
        // The output preserves KNOWN_REGIONS order (deterministic placement).
        const indices = result.map((r) => KNOWN_REGIONS.indexOf(r));
        expect([...indices].sort((a, b) => a - b)).toEqual(indices);
        // When a jurisdiction is required, every returned region is in it.
        if (j !== undefined) for (const r of result) expect(regionJurisdiction(r)).toBe(j);
      }),
      { numRuns: 200 },
    );
  });

  it('selectRegion returns a compliant region or throws — never a non-compliant one', () => {
    fc.assert(
      fc.property(
        withJunk,
        jurisdiction,
        fc.oneof(fc.constant(undefined), fc.constantFrom(...KNOWN_REGIONS), fc.string()),
        (allowed, j, preferred) => {
          const candidates = compliantRegions(mkSelection(allowed, j, preferred));
          if (candidates.length === 0) {
            // Fail closed: no compliant region ⇒ throw rather than provision non-compliantly.
            expect(() => selectRegion(mkSelection(allowed, j, preferred))).toThrow();
            return;
          }
          const chosen = selectRegion(mkSelection(allowed, j, preferred));
          // The chosen region is always within the compliant set (never outside residency policy).
          expect(candidates).toContain(chosen);
          // preferred wins iff it is itself compliant; otherwise the first compliant region.
          if (preferred !== undefined && candidates.includes(preferred)) {
            expect(chosen).toBe(preferred);
          } else {
            expect(chosen).toBe(candidates[0]);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('selectRegion is deterministic (same input ⇒ same output/throw)', () => {
    fc.assert(
      fc.property(knownSubset, jurisdiction, (allowed, j) => {
        const call = () => selectRegion(mkSelection(allowed, j));
        try {
          const a = call();
          expect(call()).toBe(a);
        } catch {
          // If it throws, it must throw again on the identical input.
          expect(call).toThrow();
        }
      }),
      { numRuns: 200 },
    );
  });

  it('a jurisdiction with at least one allow-listed region always yields a region in it', () => {
    fc.assert(
      fc.property(fc.constantFrom(...KNOWN_JURISDICTIONS), (j) => {
        // No allow-list ⇒ every jurisdiction present in KNOWN_REGIONS is satisfiable.
        const chosen = selectRegion({ jurisdiction: j });
        expect(regionJurisdiction(chosen)).toBe(j);
      }),
      { numRuns: 100 },
    );
  });
});

describe('assertRehomeTarget — properties', () => {
  const twoDistinctKnown = fc
    .tuple(fc.constantFrom(...KNOWN_REGIONS), fc.constantFrom(...KNOWN_REGIONS))
    .filter(([a, b]) => a !== b);

  it('accepts a distinct known target with no constraints', () => {
    fc.assert(
      fc.property(twoDistinctKnown, ([current, target]) => {
        expect(() => assertRehomeTarget(current, target)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it('always rejects re-homing to the same region (no-op guard)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...KNOWN_REGIONS), (region) => {
        expect(() => assertRehomeTarget(region, region)).toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('always rejects an unknown target region', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...KNOWN_REGIONS),
        fc.string().filter((s) => !KNOWN_REGIONS.includes(s)),
        (current, target) => {
          expect(() => assertRehomeTarget(current, target)).toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });

  it('rejects a target whose jurisdiction differs from the required one', () => {
    fc.assert(
      fc.property(
        twoDistinctKnown,
        fc.constantFrom(...KNOWN_JURISDICTIONS),
        ([current, target], required) => {
          if (regionJurisdiction(target) !== required) {
            expect(() => assertRehomeTarget(current, target, { jurisdiction: required })).toThrow();
          } else {
            // Same jurisdiction (and target is on the implicit unrestricted allow-list) ⇒ accepted.
            expect(() =>
              assertRehomeTarget(current, target, { jurisdiction: required }),
            ).not.toThrow();
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
