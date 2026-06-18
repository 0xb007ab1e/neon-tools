import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { TenantRecord } from '../../src/core/index.js';
import type { ObjectStore, PutResult } from '../../src/ports/object-store.js';
import { createPgDumpExporter, spawnPgDump } from '../../src/adapters/pg-dump/exporter.js';

const tenant = (over: Partial<TenantRecord> = {}): TenantRecord => ({
  id: '11111111-1111-1111-1111-111111111111',
  slug: 'acme',
  region: 'aws-us-east-1',
  status: 'offboarding',
  neonProjectId: 'proj-1',
  metadata: {},
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...over,
});

/** A recording ObjectStore. */
function fakeStore(): { store: ObjectStore; puts: { key: string; body: Buffer }[] } {
  const puts: { key: string; body: Buffer }[] = [];
  const store: ObjectStore = {
    put(key: string, body: Buffer): Promise<PutResult> {
      puts.push({ key, body });
      return Promise.resolve({ location: `file:///artifacts/${key}`, bytes: body.byteLength });
    },
  };
  return { store, puts };
}

describe('createPgDumpExporter', () => {
  it('returns a none: reference for a never-provisioned tenant (nothing to dump)', async () => {
    const dump = vi.fn();
    const { store } = fakeStore();
    const exporter = createPgDumpExporter({
      resolveConnectionUri: () => Promise.resolve(null),
      objectStore: store,
      dump,
    });
    expect(await exporter.exportTenant(tenant({ neonProjectId: null }))).toEqual({
      location: 'none:unprovisioned',
    });
    expect(dump).not.toHaveBeenCalled();
  });

  it('fails closed when no connection secret resolves', async () => {
    const { store } = fakeStore();
    const exporter = createPgDumpExporter({
      resolveConnectionUri: () => Promise.resolve(null),
      objectStore: store,
      dump: () => Promise.resolve(Buffer.from('x')),
    });
    await expect(exporter.exportTenant(tenant())).rejects.toThrow(/no connection secret/);
  });

  it('dumps, writes a timestamped per-tenant key, and returns the artifact reference', async () => {
    const { store, puts } = fakeStore();
    const body = Buffer.from('PGDMP…');
    const exporter = createPgDumpExporter({
      resolveConnectionUri: () => Promise.resolve('postgres://u:p@h/db'),
      objectStore: store,
      dump: () => Promise.resolve(body),
      now: () => new Date('2026-06-17T12:30:45.000Z'),
    });
    const result = await exporter.exportTenant(tenant());

    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toBe(
      'tenants/11111111-1111-1111-1111-111111111111/2026-06-17T12-30-45-000Z.dump',
    );
    expect(puts[0]!.body).toBe(body);
    expect(result).toEqual({
      location:
        'file:///artifacts/tenants/11111111-1111-1111-1111-111111111111/2026-06-17T12-30-45-000Z.dump',
      bytes: body.byteLength,
    });
  });

  it('uses the wall clock by default for the artifact timestamp', async () => {
    const { store, puts } = fakeStore();
    const exporter = createPgDumpExporter({
      resolveConnectionUri: () => Promise.resolve('postgres://u:p@h/db'),
      objectStore: store,
      dump: () => Promise.resolve(Buffer.from('x')),
    });
    await exporter.exportTenant(tenant());
    // Default now() → a real ISO timestamp in the key (colons/dots replaced with hyphens).
    expect(puts[0]!.key).toMatch(
      /^tenants\/11111111-1111-1111-1111-111111111111\/\d{4}-\d{2}-\d{2}T[\d-]+Z\.dump$/,
    );
  });

  it('honors a custom key prefix (trimming slashes)', async () => {
    const { store, puts } = fakeStore();
    const exporter = createPgDumpExporter({
      resolveConnectionUri: () => Promise.resolve('postgres://u:p@h/db'),
      objectStore: store,
      dump: () => Promise.resolve(Buffer.from('x')),
      keyPrefix: '/exports/',
      now: () => new Date('2026-06-17T00:00:00.000Z'),
    });
    await exporter.exportTenant(tenant());
    expect(puts[0]!.key.startsWith('exports/')).toBe(true);
  });
});

/** A controllable fake child process. */
type FakeChild = ChildProcess & {
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
  kill: ReturnType<typeof vi.fn>;
};

function fakeChild(opts: { withStreams?: boolean } = {}): FakeChild {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter | null;
    stderr: EventEmitter | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = opts.withStreams === false ? null : new EventEmitter();
  child.stderr = opts.withStreams === false ? null : new EventEmitter();
  child.kill = vi.fn();
  return child as unknown as FakeChild;
}

