# Wapas Mat Aana

An API-first COD return-risk prototype with an operator console, a test storefront and buyer pages. It is inspired by the team's Wapas Mat Aana demo and backed by scoped API keys, per-brand policies, persistence, signed webhooks and tests.

> **Public shared demo.** The hosted dashboard, storefront, buyer pages and demo routes operate on one shared sandbox tenant with **synthetic data**. Anyone with the URL can see and change demo orders. Use fake data only. No real purchase, payment, WhatsApp message or Shopify connection happens anywhere in this app.

## Run

Node 20.12+ required. Run `npm ci`, `npm test` and `npm start`, then open http://localhost:3000.

| Page | Path |
|---|---|
| Operator console | `/` |
| Test storefront | `/store` |
| Buyer page | `/buyer/<token>` |
| API docs | `/docs` |
| OpenAPI spec | `/v1/openapi.json` |
| Health check | `/v1/health` |

No API key or paid service is needed. Copy `.env.example` only for private configuration. Never commit `.env`, real customer data or credentials.

## Decisions are human-final

Every order starts `PENDING_REVIEW`, including LOW and prepaid orders. The tool supplies `suggested_action`, not a final decision.

- The seller manually chooses **Ship / Hold / Cancel**, may override with a note, and may **Undo**. Undo clears `decision`, `decision_by` and `decided_at`, returns the order to `PENDING_REVIEW`, is audited, and emits `order.decision_undone`. An undo never causes an automatic decision.
- Buyer replies are evidence only and never ship, hold or cancel an order. This covers confirm, address fixed, simulated payment, wrong address, cancel request and no reply.
- A mistaken reply can be cleared by the seller. This is audited and refused once a payment is recorded.
- Bulk actions and keyboard shortcuts are explicit human actions. The shortcuts are S, H, C and U, plus the arrow keys.

**The one automatic exception (enabled by default, per brand):** an order asked to pay upfront is cancelled after 24 hours of buyer silence. A recorded `no_reply` counts as silence. Any human action prevents it: a decision, an override, an undo or a reply clear. So does any real buyer reply, including a payment. Brands can turn off `autoCancelSilent` or set `highSilentAction: hold`. Every automatic cancellation is marked `decision_by: system` and emits `order.auto_cancelled`. The 24h clock starts when the upfront amount is first requested and restarts if that amount changes. The background sweep also generates one mock reminder after 12 hours.

## Fee ladder (five bands)

| Score | Band | Pay now | Buyer request |
|---|---|---|---|
| 0–29 | Low | ₹0 | No confirmation; suggest ship |
| 30–49 | Medium | ₹0 | Free confirmation: reply YES or confirm on the buyer page |
| 50–69 | High | ₹49 | Upfront, adjusted against the amount due on delivery |
| 70–84 | Very high | ₹99 | Upfront, adjusted against delivery |
| 85–100 | Extreme | ₹149 | Upfront, or demo full online payment at 5% off |

- **Configurable:** amounts and band cutoffs are set per brand with `PUT /v1/policy` (or Settings in the console). The ladder is always visible on the dashboard and is rendered from the effective policy.
- **On every order:** the score, named band, pay-now amount and balance at delivery are shown, and the order's band is highlighted in the ladder.
- **Capped:** the upfront amount never exceeds the order value.
- **Re-scoring:** changing fees, bands, weights or the brand name re-scores the brand's existing orders from cached evidence (no new LLM calls) and re-renders their messages. A fee is frozen once a payment is recorded.

## Explainable scoring

All signals combine additively, clamped to 0–100. The pin code is one input, never a gate.

- Two or more past returns +40; one return +25; loyal buyer (3+ orders, no returns) −15.
- Pin return rate 30%+ adds 30, 20%+ adds 15, unknown adds 10. The data is illustrative.
- Short address (<25 characters) +10; no number +5; no landmark or locality marker +5.
- Invalid or repetitive phone +20; name verification flag +20.
- Two or more orders from the same phone on the same IST calendar day +15; value over ₹2,000 +10; first-time buyer +10.

A new order from the same phone re-scores that tenant's earlier orders from the same IST day:
- It uses their cached evidence, with no extra LLM calls.
- Only real score changes are audited, and decisions are never overwritten.
- Other tenants and other days are never touched.

City, region, ethnicity and community are never score inputs. Blanket group-ban requests are refused (422). Phone and name heuristics are explainable demo flags, not proof of fraud. They can misclassify real people and should be evaluated before real use. A human reviews the evidence.

Prepaid orders bypass COD scoring and the address check. Imported history overrides demo phone history.

**The address LLM check:** when privately configured, it receives only the address text and returns a strict enum plus an explanation. Without a key it uses a labelled rule-based fallback. It runs once per new order, and once more only when a buyer submits a corrected address. Seed and reset data use rule-based evidence, so a public reset never makes paid calls.

