/**
 * CRAZY PAY :: ORDER CREATION ENGINE — controller (full overwrite)
 * All legacy order-creation endpoints are superseded by these handlers.
 */

const svc = require("../services/orderEngineService");
const systemStatus = require("../services/systemStatusService");


const money = svc.money;

function shapeOrder(o) {
  if (!o) return null;
  const intent = svc.buildUpiIntent({
    seller_upi_id: o.seller_upi_id,
    seller_name: o.seller_name,
    payable_amount: o.payable_amount,
    order_ref: o.order_ref,
    payment_app_type: o.payment_app_type,
  });
  const nowMs = Date.now();
  const secsTo = (t) => (t ? Math.max(0, Math.round((new Date(t).getTime() - nowMs) / 1000)) : 0);

  return {
    order_id: o.id,
    order_ref: o.order_ref,
    // MODULE 1 :: bound data
    display_amount: Number(o.display_amount),
    payable_amount: money(o.payable_amount),
    discount_paisa: o.discount_paisa,
    seller_id: o.seller_id,
    seller_name: o.seller_name,
    seller_referral_id: o.seller_referral_id,
    seller_upi_id: o.seller_upi_id,
    payment_app_type: o.payment_app_type,
    symbol: o.symbol,
    // MODULE 2 :: timers
    status: o.status,
    stage: o.status === "PAYING" ? 2 : o.status === "LOCKED" ? 1 : 0,
    buy_lock_seconds_left: o.status === "LOCKED" ? secsTo(o.lock_expires_at) : 0,
    payment_seconds_left: o.status === "PAYING" ? secsTo(o.pay_expires_at) : 0,
    lock_expires_at: o.lock_expires_at,
    pay_expires_at: o.pay_expires_at,
    // MODULE 3 :: deep link
    ...intent,
    // MODULE 4 :: state lock
    state_locked: Boolean(o.state_locked),
    settled_at: o.settled_at,
    utr_number: o.utr_number || null,
    buyer_id: o.buyer_id || null,
    created_at: o.created_at,
  };
}

/* -------------------- POST /api/v1/orders/engine/run  (seller withdrawal) */
exports.runEngine = async (req, res) => {
  try {
    const sellerId = String(req.body.seller_id || "").trim();
    if (!sellerId) return res.status(400).json({ ok: false, error: "seller_id required" });

    const out = await svc.runWithdrawalEngine(sellerId, {
      minChunks: Number(req.body.min_chunks) || undefined,
      maxChunks: Number(req.body.max_chunks) || undefined,
    });
    if (!out.ok) return res.status(400).json(out);

    return res.status(201).json({
      ok: true,
      batch_id: out.batch_id,
      chunk_count: out.chunk_count,
      held_total: out.held,
      orders: (out.created || []).map(shapeOrder),
      note: out.note,
    });
  } catch (err) {
    console.error("[order-engine:run]", err);
    return res.status(500).json({ ok: false, error: "Order generation failed" });
  }
};

/* ----------------------------- GET /api/v1/orders/available?buyer_id=... */
exports.listAvailable = async (_req, res) => {
  try {
    const { rows } = await svc.pool.query(
      `SELECT * FROM p2p_orders WHERE status='AVAILABLE' ORDER BY display_amount ASC, created_at ASC LIMIT 200`
    );
    return res.json({ ok: true, orders: rows.map(shapeOrder) });
  } catch (err) {
    console.error("[order-engine:available]", err);
    return res.status(500).json({ ok: false, error: "Failed to load orders" });
  }
};

/* ---------------------------------------- POST /api/v1/orders/:id/lock   */
exports.lock = async (req, res) => {
  try {
    const buyerId = String(req.body.buyer_id || "").trim();
    if (!buyerId) return res.status(400).json({ ok: false, error: "buyer_id required" });
    const out = await svc.lockOrder(Number(req.params.id), buyerId);
    if (!out.ok) return res.status(409).json(out);
    return res.json({ ok: true, stage: 1, timer_seconds: out.seconds, order: shapeOrder(out.order) });
  } catch (err) {
    console.error("[order-engine:lock]", err);
    return res.status(500).json({ ok: false, error: "Lock failed" });
  }
};

