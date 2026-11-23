// Persistence: a zero-dependency JSON-file store with atomic writes.
// Data survives restarts (fixes the v1 "everything resets" problem).
// Swap this module for Postgres before real sellers use it; every caller
// goes through these functions, so the swap is contained here.
import fs from 'node:fs';
import path from 'node:path';

const DATA_FILE = process.env.CODGUARD_DATA_FILE ?? path.join(process.cwd(), 'data', 'codguard.json');
const MEMORY_ONLY = DATA_FILE === ':memory:';

const fresh = () => ({
  tenants: [], // customer accounts (brands / platforms)
  apiKeys: [], // hashed API keys, one row per key
  orders: [], // order objects (see orders.js), each tagged with tenant_id
  refusedRules: [],
  webhooks: [], // registered outbound webhooks (per tenant)
  deliveries: [], // webhook delivery log (capped)
  usage: {}, // per-key per-month metering: { keyId: { 'YYYY-MM': { requests, orders } } }
  counters: { order: 1000, webhook: 0, event: 0, tenant: 0, key: 0 },
});

let state = fresh();
let loaded = false;
let saveTimer = null;

export function load() {
  if (loaded) return;
  loaded = true;
  if (MEMORY_ONLY) return;
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    state = { ...fresh(), ...parsed, counters: { ...fresh().counters, ...(parsed.counters ?? {}) } };
  } catch {
    // First run or unreadable file: start fresh.
  }
}

export function getState() {
  load();
  return state;
}

function persistSync() {
  if (MEMORY_ONLY) return;
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, DATA_FILE); // atomic on POSIX
  } catch (e) {
    console.warn(`[store] could not persist to ${DATA_FILE}: ${e.message}`);
  }
}

/** Debounced persist for normal request traffic. */
export function save() {
  if (MEMORY_ONLY) return;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistSync();
  }, 50);
  saveTimer.unref?.();
}

/** Immediate persist (tests, shutdown, sweep). */
export function saveNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  persistSync();
}

/** Test helper: drop everything and reload from disk next access. */
export function resetForTests() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  state = fresh();
  loaded = false;
}

export const STORE_LOCATION = MEMORY_ONLY ? ':memory:' : DATA_FILE;
