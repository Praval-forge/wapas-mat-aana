// Auth, scopes, per-key rate limiting and plan quotas for the platform API.
//
// - Customers authenticate with an API key in the X-API-Key header.
//   Keys are stored hashed; see tenants.js. Test keys (wma_test_) are sandbox
//   only and marked as such in responses.
// - The admin console uses a separate admin key (CODGUARD_ADMIN_KEY env; a
//   documented demo admin key exists for the public demo, clearly sandbox).
// - Rate limits and monthly order quotas come from the tenant's plan.
import { resolveKey, meter, ordersThisMonth, PLANS } from './tenants.js';

export const DEMO_ADMIN_KEY = 'demo-admin-key'; // documented sandbox value, not a secret

export function adminKeyConfigured() {
  return process.env.CODGUARD_ADMIN_KEY ?? DEMO_ADMIN_KEY;
}

export function apiError(res, status, code, message, details) {
  return res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
}

// Per-key sliding-window rate limiter (single instance; move to Redis for a fleet).
const windows = new Map();
function rateLimitOk(keyId, perMinute) {
  const t = Date.now();
  const recent = (windows.get(keyId) ?? []).filter((x) => t - x < 60_000);
  if (recent.length >= perMinute) {
    windows.set(keyId, recent);
    return false;
  }
  recent.push(t);
  windows.set(keyId, recent);
  return true;
}

/**
 * Authenticate a /v1 request. On success sets req.tenant, req.keyRow,
 * req.authKind ('test' | 'live') and meters the request.
 */
export function requireKey(...scopes) {
  return (req, res, next) => {
    const presented = req.get('X-API-Key');
    if (!presented) return apiError(res, 401, 'missing_api_key', 'Send your API key in the X-API-Key header.');
    const resolved = resolveKey(presented);
    if (!resolved) return apiError(res, 401, 'invalid_api_key', 'This API key is invalid or revoked.');
    const { tenant, keyRow } = resolved;
    const missing = scopes.filter((s) => !keyRow.scopes.includes(s));
    if (missing.length)
      return apiError(res, 403, 'insufficient_scope', `This key lacks scope(s): ${missing.join(', ')}.`, { required: scopes });
    const plan = PLANS[tenant.plan];
    if (!rateLimitOk(keyRow.id, plan.requestsPerMinute))
      return apiError(res, 429, 'rate_limited', `Plan limit: ${plan.requestsPerMinute} requests/minute. Slow down or upgrade.`);
    meter(keyRow.id);
    req.tenant = tenant;
    req.keyRow = keyRow;
    req.authKind = keyRow.kind;
    res.set('X-CODGuard-Key-Kind', keyRow.kind);
    next();
  };
}

/** Enforce the plan's monthly order quota before ingesting a new order. */
export function enforceOrderQuota(req, res, next) {
  const plan = PLANS[req.tenant.plan];
  const used = ordersThisMonth(req.tenant.id);
  if (used >= plan.ordersPerMonth)
    return apiError(res, 429, 'quota_exceeded', `Monthly order quota reached (${plan.ordersPerMonth} on the ${req.tenant.plan} plan). Upgrade to ingest more.`, {
      limit: plan.ordersPerMonth,
      used,
    });
  next();
}

export function requireAdmin(req, res, next) {
  const presented = req.get('X-Admin-Key');
  if (!presented) return apiError(res, 401, 'missing_admin_key', 'Send the admin key in the X-Admin-Key header.');
  if (presented !== adminKeyConfigured()) return apiError(res, 401, 'invalid_admin_key', 'Invalid admin key.');
  next();
}

/** Test helper: clear rate-limit windows. */
export function resetRateLimits() {
  windows.clear();
}
