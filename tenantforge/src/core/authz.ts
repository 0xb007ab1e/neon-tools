/** Control-plane operator roles. Each expands to a fixed set of {@link Permission}s. */
export const ROLES = ['admin', 'operator', 'readonly'] as const;
/** A control-plane role. */
export type Role = (typeof ROLES)[number];

/** Fine-grained capabilities, one per control-plane operation. */
export const PERMISSIONS = [
  'tenant:read', // list + get
  'tenant:provision', // create a tenant
  'tenant:suspend', // suspend + resume (reversible lifecycle)
  'tenant:offboard', // archive (reversible until purge)
  'tenant:purge', // IRREVERSIBLE hard-delete
] as const;
/** A control-plane permission. */
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Default permission set per role. `admin` keeps every capability (backward-compatible); `operator`
 * can run the full reversible lifecycle but **not** the irreversible purge; `readonly` may only read.
 */
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
  operator: ['tenant:read', 'tenant:provision', 'tenant:suspend', 'tenant:offboard'],
  readonly: ['tenant:read'],
};

/** An authorization grant: a role, optionally narrowed to an explicit permission set. */
export interface Grant {
  /** The principal's role. */
  role: Role;
  /** Explicit permissions; when present these are authoritative (the role default is ignored). */
  permissions?: readonly Permission[];
}

/**
 * Resolve the effective permission set for a grant: an explicit `permissions` list wins (so an
 * admin can be scoped *down*), otherwise the role's defaults. Unknown role → empty (deny by default).
 *
 * @param grant - The role and optional explicit permissions.
 * @returns The set of permissions the grant holds.
 */
export function permissionsFor(grant: Grant): ReadonlySet<Permission> {
  return new Set(grant.permissions ?? ROLE_PERMISSIONS[grant.role] ?? []);
}

/**
 * Authorization decision: does the grant hold `permission`? Deny by default.
 *
 * @param grant - The role and optional explicit permissions.
 * @param permission - The permission the operation requires.
 * @returns `true` iff the grant holds the permission.
 */
export function can(grant: Grant, permission: Permission): boolean {
  return permissionsFor(grant).has(permission);
}

/**
 * Type guard for a valid {@link Role} (for validating config / token claims at the boundary).
 *
 * @param value - The candidate role.
 * @returns `true` iff `value` is a known role.
 */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * Type guard for a valid {@link Permission} (for validating config / token claims at the boundary).
 *
 * @param value - The candidate permission.
 * @returns `true` iff `value` is a known permission.
 */
export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}
