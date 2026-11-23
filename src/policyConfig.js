// Per-brand scoring and routing policy. Defaults implement the v2 model:
// every COD order is scored on ALL signals (pin is one input, never a gate),
// and the 0-100 score maps to a five-band ladder: LOW and MEDIUM ask nothing
// upfront (MEDIUM is a free "reply YES" confirmation); HIGH, VERY_HIGH and
// EXTREME request a refundable upfront amount that is adjusted against the
// amount due on delivery and never exceeds the order value. Every order waits
// for a human Ship/Hold/Cancel; the only automatic action is the per-brand
// (default ON) cancel of upfront-request orders after 24h of buyer silence. A brand tunes these via
// PUT /v1/policy (API-key auth, scope policy:manage); values are validated
// and clamped. Effective policy = DEFAULT_POLICY + the tenant's overrides
// (see tenants.js: policyFor).

export const DEFAULT_POLICY = {
  // Score bands (0-100). lowMax and mediumMax are inclusive upper bounds.
  lowMax: 29, // 0-29    LOW:       Rs 0, no confirmation; suggest ship
  mediumMax: 49, // 30-49 MEDIUM:    Rs 0, free "reply YES" confirmation
  veryHighMin: 70, // 50-69 HIGH:    feeHigh upfront
  extremeMin: 85, // 70-84 VERY_HIGH: feeVeryHigh; 85-100 EXTREME: feeExtreme
  feeHigh: 49,
  feeVeryHigh: 99,
  feeExtreme: 149, // EXTREME buyers may also pay fully online at FULL_ONLINE_DISCOUNT_PCT off (demo)
  highValueThreshold: 2000,
  frequencyThreshold: 2,
  // Signal weights (points added to the 0-100 score). The pin code is one input
  // among many and never a gate; city and other group attributes are never inputs.
  weights: {
    repeatReturner: 40, // 2+ past returns
    onePastReturn: 25, // exactly 1 past return
    addressBad: 20, // unusable address
    addressVague: 20, // incomplete address
    pinHigh: 30, // pin-code return rate >= 30%
    pinMedium: 15, // pin-code return rate >= 20%
    loyalBuyer: 15,
    unknownPin: 10,
    shortAddress: 10,
    noHouseNumber: 5,
    noLandmark: 5,
    fakePhone: 20,
    junkName: 20,
    firstTimeBuyer: 10,
    highValue: 10,
    phoneFrequency: 15, // frequencyThreshold+ orders from the same phone on the same IST day
  },

  // Buyer silence handling (hours since the WhatsApp message was sent).
  reminderAfterHours: 12, // send exactly one reminder, for MEDIUM and HIGH
  mediumSilentAfterHours: 24, // still silent -> HOLD, the brand decides
  highSilentAfterHours: 24, // still silent -> highSilentAction
  autoCancelSilent: true,
  highSilentAction: 'cancel', // 'cancel' (default) or 'hold'; the brand chooses
};

const CLAMPS = {
  veryHighMin: [2,99], extremeMin: [3,100],
  feeHigh:[0,10000], feeVeryHigh:[0,10000], feeExtreme:[0,10000],
  highValueThreshold:[1,1000000], frequencyThreshold:[2,100],
  lowMax: [0, 98],
  mediumMax: [1, 99],
  reminderAfterHours: [1, 72],
  mediumSilentAfterHours: [1, 168],
  highSilentAfterHours: [1, 168],
};
const WEIGHT_CLAMP = [0, 100];

export class PolicyError extends Error {
  constructor(problems) {
    super(problems.join('; '));
    this.problems = problems;
  }
}

/**
 * Validate a partial policy patch against an existing overrides object.
 * Returns the NEW overrides object (merged + clamped). Throws PolicyError
 * with a list of problems on invalid input. Unknown keys are rejected so
 * typos do not silently pass.
 */
