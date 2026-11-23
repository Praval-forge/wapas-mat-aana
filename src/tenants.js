// Tenants (customer accounts) and API keys.
// Keys are shown exactly once at creation/rotation; only the SHA-256 hash is stored.
// Two kinds: wma_test_... (sandbox, clearly marked) and wma_live_... .
// Plans set rate limits, monthly order quotas and webhook caps.
import crypto from 'node:crypto';
import { getState, save } from './store.js';
import { DEFAULT_POLICY } from './policyConfig.js';

export const PLANS = {
  sandbox: { label: 'Sandbox', ordersPerMonth: 500, requestsPerMinute: 30, maxWebhooks: 1, liveKeys: false },
  growth: { label: 'Growth', ordersPerMonth: 50_000, requestsPerMinute: 120, maxWebhooks: 5, liveKeys: true },
  scale: { label: 'Scale', ordersPerMonth: 1_000_000, requestsPerMinute: 600, maxWebhooks: 25, liveKeys: true },
};

export const SCOPES = ['orders:read', 'orders:write', 'orders:action', 'webhooks:manage', 'policy:manage'];
const ALL_SCOPES = [...SCOPES];

const now = () => new Date().toISOString();
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
const hash = (key) => crypto.createHash('sha256').update(key).digest('hex');

export class TenantError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/* ---------------- tenants ---------------- */

export function createTenant({ name, plan = 'sandbox', contact_email = '', note = '' }) {
  const s = getState();
  if (!name || typeof name !== 'string' || !name.trim()) throw new TenantError('name is required');
  if (!PLANS[plan]) throw new TenantError(`plan must be one of: ${Object.keys(PLANS).join(', ')}`);
  const tenant = {
    id: `ten_${++s.counters.tenant}`,
    name: name.trim().slice(0, 80),
    plan,
    contact_email: String(contact_email ?? '').trim().slice(0, 120),
    note: String(note ?? '').trim().slice(0, 200),
    policy_overrides: {},
    created_at: now(),
  };
  s.tenants.push(tenant);
  save();
  return tenant;
}

export const getTenant = (id) => getState().tenants.find((t) => t.id === id) ?? null;
export const listTenants = () => getState().tenants.map(publicTenant);

export function publicTenant(t) {
  return {
    id: t.id,
    name: t.name,
    plan: t.plan,
    contact_email: t.contact_email,
    created_at: t.created_at,
    policy_overrides: t.policy_overrides,
  };
}

export function setTenantPolicy(tenantId, policyOverrides) {
  const t = getTenant(tenantId);
  if (!t) throw new TenantError('Tenant not found', 404);
  t.policy_overrides = policyOverrides;
  save();
  return t;
}

/** Effective policy for a tenant: defaults + their overrides. */
export function policyFor(tenantId) {
  const t = getTenant(tenantId);
  const o = t?.policy_overrides ?? {};
  return {
    ...structuredClone(DEFAULT_POLICY),
    ...o,
    weights: { ...structuredClone(DEFAULT_POLICY.weights), ...(o.weights ?? {}) },
  };
}

/* ---------------- API keys ---------------- */

function generateKey(kind) {
  return `wma_${kind}_${crypto.randomBytes(18).toString('hex')}`; // 36 hex chars
}

function publicKeyRow(k, { full = null } = {}) {
  return {
    id: k.id,
    tenant_id: k.tenant_id,
    label: k.label,
    kind: k.kind,
    prefix: k.prefix,
    scopes: k.scopes,
    created_at: k.created_at,
    revoked_at: k.revoked_at,
    last_used_at: k.last_used_at,
    ...(full ? { key: full } : {}), // only ever set at creation/rotation
  };
}

/**
 * Issue a key. Returns the public row PLUS the full key once (row.key).
 * The full key is never stored and cannot be retrieved later.
 */