/* ------------------------------------- POST /api/v1/orders/:id/confirm   */
exports.confirm = async (req, res) => {
  try {
    const buyerId = String(req.body.buyer_id || "").trim();
    if (!buyerId) return res.status(400).json({ ok: false, error: "buyer_id required" });
    const out = await svc.confirmOrder(Number(req.params.id), buyerId);
    if (!out.ok) return res.status(409).json(out);
    return res.json({ ok: true, stage: 2, timer_seconds: out.seconds, order: shapeOrder(out.order) });
  } catch (err) {
    console.error("[order-engine:confirm]", err);
    return res.status(500).json({ ok: false, error: "Confirm failed" });
  }
};

/* -------------------------------------- POST /api/v1/orders/:id/settle   */
exports.settle = async (req, res) => {
  try {
    const status = String(req.body.status || "").toUpperCase();
    const out = await svc.settleOrder(Number(req.params.id), status, { utr_number: req.body.utr_number });
    if (!out.ok) return res.status(404).json({ ok: false, error: "Order not found" });
    return res.json({ ok: true, frozen: Boolean(out.frozen), order: shapeOrder(out.order) });
  } catch (err) {
    console.error("[order-engine:settle]", err);
    return res.status(400).json({ ok: false, error: err.message });
  }
};

/* -------------------------------------------- GET /api/v1/orders/:id     */
exports.getOne = async (req, res) => {
  try {
    const { rows } = await svc.pool.query(`SELECT * FROM p2p_orders WHERE id=$1`, [Number(req.params.id)]);
    if (!rows.length) return res.status(404).json({ ok: false, error: "Order not found" });
    return res.json({ ok: true, order: shapeOrder(rows[0]) });
  } catch (err) {
    console.error("[order-engine:get]", err);
    return res.status(500).json({ ok: false, error: "Lookup failed" });
  }
};

/* ------------------------- GET /api/v1/orders/sale-ledger?seller_id=...  */
exports.saleLedger = async (req, res) => {
  try {
    const sellerId = String(req.query.seller_id || "").trim();
    if (!sellerId) return res.status(400).json({ ok: false, error: "seller_id required" });
    const rows = await svc.activeSaleLedger(sellerId);
    return res.json({ ok: true, active_only: true, orders: rows.map(shapeOrder) });
  } catch (err) {
    console.error("[order-engine:ledger]", err);
    return res.status(500).json({ ok: false, error: "Ledger load failed" });
  }
};

/* ------------------------- GET /api/v1/orders/buy-history?buyer_id=...   */
exports.buyHistory = async (req, res) => {
  try {
    const buyerId = String(req.query.buyer_id || "").trim();
    if (!buyerId) return res.status(400).json({ ok: false, error: "buyer_id required" });
    const rows = await svc.buyerHistory(buyerId, req.query.limit);
    return res.json({ ok: true, orders: rows.map(shapeOrder) });
  } catch (err) {
    console.error("[order-engine:history]", err);
    return res.status(500).json({ ok: false, error: "History load failed" });
  }
};

/* ---------------- GET /api/v1/orders/stream  (realtime SSE broadcaster)  */
exports.stream = (req, res) => {
  const sellerId = req.query.seller_id ? String(req.query.seller_id) : null;
  const buyerId = req.query.buyer_id ? String(req.query.buyer_id) : null;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 3000\n\n`);

  const onEvent = (evt) => {
    if (sellerId && evt.seller_id !== sellerId) return;
    if (buyerId && evt.buyer_id !== buyerId) return;
    res.write(`event: ${evt.event}\ndata: ${JSON.stringify({
      event: evt.event,
      status: evt.status,
      order: shapeOrder(evt.payload),
      at: evt.created_at,
    })}\n\n`);
  };

  svc.bus.on("order", onEvent);
  const ping = setInterval(() => res.write(`: ping\n\n`), 20000);

  req.on("close", () => {
    clearInterval(ping);
    svc.bus.off("order", onEvent);
  });
};

exports.shapeOrder = shapeOrder;
