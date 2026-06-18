import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { createPgDataMover, spawnPgRestore } from '../../src/adapters/pg-dump/data-mover.js';

type FakeChild = ChildProcess & {
  stdin: { write: (b: Buffer) => void; end: () => void };
  stderr: EventEmitter | null;
  written: Buffer[];
};

function fakeChild(opts: { withStderr?: boolean } = {}): FakeChild {
  const written: Buffer[] = [];
  const child = new EventEmitter() as EventEmitter & {
    stdin: { write: (b: Buffer) => void; end: () => void };
    stderr: EventEmitter | null;
    written: Buffer[];
    kill: () => void;
  };
  child.written = written;
  child.stdin = { write: (b: Buffer) => written.push(b), end: () => undefined };
  child.stderr = opts.withStderr === false ? null : new EventEmitter();
  child.kill = (): void => undefined;
  return child as unknown as FakeChild;
}

describe('spawnPgRestore', () => {
  it('spawns pg_restore with safe args + PG* env (password off argv) and feeds the archive on stdin', async () => {
    const child = fakeChild();
    let captured: { cmd: string; args: string[]; env: NodeJS.ProcessEnv } | undefined;
    const spawnImpl = ((cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      captured = { cmd, args, env: opts.env };
      return child;
    }) as unknown as typeof nodeSpawn;

    const archive = Buffer.from('DUMP');
    const p = spawnPgRestore(
      'postgresql://alice:s%40cret@db.example.com:5433/shop?sslmode=require',
      archive,
      { spawnImpl },
    );
    child.emit('close', 0);
    await expect(p).resolves.toBeUndefined();

    expect(captured!.cmd).toBe('pg_restore');
    expect(captured!.args).toEqual(['--no-password', '--no-owner', '-d', 'shop']);
    expect(captured!.env['PGHOST']).toBe('db.example.com');
    expect(captured!.env['PGPORT']).toBe('5433');
    expect(captured!.env['PGUSER']).toBe('alice');
    expect(captured!.env['PGPASSWORD']).toBe('s@cret'); // decoded, never on argv
    expect(captured!.env['PGSSLMODE']).toBe('require');
    expect(Buffer.concat(child.written).toString()).toBe('DUMP');
  });

  it('omits optional PG* vars + the -d flag when the URI lacks them', async () => {
    const child = fakeChild();
    let captured: { args: string[]; env: NodeJS.ProcessEnv } | undefined;
    const spawnImpl = ((_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      captured = { args, env: opts.env };
      return child;
    }) as unknown as typeof nodeSpawn;
    const p = spawnPgRestore('postgres://host/', Buffer.from('x'), { spawnImpl });
    child.emit('close', 0);
    await p;
    expect(captured!.args).toEqual(['--no-password', '--no-owner']); // no -d (no database)
    expect(captured!.env['PGPORT']).toBeUndefined();
    expect(captured!.env['PGUSER']).toBeUndefined();
  });

  it('rejects an unsupported connection scheme before any spawn', async () => {
    await expect(spawnPgRestore('mysql://h/db', Buffer.from('x'))).rejects.toThrow(
      /unsupported connection scheme/,
    );
  });

  it('rejects on a non-zero exit, including stderr', async () => {
    const child = fakeChild();
    const spawnImpl = (() => child) as unknown as typeof nodeSpawn;
    const p = spawnPgRestore('postgres://h/db', Buffer.from('x'), { spawnImpl });
    child.stderr!.emit('data', Buffer.from('restore failed'));
    child.emit('close', 1);
    await expect(p).rejects.toThrow(/pg_restore exited with code 1: restore failed/);
  });

  it('rejects when the process fails to spawn', async () => {
    const child = fakeChild();
    const spawnImpl = (() => child) as unknown as typeof nodeSpawn;
    const p = spawnPgRestore('postgres://h/db', Buffer.from('x'), { spawnImpl });
    child.emit('error', new Error('ENOENT pg_restore'));
    await expect(p).rejects.toThrow(/ENOENT pg_restore/);
  });

  it('tolerates a child without a stderr stream', async () => {
    const child = fakeChild({ withStderr: false });
    const spawnImpl = (() => child) as unknown as typeof nodeSpawn;
    const p = spawnPgRestore('postgres://h/db', Buffer.from('x'), { spawnImpl });
    child.emit('close', 0);
    await expect(p).resolves.toBeUndefined();
  });

  it('ignores a second terminal event after settling (idempotent finish)', async () => {
    const child = fakeChild();
    const spawnImpl = (() => child) as unknown as typeof nodeSpawn;
    const p = spawnPgRestore('postgres://h/db', Buffer.from('x'), { spawnImpl });
    child.emit('close', 0); // settles (resolve)
    child.emit('error', new Error('late error')); // no-op — already settled
    await expect(p).resolves.toBeUndefined();
  });

  it('kills and rejects on timeout', async () => {
    const child = fakeChild();
    const killed = vi.spyOn(child, 'kill');
    const spawnImpl = (() => child) as unknown as typeof nodeSpawn;
    const p = spawnPgRestore('postgres://h/db', Buffer.from('x'), { spawnImpl, timeoutMs: 5 });
    await expect(p).rejects.toThrow(/timed out after 5ms/);
    expect(killed).toHaveBeenCalledWith('SIGKILL');
  });
});

describe('createPgDataMover', () => {
  it('dumps the source then restores into the target', async () => {
    const dump = vi.fn().mockResolvedValue(Buffer.from('ARCHIVE'));
    const restore = vi.fn().mockResolvedValue(undefined);
    const mover = createPgDataMover({ dump, restore });
    await mover.move({ from: 'postgres://old/db', to: 'postgres://new/db' });
    expect(dump).toHaveBeenCalledWith('postgres://old/db');
    expect(restore).toHaveBeenCalledWith('postgres://new/db', Buffer.from('ARCHIVE'));
  });

  it('uses the default pg_dump/pg_restore via injected spawn', async () => {
    const dumpChild = fakeChild();
    const restoreChild = fakeChild();
    let call = 0;
    const spawnImpl = ((cmd: string) => {
      call += 1;
      const child = cmd === 'pg_dump' ? dumpChild : restoreChild;
      return child;
    }) as unknown as typeof nodeSpawn;

    const mover = createPgDataMover({
      dumpOptions: { spawnImpl },
      restoreOptions: { spawnImpl },
    });
    const p = mover.move({ from: 'postgres://old/db', to: 'postgres://new/db' });
    // pg_dump completes first (no stdout stream → empty archive), then pg_restore.
    dumpChild.emit('close', 0);
    await new Promise((r) => setImmediate(r));
    restoreChild.emit('close', 0);
    await expect(p).resolves.toBeUndefined();
    expect(call).toBe(2);
  });
});
