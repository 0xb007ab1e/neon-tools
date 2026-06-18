import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createFilesystemObjectStore } from '../../src/adapters/object-store/filesystem.js';

const root = mkdtempSync(join(tmpdir(), 'tf-fs-store-'));

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('createFilesystemObjectStore', () => {
  it('writes the object (creating parent dirs) and returns a file URL + byte size', async () => {
    const store = createFilesystemObjectStore({ dir: root });
    const body = Buffer.from('dump-bytes');
    const result = await store.put('tenants/abc/2026.dump', body);

    expect(result.bytes).toBe(body.byteLength);
    expect(result.location.startsWith('file://')).toBe(true);
    expect(readFileSync(fileURLToPath(result.location))).toEqual(body);
  });

  it('rejects a non-absolute root directory', () => {
    expect(() => createFilesystemObjectStore({ dir: 'relative/dir' })).toThrow(/absolute path/);
  });

  it('rejects a key that escapes the root (path traversal)', async () => {
    const store = createFilesystemObjectStore({ dir: root });
    await expect(store.put('../../etc/passwd', Buffer.from('x'))).rejects.toThrow(
      /escapes the root/,
    );
  });
});
