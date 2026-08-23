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

---

# USDT deposit engine (full rebuild)

Legacy USDT handlers are purged. These four files replace them:

| File | Purpose |
|---|---|
| `src/models/usdtSchema.sql` | Drops + recreates `usdt_orders`, `usdt_deposits`, `usdt_sweeps`, HD index sequence |
| `src/controllers/usdtController.js` | create-order, check-status, verify-txhash |
| `src/services/usdtSweeperService.js` | HD derivation, chain reads, gas funding, sweeper, 3s listener |
| `src/routes/usdtRoutes.js` | Express router + Firebase balance crediting |

## Wire up

```sh
psql "$DATABASE_URL" -f src/models/usdtSchema.sql
npm i ethers@^6 tronweb@^6 pg express
```

```js
const { attachUsdtRoutes } = require('./src/routes/usdtRoutes');
attachUsdtRoutes(app, admin);   // mounts /api/v1/usdt and starts the workers
```

## Environment

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Postgres |
| `USDT_HD_MNEMONIC` | BIP-39 mnemonic deriving every temp address — back it up; losing it loses unswept funds |
| `BSC_RPC_URL` | default `https://bsc-dataseed.binance.org` |
| `BSC_MASTER_PRIVATE_KEY` | funds BNB gas, keep a small hot balance |
| `TRON_FULL_HOST` / `TRON_API_KEY` | TronGrid |
| `TRON_MASTER_PRIVATE_KEY` | funds TRX gas |
| `USDT_INR_RATE` | fallback rate when the client sends none |
| `USDT_ORDER_TTL_MINUTES` | default 15 |

## Endpoints

| Method | Path | Behaviour |
|---|---|---|
| POST | `/api/v1/usdt/create-order` | `{ userId, amount, network }` → unique HD temp address (`m/44'/60'` BSC, `m/44'/195'` TRON), QR, TTL, master wallet |
| GET | `/api/v1/usdt/check-status?orderId=` | Live RPC read on top of the 3s listener. Any non-zero balance credits the **exact** received amount and flips the order to SUCCESS |
| POST | `/api/v1/usdt/verify-txhash` | `{ orderId, txHash }` → decodes the Transfer log on-chain; amount comes from the log, never the client. `usdt_deposits.tx_hash` unique index blocks reuse (HTTP 409) |
| GET | `/api/v1/usdt/health` | wallets/contracts probe |

Master receivers: BSC `0x39cbbf2fd2e8d0e197599b7e53155f9468520d13`, TRC20 `TL8kCmde6dSuiZGovC5mfmjA94idwRUDE9`.
USDT contracts: BSC `0x55d398326f99059fF775485246999027B3197955`, TRC20 `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`.

## Sweeping

On every credit the order is queued. The worker tops up micro-gas from the master
wallet (0.0008 BNB / 30 TRX) only when the temp address is short, then transfers
100% of the USDT balance to the master receiver. Retries up to 5 times, state in
`usdt_sweeps`.

## Order Creation Engine (overwrite)

Files (authoritative, replace all legacy order creation):
- `src/models/orderEngineSchema.sql` — `sellers`, `p2p_orders`, `order_events`,
  `active_sale_ledger` / `buyer_history_ledger` views, `expire_order_timers()`.
- `src/services/orderEngineService.js` — data binding, random chunking (2–10),
  two-stage timers, UPI intent builder, event bus, timer sweeper.
- `src/controllers/orderEngineController.js` / `src/routes/orderEngineRoutes.js`.

Mount:
```js
const { attachOrderEngine } = require('./src/routes/orderEngineRoutes');
attachOrderEngine(app); // starts the 10s two-stage timer sweeper
```
Delete every legacy route: `/api/orders/create`, `/api/withdraw/split`,
`/api/sell/auto-generate`, `/api/v1/orders/auto-create`.

Endpoints (`/api/v1/orders`):
| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/engine/run` | withdrawal engine → random chunked orders |
| GET  | `/available` | buyer marketplace cards |
| POST | `/:id/lock` | stage 1, 5-min buy lock |
| POST | `/:id/confirm` | stage 2, 15-min payment/UTR window |
| POST | `/:id/settle` | atomic terminal state lock |
| GET  | `/sale-ledger?seller_id=` | active-only seller ledger |
| GET  | `/buy-history?buyer_id=` | frozen buyer history |
| GET  | `/stream` | realtime SSE order state feed |

Frontend: `public/orderEngine.js` (`window.CrazyPayOrderEngine`) and
`public/upiDeepLinkHandler.js` (`window.CrazyPayUpi.launchUpiPayment`).
