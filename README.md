# Merchant Endpoint Tester



in .env, add following:
<!-- deployed url -->
RIVERPE_BASE_URL
MERCHANT_API_KEY
MERCHANT_API_SECRET

A standalone mini app to verify all Riverpe merchant endpoints from a merchant integration perspective.

## What this tests

- POST /merchant/payments (create collection)
- GET /merchant/payments/:order_id (collection query)
- POST /merchant/payouts (create payout)
- GET /merchant/payouts/:order_id (payout query)
- GET /merchant/payouts/:order_id/voucher (voucher query)

- GET /merchant/balance (merchant ledger balance query)
- POST /api/test/hosted-payment (tester helper endpoint: hosted URL + payment URL)

## Merchant Balance & Payout Security

- PSP account is platform-owned; merchant ownership is enforced in backend ledger.
- Payout creation now runs backend checks before PSP call:
   - verifies merchant available balance
   - reserves amount in merchant ledger
   - calls PSP only after reserve succeeds
- On PSP failure, reservation is released.
- On successful payout completion, reserved amount is finalized as paid out.
- `GET /merchant/balance` now returns internal ledger fields:
   - `available_balance`
   - `reserved_balance`
   - `total_collected`
   - `total_paid_out`

## Callback Endpoints (Notify/Callback URLs)

Client callback behavior supported by this tester:

- Delivery can be `GET` or `POST`
- Callback is asynchronous real-time after pay-in/payout completion
- Receiver must return literal `success` when accepted
- Use `/notify` and `/notify/payout` for PSP-originated notices
- Use `/callback` and `/callback/payout` for Riverpe backend merchant callbacks

Routes in this tester:

- Collection notice (pay-in status):
   - `/notify` (GET/POST)
- Payout payment notification:
   - `/notify/payout` (GET/POST)
- Merchant callback endpoint:
   - `/callback` (GET/POST)
- Merchant payout callback endpoint:
   - `/callback/payout` (GET/POST)
- Dashboard/browser page:
   - `/dashboard` (GET only; POST is a compatibility alias)

Field normalization supported:

- `parter` or `parties` or `part`
- `orderid` or `warrants`
- `opstate` or `survive`
- `ovalue`
- `sign`
- `remark` (collection callbacks)
- `info` (payout failure reason, excluded from signature)

Optional signature verification:

- Set `VERIFY_PSP_CALLBACK_SIGNATURE=true`
- Uses MD5 signature format from client docs:
   - `opstate&orderid&ovalue&parter&key=secret`
   - `remark` included when present for collection notice flow

Merchant flow summary:

- `/notify` and `/notify/payout` simulate PSP webhook notices and always return plain text `success` when accepted.
- `/callback` and `/callback/payout` simulate the merchant-facing callback endpoint that Riverpe backend calls after status changes.
- `/dashboard` is browser-only UI for checking the captured state, not a production callback target.

## Setup

1. Copy `.env.example` to `.env`
2. Fill your merchant credentials:
   - `CLIENT_KEY_ID` (preferred) or `MERCHANT_API_KEY` (legacy)
   - `CLIENT_SECRET` (preferred) or `MERCHANT_API_SECRET` (legacy)

If you do not want secrets in the tester project, set `USE_BACKEND_ENV_CREDENTIALS=true` and keep credentials only in backend env.
3. Install dependencies
4. Start the app

```bash
npm install
npm run dev
```

Open: http://localhost:4050

Hosted payment helper page: http://localhost:4050/hosted-payment.html

## Signature behavior

This tester signs requests as:

MD5(sorted_non_empty_params + "&key=" + secret).toLowerCase()

Headers sent:

- x-api-key
- x-client-key-id
- x-nonce
- x-signature

When `USE_BACKEND_ENV_CREDENTIALS=true`, the tester sends no merchant auth headers and relies on backend local-test mode.

By default, GET signatures match your current backend middleware behavior (only `parter` + `nonce` are signed for GET). If you later update backend to include query/path fields in GET signatures, set:

`INCLUDE_GET_DATA_IN_SIGNATURE=true`

## Hosted Payment Helper

This tester now provides:

- `POST /api/test/hosted-payment`
   - Resolves `order_id` (or uses last created payment)
   - Fetches payment status
   - Returns:
      - `payment_url` (PSP native page)
      - `hosted_payment_url` (merchant dashboard route: `/payments/:order_id`)

- `/hosted-payment.html`
   - Calls the helper endpoint
   - Shows hosted and PSP URLs side-by-side
   - Lets you verify that hosted page embeds PSP QR in an iframe

Optional env for hosted URL generation:

- `MERCHANT_DASHBOARD_BASE_URL` (default: `http://localhost:3000`)

## Production-Style URLs To Use In Testing

- Notify URL: `http://localhost:4050/notify`
- Payout notify URL: `http://localhost:4050/notify/payout`
- Merchant callback URL: `http://localhost:4050/callback`
- Merchant payout callback URL: `http://localhost:4050/callback/payout`
- Dashboard/browser page: `http://localhost:4050/dashboard`
