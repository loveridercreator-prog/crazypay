/**
 * CRAZY PAY :: ORDER CREATION ENGINE — service layer (full overwrite)
 * ---------------------------------------------------------------------------
 * MODULE 1  data binding + dynamic random chunking of seller balance
 * MODULE 2  two-stage split timer (5 min buy lock -> 15 min payment/UTR)
 * MODULE 3  UPI intent URI construction (Mobikwik targeted + generic fallback)
 * MODULE 4  realtime event bus for sale ledger / buy history
 *
 * All legacy order-creation helpers (fixed 3-way splits, client-side paisa
 * offsets, simulated auto-match sweeps) are PURGED; this file is authoritative.
 */

const crypto = require("crypto");
const { EventEmitter } = require("events");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
  max: 10,
});

/* -------------------------------------------------------------- constants */

const BUY_LOCK_MINUTES = 5;   // stage 1
const PAY_WINDOW_MINUTES = 15; // stage 2  (total lifecycle = 20 min)
const MIN_CHUNKS = 2;
const MAX_CHUNKS = 10;

/** Round display denominations offered on UI cards. */
const DISPLAY_DENOMINATIONS = [100, 150, 200, 300, 500, 1000, 2000, 5000];

const PAYMENT_APPS = {
  mobikwik: { payment_app_type: "Mobikwik", symbol: "/upi-logos/mobikwik.svg", package: "com.mobikwik_new" },
  paytm: { payment_app_type: "Paytm", symbol: "/upi-logos/paytm.svg", package: "net.one97.paytm" },
  phonepe: { payment_app_type: "PhonePe", symbol: "/upi-logos/phonepe.svg", package: "com.phonepe.app" },
  gpay: { payment_app_type: "GPay", symbol: "/upi-logos/gpay.svg", package: "com.google.android.apps.nbu.paisa.user" },
};

const bus = new EventEmitter();
bus.setMaxListeners(0);

/* ------------------------------------------------------------------ utils */

const money = (n) => Number(Number(n).toFixed(2));
const randInt = (min, max) => min + crypto.randomInt(max - min + 1);

function resolvePaymentApp(name) {
  const key = String(name || "mobikwik").toLowerCase();
  if (key.includes("mobikwik")) return PAYMENT_APPS.mobikwik;
  if (key.includes("paytm")) return PAYMENT_APPS.paytm;
  if (key.includes("phonepe")) return PAYMENT_APPS.phonepe;
  if (key.includes("gpay") || key.includes("google")) return PAYMENT_APPS.gpay;
  return PAYMENT_APPS.mobikwik;
}

function orderRef() {
  return `CP${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

async function tx(run) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await run(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------ MODULE 3 :: UPI INTENTS */

/**
 * upi://pay?pa=&pn=&am=&tr=&cu=INR&tn=
 * Returns both the generic URI and a Mobikwik-targeted Android intent URI.
 */
function buildUpiIntent({ seller_upi_id, seller_name, payable_amount, order_ref, payment_app_type }) {
  const pa = encodeURIComponent(seller_upi_id);
  const pn = encodeURIComponent(seller_name || "CRAZY PAY MERCHANT");
  const am = money(payable_amount).toFixed(2);
  const tr = encodeURIComponent(order_ref);
  const query = `pa=${pa}&pn=${pn}&am=${am}&tr=${tr}&cu=INR&tn=${tr}`;
  const app = resolvePaymentApp(payment_app_type);

  return {
    upi_uri: `upi://pay?${query}`,
    intent_uri:
      `intent://pay?${query}#Intent;scheme=upi;package=${app.package};` +
      `S.browser_fallback_url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3D${app.package};end`,
    target_package: app.package,
  };
}

/* ----------------------------------- MODULE 1 :: RANDOM BALANCE CHUNKING */

/**
 * Splits `balance` into a RANDOM number of chunks (2..10) using round display
 * denominations. Guarantees SUM(chunks) <= balance.
 */
