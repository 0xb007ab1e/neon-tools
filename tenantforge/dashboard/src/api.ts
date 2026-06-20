/** The compliance report shape returned by GET /dashboard/api/compliance (mirrors core ComplianceReport). */
export interface ComplianceReport {
  generatedAt: string;
  inventory: { total: number; byStatus: Record<string, number> };
  isolation: {
    compliant: boolean;
    missingProject: string[];
    sharedProjects: { neonProjectId: string; tenantIds: string[] }[];
  };
  residency: {
    compliant: boolean;
    allowedRegions: string[];
    byJurisdiction: Record<string, number>;
    violations: { tenantId: string; region: string; reason: string }[];
  };
}

/** The authenticated operator. */
export interface Session {
  id: string;
  role: string;
}

const BASE = '/dashboard/api';

/** Current session, or null when not authenticated. */
export async function fetchSession(): Promise<Session | null> {
  const res = await fetch(`${BASE}/session`, { credentials: 'include' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error('Could not check session');
  return (await res.json()) as Session;
}

/** Exchange an operator token for a session cookie. Throws on an invalid token. */
export async function login(token: string): Promise<Session> {
  const res = await fetch(`${BASE}/session`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (res.status === 401) throw new Error('Invalid operator token');
  if (!res.ok) throw new Error('Login failed');
  return (await res.json()) as Session;
}

/** Clear the session. */
export async function logout(): Promise<void> {
  await fetch(`${BASE}/session`, { method: 'DELETE', credentials: 'include' });
}

/** Load the compliance report panel data. */
export async function fetchCompliance(): Promise<{ report: ComplianceReport; digest: string }> {
  const res = await fetch(`${BASE}/compliance`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load the compliance report');
  return (await res.json()) as { report: ComplianceReport; digest: string };
}
