# Wapas Mat Aana

An API-first COD return-risk prototype with an operator console. Inspired by the team's Wapas Mat Aana demo, backed by scoped API keys, per-brand policies, persistence, signed webhooks and tests.

## Run

Node 20.12+ required. `npm ci`, `npm test`, `npm start`, then open http://localhost:3000. API docs: `/docs`; spec: `/v1/openapi.json`; health: `/v1/health`.

No API key or paid service is needed to run the demo. Copy `.env.example` only for private configuration. Never commit `.env`, real customer data or credentials.

## Decisions

Every order starts `PENDING_REVIEW`, including LOW and prepaid. The tool supplies `suggested_action`, not a final decision. The seller can manually **Ship / Hold / Cancel**, change their mind, or explicitly accept suggestions in bulk. Each action records `decision`, `decision_by`, `decided_at` and audit events.

**One automatic exception, enabled by default:** an order asked to pay upfront is cancelled after 24 hours of buyer silence. A prior human decision or any recorded reply prevents this. Brands can disable `autoCancelSilent` or set `highSilentAction: hold` (suggest hold only). Every automatic cancellation is marked `decision_by: system`, includes a reason and emits `order.auto_cancelled`. No automatic shipping or holding occurs. The background sweep generates one mock reminder after 12 hours.

## Fee ladder

| Score | Band | Buyer request |
|---|---|---|
| 0–29 | Low | No confirmation, suggest ship |
| 30–49 | Medium | Reply YES |
| 50–69 | High | ₹49 upfront |
| 70–84 | Very high | ₹99 upfront |
| 85–100 | Extreme | ₹149 upfront |

Amounts and band cutoffs are per-brand configurable with `PUT /v1/policy`. Fees are adjusted against the order total. Payment URLs are placeholders, not real collection links. Recorded Paid is a simulation, not verification of a financial transaction.

## Explainable scoring

All signals combine additively, clamped 0–100. Pin is one input, never a gate.

- Two or more past returns +40, one return +25, loyal buyer (3+ orders, no returns) −15.
- Pin return rate 30%+ adds 30, 20%+ adds 15, unknown adds 10. Data is illustrative.
- Short address (<25 chars) +10, no number +5, no landmark/locality marker +5.
- Invalid/repetitive phone +20, name verification flag +20.
- Two or more orders from the phone today +15, value over ₹2,000 +10, first-time buyer +10.

Weights, value threshold and frequency threshold are configurable. City, region, ethnicity and community are never score inputs. Blanket group-ban requests are refused (422). Phone/name heuristics are explainable demo flags, not proof of fraud. They can misclassify real people and should be evaluated before real use. A human reviews the evidence.

Prepaid bypasses COD scoring and the address call. Optional imported history overrides demo phone history. The address LLM hook, when privately configured, receives only address text and returns a strict enum plus explanation. Without a key it uses a labeled rule-based fallback. Reference-aligned address points remain deterministic; the LLM provides additional evidence only.

## API

Send `X-API-Key`. The published sandbox key is `wma_test_demo_000000000000000000000000sandbox`.

| Method/path | Purpose |
|---|---|
| POST /v1/orders | Validate, score, store and suggest. external_id / Idempotency-Key prevent duplicates |
| POST /v1/orders/score | Stateless preview |
| GET /v1/orders[/:id] | Tenant-isolated queue/detail |
| POST /v1/orders/:id/buyer-reply | confirm, paid, cancel, no_reply, wrong_address. Evidence only |
| POST /v1/orders/:id/actions | action ship/hold/cancel, or override with to + required note |
| GET /v1/orders/:id/suggestion | Suggested action only |
| GET/PUT /v1/policy | Validated scoring/fees/timing policy |
| GET/PUT /v1/settings | Brand name and savings assumptions |
| POST/GET/DELETE /v1/webhooks[/:id] | Signed event subscriptions |
| GET /v1/webhooks-deliveries | Delivery audit |
| GET /v1/usage | Per-key metering and tenant plan limits |

Scopes: orders:read, orders:write, orders:action, policy:manage, webhooks:manage. Keys are SHA-256 hashed, shown once, rotatable and revocable. New keys use wma_test_/wma_live_; legacy cgk_ keys remain accepted. Legacy CODGUARD_* environment variables and X-CODGuard-* signature headers are retained for compatibility.

Signed outbound events include order.scored, order.reply_received, order.review_required, order.reminded, order.status_changed, order.overridden and order.auto_cancelled. Verify X-CODGuard-Signature as `sha256=<HMAC-SHA256(raw body, webhook secret)>`. Delivery retries once and records results.

Plans are prototype limits, not paid subscriptions: Sandbox 500 orders/month, 30 requests/min, 1 webhook; Growth 50,000, 120/min, 5 webhooks; Scale 1,000,000, 600/min, 25 webhooks. Billing is not connected.

## Console

Black-header operator workspace, five KPIs, six queue views, score circles, reason cards, WhatsApp preview/copy/manual chat link, reply simulation, manual decisions, S/H/C shortcuts and arrow-key selection, auto-advance, settings/help drawers, CSV import and bulk actions.

CSV columns: `order_id,name,phone,address,city,pincode,order_value,payment_mode,past_orders,past_rto_count,orders_same_phone_today`. Import up to 100 rows via `POST /api/import {orders:[...]}`. Partial results list validation errors; repeated order IDs replay. Today counts are imported or computed from tenant orders. The sandbox API is intentionally unauthenticated and shared, never upload personal data.

`POST /api/demo/bulk` supports ship_safe, simulate_replies, accept_suggestions, all explicit human-triggered actions. `POST /api/demo/advance` advances the demo clock; `/api/reset` restores seed orders. Brand name and savings assumptions persist through `/api/settings`.

Savings estimate = risky COD count × assumed return rate × prevention share × cost/return × 30. This is illustrative, not measured savings. Defaults: 37.5%, 30%, ₹350.

## Admin and limits

`/admin/api` and console manage tenants and keys with X-Admin-Key. The public demo uses documented `demo-admin-key`. Before real use, set CODGUARD_ADMIN_KEY privately, replace the public dashboard with authenticated seller accounts and remove demo mutation routes.

Persistence is an atomic JSON file (CODGUARD_DATA_FILE). Render free instances have ephemeral storage, sleep on inactivity and can cold-start slowly. No durability guarantee is made. Use managed Postgres, a job queue, distributed rate limits, durable webhook retries, real authentication, retention/privacy controls, provider verification and operational monitoring before customer traffic. Idempotency is single-process and must be backed by a database uniqueness constraint for scale.

No automatic WhatsApp provider, real payments, n8n workflow, billing or paid service is enabled. WhatsApp opens a prefilled chat that a person must review and send. No real platform integration with Swiggy, Zomato or Amazon is claimed.

MIT license, see LICENSE.
