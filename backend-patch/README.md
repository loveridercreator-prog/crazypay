# Crazy Pay backend patch (for your Cloud Run repo)

Copy `crazypay-core.js` into the root of your GitHub repo (next to `server.js`), then in `server.js`
after Express + firebase-admin are initialised:

```js
const attachCoreRoutes = require('./crazypay-core');
attachCoreRoutes(app, admin);
```

Remove/rename any older duplicate handlers for the same paths so these take effect.
Redeploy to Cloud Run. This project already proxies `/api/*` to that service, so no frontend change is needed.

## Endpoints added

| Issue | Endpoint | Behaviour |
|---|---|---|
| 1 | `GET /api/gateways/active?amount=100` | Returns only gateways that have a real active ad in `p2p_orders` (Mobikwik/Freecharge/Paytm/PhonePe). Missing ad ⇒ gateway omitted. |
| 2 | `POST /api/orders/create` | Fetches seller wallet balance first; rejects with **400** if `requested + existing_active_orders > available_balance`. Also atomically debits via RTDB transaction to block concurrent over-creation. |
| 5 | same | Rejects any amount that is not a multiple of ₹100. |
| 5 | `GET /api/orders/mine/:userId`, `GET /api/orders/market?userId=` | Filters out invalid/ghost amounts and scopes rows per user. |
| 3 | `POST /api/payments/initiate` | Validates seller VPA + amount, returns `paymentUrl` (app intent URI) — frontend does `window.location.href = res.paymentUrl`. |
| 4 | `POST /api/payments/webhook` | On success writes an idempotent row into `sale_ledger/{uid}` and marks the order COMPLETED; on failure refunds the reserved wallet amount. |
| 4 | `GET /api/sale-ledger/:userId` | Reads the ledger with totals. |
| 6 | `GET /api/wallet/:userId/selling-breakdown` | ₹789 ⇒ `{ sellable: 700, chunks: [500,200], remainder: 89 }` — the ₹89 stays in the wallet. |
| 6 | `GET /api/orders/in-transaction/:userId` | Includes exact `totalPayable` per order and in aggregate. |

## Adjust if your schema differs

Paths used: `p2p_orders/{id}`, `users/{uid}/wallet/balance`, `sale_ledger/{uid}`.
Slot rules live in `SLOT_UNITS` / `MIN_SLOT` at the top of the file.
