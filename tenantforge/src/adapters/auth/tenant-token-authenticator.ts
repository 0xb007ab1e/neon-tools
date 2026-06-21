import { timingSafeEqual } from 'node:crypto';
import type {
  TenantAuthenticator,
  TenantCredential,
  TenantPrincipal,
} from '../../ports/tenant-authenticator.js';

/** Constant-time token compare (avoids token timing leaks — topic-authn-authz). */
function tokenEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Create a {@link TenantAuthenticator} that matches a presented portal token against a static
 * per-tenant credential list, in **constant time** (the default portal auth). It iterates all
 * credentials with no early return, so timing doesn't reveal which (if any) matched.
 *
 * @param credentials - The portal credentials (tenantId / token).
 * @returns A token-matching tenant authenticator.
 */
export function createTokenTenantAuthenticator(
  credentials: readonly TenantCredential[],
): TenantAuthenticator {
  return {
    authenticate(token: string): Promise<TenantPrincipal | null> {
      let principal: TenantPrincipal | null = null;
      for (const cred of credentials) {
        if (token !== '' && tokenEquals(token, cred.token)) {
          principal = { tenantId: cred.tenantId };
        }
      }
      return Promise.resolve(principal);
    },
  };
}