function randomChunkBalance(balance, { minChunks = MIN_CHUNKS, maxChunks = MAX_CHUNKS } = {}) {
  const available = Math.floor(Number(balance));
  if (!Number.isFinite(available) || available < DISPLAY_DENOMINATIONS[0]) return [];

  const target = randInt(minChunks, maxChunks);
  const chunks = [];
  let remaining = available;

  for (let i = 0; i < target; i += 1) {
    const affordable = DISPLAY_DENOMINATIONS.filter((d) => d <= remaining);
    if (!affordable.length) break;
    // Keep headroom so later chunks are still possible where the balance allows.
    const cap = i < target - 1 ? Math.max(1, Math.floor(affordable.length * 0.75)) : affordable.length;
    const pick = affordable[crypto.randomInt(cap)];
    chunks.push(pick);
    remaining -= pick;
  }
  return chunks;
}

/** Free paisa discount (0.01–0.99) for a display amount, honouring live slots. */
async function allocateDiscountPaisa(client, displayAmount) {
  await client.query("SELECT pg_advisory_xact_lock($1)", [
    crypto.createHash("md5").update(String(displayAmount)).digest().readUInt32BE(0),
  ]);
  const { rows } = await client.query(
    `SELECT discount_paisa FROM p2p_orders
      WHERE display_amount = $1 AND status IN ('AVAILABLE','LOCKED','PAYING')`,
    [displayAmount]
  );
  const used = new Set(rows.map((r) => Number(r.discount_paisa)));
  const free = [];
  for (let p = 1; p <= 99; p += 1) if (!used.has(p)) free.push(p);
  if (!free.length) return null;
  return free[crypto.randomInt(free.length)];
}

/* ------------------------------------------------------------- EVENT BUS */

async function emitEvent(client, order, event) {
  const { rows } = await client.query(
    `INSERT INTO order_events (order_id, order_ref, seller_id, buyer_id, event, status, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [order.id, order.order_ref, order.seller_id, order.buyer_id || null, event, order.status, JSON.stringify(order)]
  );
  bus.emit("order", rows[0]);
  return rows[0];
}

/* ------------------------------------------- MODULE 1 :: ORDER CREATION */

async function loadSeller(client, sellerId) {
  const { rows } = await client.query(`SELECT * FROM sellers WHERE seller_id = $1`, [sellerId]);
  return rows[0] || null;
}

/** Creates ONE order with every bound parameter persisted. */
async function createBoundOrder(client, seller, displayAmount, batchId, reorderOf = null) {
  const app = resolvePaymentApp(seller.payment_app_type);
  const discount = await allocateDiscountPaisa(client, displayAmount);
  if (discount === null) return null; // all 99 slots busy for this denomination

  const payable = money(displayAmount - discount / 100);
  const { rows } = await client.query(
    `INSERT INTO p2p_orders
       (order_ref, seller_id, seller_name, seller_referral_id, seller_upi_id,
        payment_app_type, symbol, display_amount, discount_paisa, payable_amount,
        status, chunk_batch_id, reorder_of)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'AVAILABLE',$11,$12)
     RETURNING *`,
    [
      orderRef(),
      seller.seller_id,
      seller.seller_name,
      seller.seller_referral_id,
      seller.seller_upi_id,
      app.payment_app_type,
      seller.symbol || app.symbol,
      displayAmount,
      discount,
      payable,
      batchId,
      reorderOf,
    ]
  );
  const order = rows[0];
  await emitEvent(client, order, "ORDER_CREATED");
  return order;
}

/** SUM(active orders) for a seller — the escrow hold. */
async function activeHold(client, sellerId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(display_amount),0) AS held FROM p2p_orders
      WHERE seller_id = $1 AND status IN ('AVAILABLE','LOCKED','PAYING')`,
    [sellerId]
  );
  return Number(rows[0].held);
}

