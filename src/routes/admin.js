// Admin console API (/admin/api): tenant and API-key management.
// Protected by the admin key (X-Admin-Key). In the public demo this is the
// documented sandbox value "demo-admin-key" (set CODGUARD_ADMIN_KEY to change
// it); every response here is tenant/key metadata, never full keys.
import express from 'express';
import { requireAdmin, apiError, adminKeyConfigured, DEMO_ADMIN_KEY } from '../auth.js';
import {
  createTenant, listTenants, getTenant, issueKey, rotateKey, revokeKey, listKeys, usageForTenant, TenantError,
} from '../tenants.js';
import { ordersThisMonth } from '../tenants.js';
import { PLANS } from '../tenants.js';

export const admin = express.Router();

admin.get('/meta', requireAdmin, (_req, res) =>
  res.json({ plans: PLANS, demo_admin: adminKeyConfigured() === DEMO_ADMIN_KEY })
);

admin.get('/tenants', requireAdmin, (_req, res) => {
  const rows = listTenants().map((t) => ({
    ...t,
    orders_this_month: ordersThisMonth(t.id),
    usage: usageForTenant(t.id),
    keys: listKeys(t.id),
  }));
  res.json({ tenants: rows });
});

admin.post('/tenants', requireAdmin, (req, res) => {
  try {
    res.status(201).json(createTenant(req.body ?? {}));
  } catch (e) {
    if (e instanceof TenantError) return apiError(res, e.status, 'tenant_error', e.message);
    throw e;
  }
});

admin.post('/tenants/:id/keys', requireAdmin, (req, res) => {
  try {
    // The full key is in this response exactly once.
    res.status(201).json(issueKey(req.params.id, req.body ?? {}));
  } catch (e) {
    if (e instanceof TenantError) return apiError(res, e.status, 'key_error', e.message);
    throw e;
  }
});

admin.post('/keys/:id/rotate', requireAdmin, (req, res) => {
  try {
    res.json(rotateKey(req.params.id)); // old revoked, new full key shown once
  } catch (e) {
    if (e instanceof TenantError) return apiError(res, e.status, 'key_error', e.message);
    throw e;
  }
});

admin.post('/keys/:id/revoke', requireAdmin, (req, res) => {
  try {
    res.json(revokeKey(req.params.id));
  } catch (e) {
    if (e instanceof TenantError) return apiError(res, e.status, 'key_error', e.message);
    throw e;
  }
});