## Test storefront (`/store`)

Header link: **Open test store**. It offers nine clothing products priced ₹599–₹2,999, a city/pin choice, first and last name, phone, address, and COD or prepaid. Safe, risky and fake-looking sample fills use synthetic phone numbers only.

The store posts a Shopify-shaped `orders/create` payload to the demo simulator below. It then shows the order ID, score, band, pay-now amount, balance at delivery and the ladder with the order's band highlighted, with links to the dashboard and the buyer page.

The page is labelled throughout as a shared sandbox with fake data only and no real purchase.

## Buyer pages (`/buyer/<token>`)

Each order gets a 192-bit random token (24 random bytes, base64url), persisted with the order.
- **Bearer link:** the link is a bearer capability. Anyone holding it can view the narrow buyer page and record buyer evidence for that one order.
- **What the buyer sees:** brand, product, value, address, risk score (/100) beside the named band, pay-now amount, balance at delivery, the ladder and the requested action. They never see tenant IDs, scores, reasons, events, phone or decisions, and no order lists are exposed.
- **What the buyer can do:** confirm; fix the address, which re-scores and is audited but keeps any human decision (max 3 corrections); or make a simulated payment.
- **Edge cases:** an invalid token returns 404, and cancelled orders are read-only (409 on writes).
- **Headers:** responses send `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

**Simulated payments.** The payment sheet offers a choice of simulated UPI apps plus Cancel and Pay buttons, and is labelled DEMO / no money collected on the page, the sheet and the success view.
- **Upfront:** the band fee, adjusted against the delivery amount.
- **Full online:** 5% off, offered for the EXTREME band only. The server rejects it for other bands.
- **Records:** the backend stores the payment type, amount, discount and balance, marked `simulated: true`. A repeat payment returns the recorded payment instead of recording a second one.
- **Messaging:** success messages say the seller still reviews the order. They never promise shipment.
- **After a payment is recorded,** nothing asks for payment again. The buyer page shows "Amount paid (demo)", "Due now ₹0", the balance at delivery and the original upfront request. The dashboard shows "paid (demo) · due now ₹0". `pay_now_rs` becomes 0 and `paid_rs` holds the recorded amount. The buyer message acknowledges the payment, and no reminder is generated.

**Message links.** Messages and reminders link to the real buyer URL built from a trusted base: `PUBLIC_BASE_URL`, then `RENDER_EXTERNAL_URL`, then the request origin (local development). The full-online option is mentioned only for EXTREME orders. The dashboard shows **Open buyer page** beside the manual **Send on WhatsApp** link. Nothing is ever sent automatically.

## API

Send `X-API-Key`. The published sandbox key is `wma_test_demo_000000000000000000000000sandbox`.

| Method/path | Purpose |
|---|---|
| POST /v1/orders | Validate, score, store and suggest. `external_id` / `Idempotency-Key` prevent duplicates. Returns `buyer_path`/`buyer_url` to the owning tenant |
| POST /v1/orders/score | Stateless preview |
| GET /v1/orders[/:id] | Tenant-isolated queue/detail |
| POST /v1/orders/:id/buyer-reply | confirm, paid, cancel, no_reply, wrong_address, address_fixed, or clear. Evidence only |
| POST /v1/orders/:id/actions | action ship/hold/cancel/undo, or override with `to` + required note |
| GET /v1/orders/:id/suggestion | Suggested action only |
| GET/PUT /v1/policy | Validated scoring/fees/timing policy; re-scores existing orders |
| GET/PUT /v1/settings | Brand name and savings assumptions; re-renders messages |
| POST/GET/DELETE /v1/webhooks[/:id] | Signed event subscriptions (https only; private/loopback destinations refused) |
| GET /v1/webhooks-deliveries | Delivery audit |
| GET /v1/usage | Per-key metering and tenant plan limits |

Scopes are `orders:read`, `orders:write`, `orders:action`, `policy:manage` and `webhooks:manage`. Keys are SHA-256 hashed, shown once, rotatable and revocable. New keys use `wma_test_`/`wma_live_`; legacy `cgk_` keys remain accepted. Legacy `CODGUARD_*` environment variables and `X-CODGuard-*` signature headers are kept for compatibility.

**Signed outbound events:** `order.scored`, `order.rescored`, `order.reply_received`, `order.reply_cleared`, `order.review_required`, `order.reminded`, `order.status_changed`, `order.overridden`, `order.decision_undone` and `order.auto_cancelled`. Payloads carry `decision`, `decision_by` (`human`/`system`), `suggested_action`, band, fee, pay now, balance, simulated payment and the latest audit event. Verify `X-CODGuard-Signature` as `sha256=<HMAC-SHA256(raw body, webhook secret)>`. Delivery retries once, never follows redirects, and records results.

**Plans** are prototype limits, not paid subscriptions:

| Plan | Orders/month | Requests/min | Webhooks |
|---|---|---|---|
| Sandbox | 500 | 30 | 1 |
| Growth | 50,000 | 120 | 5 |
| Scale | 1,000,000 | 600 | 25 |

Billing is not connected.

### Demo-only routes (unauthenticated, shared sandbox tenant)

| Method/path | Purpose |
|---|---|
| GET /api/buyer/:token, POST .../confirm, .../address, .../pay | Buyer page API (bearer token, narrow view) |
| POST /api/webhooks/shopify/orders-create | **Simulator** for a Shopify-shaped orders/create payload |
| POST /api/import | CSV import (append / replace) |
| POST /api/demo/bulk, /api/demo/advance, /api/reset | Explicit demo actions |

**`/api/webhooks/shopify/orders-create` is a simulator, not a real Shopify webhook.** It does no HMAC verification, has no Shopify app and authenticates no shop. It feeds only the public demo tenant. Real integrations use the authenticated `/v1` API with a tenant key.

## Console

The console keeps the black-header operator workspace:
- **Overview:** five KPIs and the always-visible fee ladder.
- **Queue:** six queue views with band-coloured score circles; every row shows band, pay-now amount and value.
- **Order detail:**
  - the order's score, band, pay now and balance at delivery;
  - reason cards and the buyer message preview, with copy, manual WhatsApp link and **Open buyer page**;
  - reply simulation and reply clear;
  - manual decisions with Undo;
  - a visible timeline with source and placement data.
- **Live refresh:** every 15s while the tab is visible. It pauses when hidden, never overlaps requests, keeps selection, filter, focus and scroll, and toasts genuinely new orders.
- **Order data:** a read-only view of the synthetic dataset (history, same-phone counts, pin evidence, score, band, amounts) with **Export CSV**. The export uses the import column format, so it can be re-imported.

**KPIs.** "Simulated paid upfront" totals simulated payments and is labelled "demo, not revenue". The savings figure is an estimate from settings, not a measured result: risky COD count × assumed return rate × prevention share × cost per return × 30. The defaults are 37.5%, 30% and ₹350.

**Reply simulation** skips orders already replied to or decided. It uses a deterministic mix of paid, confirm, address fixed and no reply; "paid" becomes "confirm" for orders with no fee.

**CSV import.** Columns are `order_id,name,phone,address,city,pincode,order_value,payment_mode,past_orders,past_rto_count,orders_same_phone_today`, up to 100 rows. You can drag and drop or choose a file, and download or copy a sample.
- **Append** imports valid rows and lists server row errors; repeated order IDs replay.
- **Replace** is demo-tenant-only and explicit. It asks for confirmation, validates every row (and duplicate IDs) first, and deletes nothing if any row is invalid.

**Reset** restores 40 synthetic orders: 34 COD and 6 prepaid, covering all five bands, varied history, same-phone examples and a fake-looking order. `CG-1001` to `CG-1005` keep the original five demo cases. No real personal data is included.

## Admin and limits

`/admin/api` and the console manage tenants and keys with `X-Admin-Key`. The public demo uses the documented `demo-admin-key`. Before real use:
- set `CODGUARD_ADMIN_KEY` privately;
- replace the public dashboard with authenticated seller accounts;
- remove the demo mutation, storefront, simulator and buyer-simulation routes;
- set `PUBLIC_BASE_URL`.

### Demo limitations and risks

- **Public, shared, unauthenticated demo.** Anyone can view and change the demo tenant's orders, settings and policy. Anyone can reset them or replace them by CSV.
- **Buyer links are bearer tokens with no expiry.** They appear in the public dashboard, messages and API responses for the demo tenant. Anyone holding a link can confirm, edit the address or record a simulated payment for that order. Never put real buyers or real addresses in the demo.
- **Simulated money only.** No payment provider, UPI app or bank is contacted. "Paid" is a record, not a verified transaction, and the totals are not revenue.
- **Ephemeral storage on the free Render instance.** Persistence is an atomic JSON file (`CODGUARD_DATA_FILE`), which free instances lose on redeploy or restart. Free instances also sleep and cold-start slowly. No durability guarantee is made.
- **Single process.** Idempotency, rate limits (default 30 requests/min per IP on demo routes, `CODGUARD_DEMO_RATE_LIMIT`) and the silence sweep are in-memory and single-process.
- **Before customer traffic:** use managed Postgres with uniqueness constraints, a job queue, distributed rate limits, durable webhook retries, real authentication, signed and expiring buyer links, retention and privacy controls, provider verification and monitoring.

No automatic WhatsApp provider, real payments, n8n workflow, billing or paid service is enabled. WhatsApp opens a prefilled chat that a person must review and send. No real platform integration with Shopify, Swiggy, Zomato or Amazon is claimed.

MIT license, see LICENSE.