/**
 * Withdrawal engine entry point. Generates a random number of chunked orders
 * while respecting SUM(Active_Orders) <= seller_available_balance.
 */
async function runWithdrawalEngine(sellerId, opts = {}) {
  return tx(async (client) => {
    const seller = await loadSeller(client, sellerId);
    if (!seller) return { ok: false, error: "Seller not found" };
    if (!seller.withdrawal_engine) return { ok: false, error: "withdrawal_engine is OFF" };
    if (!seller.upi_verified) return { ok: false, error: "Seller UPI is not verified" };
    if (Number(seller.available_balance) <= 0) return { ok: false, error: "No available balance" };

    const held = await activeHold(client, sellerId);
    const headroom = Number(seller.available_balance) - held;
    if (headroom < DISPLAY_DENOMINATIONS[0]) {
      return { ok: true, created: [], held, headroom, note: "Balance fully allocated to active orders" };
    }

    const batchId = `BATCH-${orderRef()}`;
    const chunks = randomChunkBalance(headroom, opts);
    const created = [];
    let allocated = 0;

    for (const amount of chunks) {
      if (allocated + amount > headroom) break; // strict balance rule
      const order = await createBoundOrder(client, seller, amount, batchId);
      if (!order) continue;
      allocated += amount;
      created.push(order);
    }

    return { ok: true, batch_id: batchId, created, chunk_count: created.length, held: held + allocated, headroom };
  });
}

/** Stage-1 expiry auto-regeneration: fresh order for the same seller/amount. */
async function regenerateOrder(client, expired) {
  const seller = await loadSeller(client, expired.seller_id);
  if (!seller || !seller.withdrawal_engine) return null;
  const held = await activeHold(client, seller.seller_id);
  if (held + Number(expired.display_amount) > Number(seller.available_balance)) return null;
  return createBoundOrder(client, seller, Number(expired.display_amount), expired.chunk_batch_id, expired.id);
}

/* -------------------------------------- MODULE 2 :: TWO-STAGE SPLIT TIMER */

/** Stage 1 — buyer opens an order: 5-minute exclusive buy lock. */
async function lockOrder(orderId, buyerId) {
  return tx(async (client) => {
    const { rows } = await client.query(
      `UPDATE p2p_orders
          SET status='LOCKED', buyer_id=$2, locked_at=NOW(),
              lock_expires_at = NOW() + ($3 || ' minutes')::INTERVAL, updated_at=NOW()
        WHERE id=$1 AND status='AVAILABLE'
        RETURNING *`,
      [orderId, buyerId, BUY_LOCK_MINUTES]
    );
    if (!rows.length) return { ok: false, error: "Order is no longer available" };
    await emitEvent(client, rows[0], "ORDER_LOCKED");
    return { ok: true, order: rows[0], stage: 1, seconds: BUY_LOCK_MINUTES * 60 };
  });
}

/** Stage 2 — buyer clicks Buy/Confirm: clear 5-min timer, start 15-min UTR window. */
async function confirmOrder(orderId, buyerId) {
  return tx(async (client) => {
    const { rows } = await client.query(
      `UPDATE p2p_orders
          SET status='PAYING', confirmed_at=NOW(),
              pay_expires_at = NOW() + ($3 || ' minutes')::INTERVAL,
              lock_expires_at = NULL, updated_at=NOW()
        WHERE id=$1 AND buyer_id=$2 AND status='LOCKED' AND lock_expires_at > NOW()
        RETURNING *`,
      [orderId, buyerId, PAY_WINDOW_MINUTES]
    );
    if (!rows.length) return { ok: false, error: "Buy lock expired or order not held by this buyer" };
    await emitEvent(client, rows[0], "ORDER_CONFIRMED");
    return { ok: true, order: rows[0], stage: 2, seconds: PAY_WINDOW_MINUTES * 60 };
  });
}