export function validatePolicyPatch(currentOverrides, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new PolicyError(['policy must be an object']);
  }
  const problems = [];
  const next = structuredClone(currentOverrides ?? {});
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'weights') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        problems.push('weights must be an object');
        continue;
      }
      next.weights = { ...(next.weights ?? {}) };
      for (const [w, v] of Object.entries(value)) {
        if (!(w in DEFAULT_POLICY.weights)) {
          problems.push(`unknown weight "${w}" (known: ${Object.keys(DEFAULT_POLICY.weights).join(', ')})`);
          continue;
        }
        if (!Number.isFinite(v)) {
          problems.push(`weights.${w} must be a number`);
          continue;
        }
        next.weights[w] = Math.min(WEIGHT_CLAMP[1], Math.max(WEIGHT_CLAMP[0], Math.round(v)));
      }
      continue;
    }
    if (key === 'autoCancelSilent') { if(typeof value !== 'boolean') problems.push('autoCancelSilent must be boolean');else next[key]=value;continue; }
    if (key === 'highSilentAction') {
      if (value !== 'cancel' && value !== 'hold') {
        problems.push('highSilentAction must be "cancel" or "hold"');
        continue;
      }
      next.highSilentAction = value;
      continue;
    }
    if (key in CLAMPS) {
      if (!Number.isFinite(value)) {
        problems.push(`${key} must be a number`);
        continue;
      }
      next[key] = Math.min(CLAMPS[key][1], Math.max(CLAMPS[key][0], Math.round(value)));
      continue;
    }
    problems.push(
      `unknown policy field "${key}" (known: ${[...Object.keys(CLAMPS), 'weights', 'highSilentAction'].join(', ')})`
    );
  }

  // Validate the EFFECTIVE policy (defaults + overrides), not just the patch.
  const eff = { ...DEFAULT_POLICY, ...next, weights: { ...DEFAULT_POLICY.weights, ...(next.weights ?? {}) } };
  if (eff.veryHighMin <= eff.mediumMax || eff.extremeMin <= eff.veryHighMin) problems.push('Fee bands must be ordered: mediumMax < veryHighMin < extremeMin');
  if (eff.lowMax >= eff.mediumMax) problems.push(`lowMax (${eff.lowMax}) must be below mediumMax (${eff.mediumMax})`);
  if (eff.mediumSilentAfterHours < eff.reminderAfterHours)
    problems.push('mediumSilentAfterHours must be >= reminderAfterHours, otherwise the hold lands before the reminder');
  if (eff.highSilentAfterHours < eff.reminderAfterHours)
    problems.push('highSilentAfterHours must be >= reminderAfterHours, otherwise the cancel/hold lands before the reminder');
  if (problems.length) throw new PolicyError(problems);
  return next;
}

export function feeFor(score,policy=DEFAULT_POLICY) {
  if (score <= policy.mediumMax) return 0;
  return score >= policy.extremeMin ? policy.feeExtreme : score >= policy.veryHighMin ? policy.feeVeryHigh : policy.feeHigh;
}
export function bandFor(score,policy=DEFAULT_POLICY) {
  return score >= policy.extremeMin ? 'EXTREME' : score >= policy.veryHighMin ? 'VERY_HIGH' : score > policy.mediumMax ? 'HIGH' : score > policy.lowMax ? 'MEDIUM' : 'LOW';
}

/** Full-online (pay 100% now) demo option, offered to EXTREME band buyers only. */
export const FULL_ONLINE_DISCOUNT_PCT = 5;

/** Upfront amount for an order: the band fee, never more than the order value. */
export function feeForOrder(score, policy = DEFAULT_POLICY, amount = Infinity) {
  return Math.max(0, Math.min(feeFor(score, policy), Math.floor(Number(amount) || 0)));
}

export const BAND_LABELS = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', VERY_HIGH: 'Very high', EXTREME: 'Extreme' };

/** The five-band ladder rendered from the effective policy (single source for UI, buyer page and docs). */
export function ladderFor(policy = DEFAULT_POLICY) {
  return [
    { band: 'LOW', label: BAND_LABELS.LOW, min: 0, max: policy.lowMax, fee_rs: 0, ask: 'No confirmation needed' },
    { band: 'MEDIUM', label: BAND_LABELS.MEDIUM, min: policy.lowMax + 1, max: policy.mediumMax, fee_rs: 0, ask: 'Free confirmation: reply YES' },
    { band: 'HIGH', label: BAND_LABELS.HIGH, min: policy.mediumMax + 1, max: policy.veryHighMin - 1, fee_rs: policy.feeHigh, ask: `Pay ₹${policy.feeHigh} upfront` },
    { band: 'VERY_HIGH', label: BAND_LABELS.VERY_HIGH, min: policy.veryHighMin, max: policy.extremeMin - 1, fee_rs: policy.feeVeryHigh, ask: `Pay ₹${policy.feeVeryHigh} upfront` },
    { band: 'EXTREME', label: BAND_LABELS.EXTREME, min: policy.extremeMin, max: 100, fee_rs: policy.feeExtreme, ask: `Pay ₹${policy.feeExtreme} upfront or full online at ${FULL_ONLINE_DISCOUNT_PCT}% off` },
  ];
}
