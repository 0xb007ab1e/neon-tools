import { describe, expect, it } from 'vitest';
import { createNeonProvisioningProvider } from '../../../src/adapters/neon-api/provisioning-provider.js';

/** Capture the headers each outbound call is made with, returning a 204 (no body to parse). */
function capturingProvider(traceHeaders?: () => Record<string, string>) {
  const headers: Array<Record<string, string>> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    headers.push(init.headers as Record<string, string>);
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const provider = createNeonProvisioningProvider({
    apiKey: 'secret-key',
    orgId: 'org-1',
    fetchImpl,
    ...(traceHeaders ? { traceHeaders } : {}),
  });
  return { provider, headers };
}

describe('Neon provider trace propagation', () => {
  it('injects the supplied trace headers (e.g. W3C traceparent) on outbound calls', async () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const { provider, headers } = capturingProvider(() => ({ traceparent }));
    await provider.deleteTenantProject('proj-1');
    expect(headers[0]?.traceparent).toBe(traceparent);
    // The fixed auth/content headers are still present and not overridden.
    expect(headers[0]?.authorization).toBe('Bearer secret-key');
    expect(headers[0]?.['content-type']).toBe('application/json');
  });

  it('sends no trace header when none is supplied (outside any trace scope)', async () => {
    const { provider, headers } = capturingProvider();
    await provider.deleteTenantProject('proj-1');
    expect(headers[0]?.traceparent).toBeUndefined();
  });
});