/** MODULE 4 — atomic terminal state lock (SUCCESS / CANCELLED / FAILED). */
async function settleOrder(orderId, finalStatus, extra = {}) {
  const allowed = ["SUCCESS", "CANCELLED", "FAILED"];
  if (!allowed.includes(finalStatus)) throw new Error("Invalid terminal status");

  return tx(async (client) => {
    const { rows } = await client.query(
      `UPDATE p2p_orders
          SET status=$2, state_locked=TRUE, settled_at=NOW(),
              utr_number = COALESCE($3, utr_number), updated_at=NOW()
        WHERE id=$1 AND state_locked = FALSE
        RETURNING *`,
      [orderId, finalStatus, extra.utr_number || null]
    );
    if (!rows.length) {
      const { rows: current } = await client.query(`SELECT * FROM p2p_orders WHERE id=$1`, [orderId]);
      return { ok: current.length > 0, frozen: true, order: current[0] || null };
    }
    const order = rows[0];

    if (finalStatus === "SUCCESS") {
      await client.query(
        `UPDATE sellers SET available_balance = GREATEST(available_balance - $2, 0) WHERE seller_id = $1`,
        [order.seller_id, order.display_amount]
      );
    }
    await emitEvent(client, order, `ORDER_${finalStatus}`);
    return { ok: true, order };
  });
}

/** Timer sweeper — expires both stages and auto-regenerates stage-1 dropouts. */
async function sweepTimers() {
  return tx(async (client) => {
    const { rows: expired } = await client.query(
      `UPDATE p2p_orders
          SET status='CANCELLED', state_locked=TRUE, settled_at=NOW(), updated_at=NOW()
        WHERE (status='LOCKED'    AND lock_expires_at < NOW())
           OR (status='PAYING'    AND pay_expires_at  < NOW())
           OR (status='AVAILABLE' AND created_at < NOW() - INTERVAL '60 minutes')
        RETURNING *`
    );

    const regenerated = [];
    for (const order of expired) {
      await emitEvent(client, order, order.confirmed_at ? "PAYMENT_WINDOW_EXPIRED" : "BUY_LOCK_EXPIRED");
      const fresh = await regenerateOrder(client, order); // escrow released -> fresh slot
      if (fresh) regenerated.push(fresh);
    }
    return { expired: expired.length, regenerated: regenerated.length };
  });
}

let sweeperId = null;
function startTimerSweeper(intervalMs = 10000) {
  if (sweeperId) return sweeperId;
  sweeperId = setInterval(() => {
    sweepTimers().catch((err) => console.error("[order-sweeper]", err.message));
  }, intervalMs);
  if (sweeperId.unref) sweeperId.unref();
  return sweeperId;
}
function stopTimerSweeper() {
  if (sweeperId) clearInterval(sweeperId);
  sweeperId = null;
}

/* ------------------------------------------------- MODULE 4 :: LEDGERS */

async function activeSaleLedger(sellerId) {
  const { rows } = await pool.query(
    `SELECT * FROM active_sale_ledger WHERE seller_id = $1 ORDER BY created_at DESC`,
    [sellerId]
  );
  return rows;
}

async function buyerHistory(buyerId, limit = 100) {
  const { rows } = await pool.query(
    `SELECT * FROM buyer_history_ledger WHERE buyer_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [buyerId, Math.min(Number(limit) || 100, 500)]
  );
  return rows;
}

module.exports = {
  pool,
  bus,
  BUY_LOCK_MINUTES,
  PAY_WINDOW_MINUTES,
  DISPLAY_DENOMINATIONS,
  PAYMENT_APPS,
  money,
  tx,
  resolvePaymentApp,
  buildUpiIntent,
  randomChunkBalance,
  runWithdrawalEngine,
  createBoundOrder,
  loadSeller,
  activeHold,
  lockOrder,
  confirmOrder,
  settleOrder,
  sweepTimers,
  startTimerSweeper,
  stopTimerSweeper,
  activeSaleLedger,
  buyerHistory,
};
