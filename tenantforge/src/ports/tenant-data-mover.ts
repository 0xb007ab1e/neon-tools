/**
 * Port: copy a tenant's data from one database to another — the data-movement half of re-homing
 * (#5) and the restore half of backup/restore (#6). Implementations move bytes (e.g. `pg_dump` piped
 * to `pg_restore`) and never log the connection URIs (they are secrets — master §5).
 */
export interface TenantDataMover {
  /**
   * Copy all data from the `from` database into the `to` database. Both are connection URIs
   * (secrets). Must complete fully or throw — a partial copy must surface as a failure so the caller
   * can fail closed (the re-home engine deletes the freshly-created target and keeps the source).
   *
   * @param input - The source (`from`) and destination (`to`) connection URIs.
   */
  move(input: { from: string; to: string }): Promise<void>;
}
