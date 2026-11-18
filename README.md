# COD Return Guard

A prototype for Indian D2C Shopify sellers. About 37.5% of cash-on-delivery (COD) orders are returned, against roughly 5.3% of prepaid orders, and each return costs about Rs 350 on a Rs 1,200 order. COD Return Guard scores every COD order **before it ships**. It asks risky buyers to confirm or pay a small Rs 50 commitment fee, and it leaves the final decision on risky orders to a human.

## What it does

1. A new COD order arrives (simulated by the demo order form and 5 seed orders).
2. It checks the order's pin code against a return-rate table and the buyer's own past returns / past orders.
3. It reads the free-text delivery address and rates it `clear`, `vague` or `bad`. This is the only LLM call.
4. It combines the three signals into a **LOW / MEDIUM / HIGH** risk score.
5. For MEDIUM and HIGH orders it writes a WhatsApp message asking the buyer to confirm or pay Rs 50. The message is only displayed in the UI (mock send).
6. It ships or holds the order:
   - **LOW** ships automatically.
   - **MEDIUM** waits for the buyer. A confirm or the Rs 50 fee ships it. No reply or "cancel" sends it to **HOLD**.
   - **HIGH** goes straight to **HOLD**, and stays there even if the buyer confirms.
   - **Nothing is ever auto-cancelled.** The seller can Ship, Hold or Override any decision (an override needs a written note and is kept in the audit log), and sees the reasons behind every score.

## Architecture: plain code plus exactly one LLM call

```
order ─► [1] pin-code risk ───────────┐  plain code  (src/checks.js, lookup table in src/data.js)
      ─► [2] buyer's past returns ────┤  plain code
      ─► [3] address quality ─────────┤  THE ONE LLM CALL: claude-haiku-4-5 (src/addressLLM.js)
                                      ▼
      ─► [4] risk score rules ──────── plain code  (src/checks.js: scoreOrder)
      ─► [5] WhatsApp message text ─── plain code  (src/whatsapp.js)
      ─► [6] ship / hold workflow ──── plain code  (src/orders.js), seller can override
```

**The LLM call (step 3).**
- **Model:** `claude-haiku-4-5`, through the official `@anthropic-ai/sdk`.
- **Input:** only the address text. The buyer's name, phone and order value are never sent.
- **Output shape:** the call uses **tool use** with `strict: true` and a forced `tool_choice`. The model must return `{ address_quality: "clear" | "vague" | "bad", reason: "<one line>" }`. The result is checked again in code before it is used.
- **Prompt injection:** the address is treated as untrusted data, and the output can only be one of three enum values.
- **Cost and limits:** `max_tokens` is 300, the timeout is 15 s, and there is one SDK retry. The app makes exactly one call per order (`npm test` asserts this). The write endpoints also have a small per-IP rate limit.

**Risk rules (step 4, first match wins).** Inputs: pin risk, past returns, address quality.

| Rule | Condition | Result |
|---|---|---|
| R1 | 2 or more past returns | HIGH |
| R2 | address is `bad` | HIGH |
| R3 | address is `vague` | HIGH |
| R4 | high-return pin and at least 1 past return | HIGH |
| R5 | `clear` address but high-return pin | MEDIUM |
| R6 | 1 or more past returns with an elevated ratio (25% or more) or a medium pin | MEDIUM |
| R7 | full address, safe pin, no meaningful return history | LOW |

Pin thresholds: a return rate of 45% or more is *high*, 30% or more is *medium*, and anything lower is *low*. A pin with fewer than 30 orders, or one missing from the table, is *unknown* and treated neutrally.

**Fairness guard: no blanket rules.** Scoring takes only the three per-order signals above. City, state and buyer name are not inputs to the scorer. A request such as "block all buyers from Jaipur" is **refused** by `POST /api/seller-rules`, which returns HTTP 422. The app has no custom rules engine at all. Seed order 5 demonstrates this: the seller asks for a city-wide block, the request is refused and logged, and the order is scored on its own signals (LOW, ships). `npm test` checks that changing only the city or name never changes a score.

## Run locally

Requires Node.js 20.12 or newer.

```bash
npm install
npm start          # http://localhost:3000
```

```bash
npm test           # seed orders + invariants + LLM request/response path (no API key needed)
```

### Where to put `ANTHROPIC_API_KEY`

Either export it in your shell or put it in a git-ignored `.env` file:

```bash
cp .env.example .env
# edit .env and set ANTHROPIC_API_KEY=sk-ant-...
```

The key is read only from `process.env.ANTHROPIC_API_KEY` (the server loads `.env` at startup). It is never hardcoded, and `.env` is in `.gitignore`.

### Demo mode (no key)

If `ANTHROPIC_API_KEY` is missing, the app **runs fully in demo mode** and makes no network calls. Step 3 uses a rule-based address check instead of the LLM: it looks at length, a house or flat number, street or locality keywords, and landmark words. The same fallback is used if the API call fails or returns an unusable answer, and the UI labels the step "rule-based fallback" and shows why. The badge in the header shows which mode is active.

## API

| Method and path | Purpose |
|---|---|
| `POST /api/score` | Score an order without saving it. Body: `buyer_name, phone, pin, address` (optional `city, product, amount`). |
| `POST /api/orders` | Create, score and route an order. |
| `GET /api/orders`, `GET /api/orders/:id` | Queue and detail, including every step's output. |
| `POST /api/orders/:id/action` | `{action: "ship" \| "hold"}` or `{action: "override", to: "ship" \| "hold" \| "cancel", note}`. |
| `POST /api/orders/:id/reply` | Simulate the buyer: `{reply: "confirm" \| "paid" \| "cancel" \| "no_reply"}`. |
| `POST /api/seller-rules` | Submit a seller rule. Blanket group rules are refused (422). |
| `POST /api/reset` | Re-seed the 5 demo orders. |

```bash
curl -s localhost:3000/api/score -H 'content-type: application/json' \
  -d '{"buyer_name":"Sneha Reddy","phone":"9810000002","pin":"500081","address":"Near temple, Hyd"}'
```

## Seed orders

| Order | Case | Expected |
|---|---|---|
| CG-1001 | full address, safe pin, no returns | LOW, ships |
| CG-1002 | `"Near temple, Hyd"` (vague) | HIGH, hold |
| CG-1003 | buyer with 2 past returns | HIGH, hold |
| CG-1004 | good address, high-return pin | MEDIUM, confirm only |
| CG-1005 | seller asks to "block all buyers from Jaipur" | request refused, scored on its own signals (LOW) |

## Prototype limits

- Orders live in memory and reset on restart. Pin and buyer data are illustrative, in `src/data.js`.
- The WhatsApp send and the Rs 50 payment link are mocks.
- There is no Shopify integration yet. A real version would take orders from a Shopify webhook, build the pin and buyer tables from the seller's own return history, and add auth.
- With a real API key the `claude-haiku-4-5` call is covered only by a local mock server in `npm test`. Check the quality of its address ratings on your own addresses.