export function issueKey(tenantId, { label = '', kind = 'test', scopes = ALL_SCOPES } = {}) {
  const s = getState();
  const tenant = getTenant(tenantId);
  if (!tenant) throw new TenantError('Tenant not found', 404);
  if (kind !== 'test' && kind !== 'live') throw new TenantError('kind must be "test" or "live"');
  if (kind === 'live' && !PLANS[tenant.plan].liveKeys)
    throw new TenantError(`The ${tenant.plan} plan is sandbox-only: upgrade to growth or scale for live keys`, 402);
  if (!Array.isArray(scopes) || scopes.some((x) => !ALL_SCOPES.includes(x)))
    throw new TenantError(`scopes must be a subset of: ${ALL_SCOPES.join(', ')}`);
  const full = generateKey(kind);
  const row = {
    id: `key_${++s.counters.key}`,
    tenant_id: tenantId,
    label: String(label ?? '').trim().slice(0, 80),
    kind,
    prefix: full.slice(0, 16),
    hash: hash(full),
    scopes: [...scopes],
    created_at: now(),
    revoked_at: null,
    last_used_at: null,
  };
  s.apiKeys.push(row);
  save();
  return publicKeyRow(row, { full });
}

/** Rotate: revoke the old key, issue a fresh one with the same label/kind/scopes. */
export function rotateKey(keyId) {
  const s = getState();
  const old = s.apiKeys.find((k) => k.id === keyId);
  if (!old) throw new TenantError('Key not found', 404);
  old.revoked_at = now();
  const freshKey = issueKey(old.tenant_id, { label: old.label, kind: old.kind, scopes: old.scopes });
  save();
  return { revoked: publicKeyRow(old), key: freshKey };
}

export function revokeKey(keyId) {
  const s = getState();
  const k = s.apiKeys.find((x) => x.id === keyId);
  if (!k) throw new TenantError('Key not found', 404);
  if (!k.revoked_at) {
    k.revoked_at = now();
    save();
  }
  return publicKeyRow(k);
}

export const listKeys = (tenantId = null) =>
  getState()
    .apiKeys.filter((k) => !tenantId || k.tenant_id === tenantId)
    .map((k) => publicKeyRow(k));

/** Resolve a presented key to { tenant, keyRow } or null. Constant-time on the hash. */
export function resolveKey(presented) {
  if (typeof presented !== 'string' || !presented.startsWith('wma_') && !presented.startsWith('cgk_')) return null;
  const h = hash(presented);
  const row = getState().apiKeys.find((k) => {
    const a = Buffer.from(k.hash, 'hex');
    const b = Buffer.from(h, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  if (!row || row.revoked_at) return null;
  const tenant = getTenant(row.tenant_id);
  if (!tenant) return null;
  return { tenant, keyRow: row };
}

/* ---------------- metering ---------------- */

export function meter(keyId, { order = false } = {}) {
  const s = getState();
  const mk = monthKey();
  const perKey = (s.usage[keyId] ??= {});
  const bucket = (perKey[mk] ??= { requests: 0, orders: 0 });
  bucket.requests += 1;
  if (order) bucket.orders += 1;
  const keyRow = s.apiKeys.find((k) => k.id === keyId);
  if (keyRow) keyRow.last_used_at = now();
  save();
  return bucket;
}

export function usageForKey(keyId) {
  return getState().usage[keyId] ?? {};
}

export function usageForTenant(tenantId) {
  const s = getState();
  const out = {};
  for (const k of s.apiKeys.filter((x) => x.tenant_id === tenantId)) {
    for (const [month, bucket] of Object.entries(s.usage[k.id] ?? {})) {
      const b = (out[month] ??= { requests: 0, orders: 0 });
      b.requests += bucket.requests;
      b.orders += bucket.orders;
    }
  }
  return out;
}

/** Orders ingested by this tenant in the current calendar month (quota check). */
export function ordersThisMonth(tenantId) {
  const mk = monthKey();
  return getState().orders.filter((o) => o.tenant_id === tenantId && (o.created_at ?? '').slice(0, 7) === mk).length;
}
