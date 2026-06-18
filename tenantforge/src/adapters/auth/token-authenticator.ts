import { timingSafeEqual } from 'node:crypto';
import type { Authenticator, HttpCredential, Principal } from '../../ports/authenticator.js';

/** Constant-time bearer-token compare (avoids token timing leaks — topic-authn-authz). */
function tokenEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Create an {@link Authenticator} that matches a presented token against a static per-operator
 * credential list, in **constant time** (the default control-plane auth).
 *
 * It iterates all credentials with no early return, so timing doesn't reveal which (if any) matched.
 *
 * @param credentials - The operator credentials (id / token / role).
 * @returns A token-matching authenticator.
 */
export function createTokenAuthenticator(credentials: readonly HttpCredential[]): Authenticator {
  return {
    authenticate(bearerToken: string): Promise<Principal | null> {
      let principal: Principal | null = null;
      for (const cred of credentials) {
        if (bearerToken !== '' && tokenEquals(bearerToken, cred.token)) {
          principal = {
            id: cred.id,
            role: cred.role,
            ...(cred.permissions !== undefined ? { permissions: cred.permissions } : {}),
          };
        }
      }
      return Promise.resolve(principal);
    },
  };
}