describe('spawnPgDump', () => {
  it('spawns pg_dump with safe args + PG* env (password off argv) and buffers stdout', async () => {
    let child!: ReturnType<typeof fakeChild>;
    let capturedArgs: readonly string[] = [];
    let capturedEnv: NodeJS.ProcessEnv = {};
    const spawnImpl = ((cmd: string, args: readonly string[], opts: { env: NodeJS.ProcessEnv }) => {
      expect(cmd).toBe('pg_dump');
      capturedArgs = args;
      capturedEnv = opts.env;
      child = fakeChild();
      return child;
    }) as unknown as typeof nodeSpawn;

    const p = spawnPgDump('postgresql://alice:s%40cret@db.example.com:5433/shop?sslmode=require', {
      spawnImpl,
    });
    child.stdout!.emit('data', Buffer.from('AB'));
    child.stdout!.emit('data', Buffer.from('CD'));
    child.emit('close', 0);

    expect((await p).toString()).toBe('ABCD');
    expect(capturedArgs).toEqual(['-Fc', '--no-password']);
    expect(capturedEnv['PGHOST']).toBe('db.example.com');
    expect(capturedEnv['PGPORT']).toBe('5433');
    expect(capturedEnv['PGUSER']).toBe('alice');
    expect(capturedEnv['PGPASSWORD']).toBe('s@cret'); // percent-decoded, env not argv
    expect(capturedEnv['PGDATABASE']).toBe('shop');
    expect(capturedEnv['PGSSLMODE']).toBe('require');
  });

  it('omits optional PG* vars when the URI lacks them', async () => {
    let child!: ReturnType<typeof fakeChild>;
    let capturedEnv: NodeJS.ProcessEnv = {};
    const spawnImpl = ((_c: string, _a: readonly string[], opts: { env: NodeJS.ProcessEnv }) => {
      capturedEnv = opts.env;
      child = fakeChild();
      return child;
    }) as unknown as typeof nodeSpawn;

    const p = spawnPgDump('postgres://host/', { spawnImpl });
    child.emit('close', 0);
    await p;
    expect(capturedEnv['PGPORT']).toBeUndefined();
    expect(capturedEnv['PGUSER']).toBeUndefined();
    expect(capturedEnv['PGPASSWORD']).toBeUndefined();
    expect(capturedEnv['PGDATABASE']).toBeUndefined();
    expect(capturedEnv['PGSSLMODE']).toBeUndefined();
  });

  it('resolves an empty buffer when the child exposes no streams', async () => {
    let child!: ReturnType<typeof fakeChild>;
    const spawnImpl = (() => {
      child = fakeChild({ withStreams: false });
      return child;
    }) as unknown as typeof nodeSpawn;
    const p = spawnPgDump('postgres://h/db', { spawnImpl });
    child.emit('close', 0);
    expect((await p).byteLength).toBe(0);
  });

  it('rejects an unsupported connection scheme (with defaults, before any spawn)', async () => {
    // No options: exercises the default spawn/timeout fallbacks; rejects before spawning anything.
    await expect(spawnPgDump('mysql://h/db')).rejects.toThrow(/unsupported connection scheme/);
  });

  it('rejects on a non-zero exit, including stderr', async () => {
    let child!: ReturnType<typeof fakeChild>;
    const spawnImpl = (() => {
      child = fakeChild();
      return child;
    }) as unknown as typeof nodeSpawn;
    const p = spawnPgDump('postgres://h/db', { spawnImpl });
    child.stderr!.emit('data', Buffer.from('connection refused'));
    child.emit('close', 1);
    await expect(p).rejects.toThrow(/pg_dump exited with code 1: connection refused/);
  });

  it('rejects when the process fails to spawn', async () => {
    let child!: ReturnType<typeof fakeChild>;
    const spawnImpl = (() => {
      child = fakeChild();
      return child;
    }) as unknown as typeof nodeSpawn;
    const p = spawnPgDump('postgres://h/db', { spawnImpl });
    child.emit('error', new Error('ENOENT pg_dump'));
    await expect(p).rejects.toThrow(/ENOENT pg_dump/);
  });

  it('kills and rejects on timeout', async () => {
    let child!: ReturnType<typeof fakeChild>;
    const spawnImpl = (() => {
      child = fakeChild();
      return child;
    }) as unknown as typeof nodeSpawn;
    const p = spawnPgDump('postgres://h/db', { spawnImpl, timeoutMs: 5 });
    await expect(p).rejects.toThrow(/timed out after 5ms/);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('settles once — late events after the first outcome are ignored', async () => {
    let child!: ReturnType<typeof fakeChild>;
    const spawnImpl = (() => {
      child = fakeChild();
      return child;
    }) as unknown as typeof nodeSpawn;
    const p = spawnPgDump('postgres://h/db', { spawnImpl });
    child.stdout!.emit('data', Buffer.from('OK'));
    child.emit('close', 0);
    const result = await p;
    // Late terminal events hit the already-settled guard and are no-ops.
    child.emit('close', 1);
    child.emit('error', new Error('late'));
    expect(result.toString()).toBe('OK');
  });

  it('uses a custom pg_dump path', async () => {
    let cmd = '';
    let child!: ReturnType<typeof fakeChild>;
    const spawnImpl = ((c: string) => {
      cmd = c;
      child = fakeChild();
      return child;
    }) as unknown as typeof nodeSpawn;
    const p = spawnPgDump('postgres://h/db', { spawnImpl, pgDumpPath: '/usr/local/bin/pg_dump' });
    child.emit('close', 0);
    await p;
    expect(cmd).toBe('/usr/local/bin/pg_dump');
  });
});
