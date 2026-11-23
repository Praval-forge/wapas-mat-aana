// The built-in demo tenant. The public dashboard operates on this tenant and
// its well-known SANDBOX test key (documented, safe to publish: the demo is
// seeded fake data and the sandbox plan is quota-limited).
import crypto from 'node:crypto';
import { getState, save } from './store.js';
import { createTenant } from './tenants.js';

export const DEMO_TENANT_NAME = 'Demo Brand (sandbox)';
export const DEMO_API_KEY = 'wma_test_demo_000000000000000000000000sandbox';

export function ensureDemoTenant() {
  const s = getState();
  let tenant = s.tenants.find((t) => t.name === DEMO_TENANT_NAME);
  if (!tenant) tenant = createTenant({ name: DEMO_TENANT_NAME, plan: 'sandbox', note: 'Built-in demo tenant for the public dashboard.' });
  let key = s.apiKeys.find((k) => k.tenant_id === tenant.id && k.prefix === DEMO_API_KEY.slice(0, 16));
  if (!key) {
    key = {
      id: `key_${++s.counters.key}`,
      tenant_id: tenant.id,
      label: 'Demo sandbox key (published in the docs)',
      kind: 'test',
      prefix: DEMO_API_KEY.slice(0, 16),
      hash: crypto.createHash('sha256').update(DEMO_API_KEY).digest('hex'),
      scopes: ['orders:read', 'orders:write', 'orders:action', 'webhooks:manage', 'policy:manage'],
      created_at: new Date().toISOString(),
      revoked_at: null,
      last_used_at: null,
    };
    s.apiKeys.push(key);
    save();
  }
  return { tenant, key };
}
