#!/usr/bin/env node
// Release gate: assert the version is identical across every site that carries it, so a release
// bump can never leave one stale (the README badge being the newest such site). `package.json` is
// the source of truth; the rest must match. Pure Node, no deps. Exits non-zero on any mismatch.
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');

const expected = JSON.parse(read('package.json')).version;

/** Each site: a label, the file, and a regex whose first capture group is the version found. */
const sites = [
  { label: 'neon-tool.json', file: 'neon-tool.json', re: /"version":\s*"([^"]+)"/ },
  { label: 'src/meta.ts', file: 'src/meta.ts', re: /version:\s*'([^']+)'/ },
  // OpenAPI info.version — the first `version:` whose value is a semver (skips schema `version: {…}`).
  { label: 'openapi.yaml', file: 'openapi.yaml', re: /^\s*version:\s*(\d+\.\d+\.\d+\S*)\s*$/m },
  { label: 'README Status', file: 'README.md', re: /\*\*Status:\*\*.*\(v([^)]+)\)/ },
  { label: 'README badge', file: 'README.md', re: /img\.shields\.io\/badge\/version-([^-\s)]+)-/ },
];

const mismatches = [];
for (const { label, file, re } of sites) {
  const m = re.exec(read(file));
  if (m === null) {
    mismatches.push(`${label}: no version found (pattern did not match)`);
  } else if (m[1] !== expected) {
    mismatches.push(`${label}: found "${m[1]}", expected "${expected}"`);
  }
}

if (mismatches.length > 0) {
  process.stderr.write(
    `version mismatch (source of truth: package.json = ${expected}):\n` +
      mismatches.map((s) => `  - ${s}`).join('\n') +
      '\nBump every version site together (see CHANGELOG release flow).\n',
  );
  process.exit(1);
}
process.stdout.write(`version OK: all sites at ${expected}\n`);
