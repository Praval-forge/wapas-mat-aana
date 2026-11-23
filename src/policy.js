// Seller "rule" requests. This app has NO custom rules engine on purpose:
// every order is scored only on its own signals (pin history, buyer history, address quality).
// A request to treat a whole group (city, state, community, name...) as blocked is refused.

const VERDICT = /\b(block|ban|blacklist|black-list|reject|deny|cancel|refuse|stop|never ship|don'?t ship|do not ship|no cod|disable cod)\b/i;
const GROUP = /\b(all|every|any|each|entire|whole)\b/i;
const ATTRIBUTE =
  /\b(from|in|of)\s+[a-z]/i; // "... from <place>", "... in <place>"
const PROTECTED =
  /\b(city|cities|town|state|region|district|area|neighbou?rhood|locality|religion|caste|community|muslims?|hindus?|christians?|sikhs?|men|women|male|female|gender|surname|name|names|language|tribe)\b/i;

export function evaluateSellerRule(text) {
  const t = String(text ?? '').trim().slice(0, 300);
  if (!t) return { accepted: false, code: 'empty', message: 'Rule text is empty.' };
  const blanket = VERDICT.test(t) && ((GROUP.test(t) && ATTRIBUTE.test(t)) || PROTECTED.test(t));
  if (blanket) {
    return {
      accepted: false,
      code: 'blanket_group_rule',
      message:
        'Refused: blanket rules that block a whole city, region or group of buyers are not supported. ' +
        'Wapas Mat Aana scores every order on its own signals (pin-code return history, that buyer\'s own ' +
        'past returns, and address quality), and a human decides on risky orders.',
    };
  }
  return {
    accepted: false,
    code: 'unsupported',
    message:
      'This prototype has no custom rules engine. Scoring uses fixed per-order signals; use Ship / Hold / Override on a specific order instead.',
  };
}

