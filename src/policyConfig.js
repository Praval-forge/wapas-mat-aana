// Per-brand scoring and routing policy. Defaults implement the v2 model:
// every COD order is scored on ALL signals (pin is one input, never a gate),
// and the 0-100 score maps to three tiers with different buyer messaging and
// different "buyer stays silent" outcomes. A brand tunes these via
// PUT /v1/policy (API-key auth, scope policy:manage); values are validated
// and clamped. Effective policy = DEFAULT_POLICY + the tenant's overrides
// (see tenants.js: policyFor).

export const DEFAULT_POLICY = {
  // Score bands (0-100). lowMax and mediumMax are inclusive upper bounds.
  lowMax: 29, // 0-29   -> LOW:    ship as normal, no buyer message
  mediumMax: 49, // 30-59 -> MEDIUM: "Reply YES to confirm"
  // 60-100 -> HIGH: "Pay the Rs 50 commitment fee to confirm"

  // Signal weights (points added to the score). The pin code is one input
  // among three, capped well below the buyer's own history and address.
  veryHighMin: 70,
  extremeMin: 85,
  feeHigh: 49,
  feeVeryHigh: 99,
  feeExtreme: 149,
  highValueThreshold: 2000,
  frequencyThreshold: 2,
  weights: {
    repeatReturner: 40, // 2+ past returns
    onePastReturn: 25, // exactly 1 past return
    addressBad: 20, // unusable address
    addressVague: 20, // incomplete address
    pinHigh: 30, // pin-code return rate >= 45%
    pinMedium: 15,
    loyalBuyer: 15,
    unknownPin: 10,
    shortAddress: 10,
    noHouseNumber: 5,
    noLandmark: 5,
    fakePhone: 20,
    junkName: 20,
    firstTimeBuyer: 10,
    highValue: 10,
    phoneFrequency: 15, // pin-code return rate >= 30%
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
