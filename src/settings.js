import { getTenant, TenantError } from './tenants.js';
import { save } from './store.js';
export const DEFAULT_SETTINGS = { brand_name: 'Chhaya Threads', cost_per_return: 350, return_rate: 37.5, prevention_share: 30 };
export const settingsFor = id => ({ ...DEFAULT_SETTINGS, ...(getTenant(id)?.settings ?? {}) });
export function updateSettings(id, patch) {
  const t = getTenant(id);
  if (!t) throw new TenantError('Tenant not found',404);
  const out = settingsFor(id);
  for (const [k,v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) throw new TenantError(`Unknown setting: ${k}`);
    if (k === 'brand_name') { if (typeof v !== 'string' || !v.trim() || v.length > 80) throw new TenantError('brand_name must be 1-80 characters'); out[k] = v.trim(); }
    else { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > (k === 'cost_per_return' ? 100000 : 100)) throw new TenantError(`Invalid ${k}`); out[k] = n; }
  }
  t.settings = out; save(); return out;
}
