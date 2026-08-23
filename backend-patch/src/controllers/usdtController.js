/**
 * CRAZY PAY :: USDT DEPOSIT CONTROLLER (full rebuild)
 * ---------------------------------------------------------------------------
 * Every legacy USDT handler is purged. The surface is exactly three endpoints:
 *
 *   1. POST /api/v1/usdt/create-order    HD temp address + order slot
 *   2. GET  /api/v1/usdt/check-status    listener-backed status / auto-credit
 *   3. POST /api/v1/usdt/verify-txhash   manual on-chain fallback verification
 *
 * Design rules
 *   - Amounts are ALWAYS read from the chain, never from the client body.
 *   - Flexible crediting: order asks $100, chain says $98.42 -> credit $98.42
 *     and mark the order SUCCESS immediately.
 *   - Double-spend protection: usdt_deposits has a unique index on tx_hash, so
 *     one transaction can never credit two orders.
 *   - Successful orders are queued for gas funding + full sweep to master.
 */

const crypto = require("crypto");
const svc = require("../services/usdtSweeperService");

const { pool, MASTER_WALLETS } = svc;

const ORDER_TTL_MINUTES = Number(process.env.USDT_ORDER_TTL_MINUTES || 15);
const MIN_USDT = 1;
const MAX_USDT = 10000;
const DEFAULT_INR_RATE = Number(process.env.USDT_INR_RATE || 117);

const NETWORK_NOTE =
  "\u26a0\ufe0f \u0928\u094b\u091f: \u0905\u0917\u0930 \u0906\u092a 100 USDT \u0938\u0947 \u0915\u092e \u0921\u093f\u092a\u0949\u091c\u093f\u091f \u0915\u0930 \u0930\u0939\u0947 \u0939\u0948\u0902, \u0924\u094b BSC (BEP-20) \u091a\u0941\u0928\u0947\u0902\u0964 100 USDT \u0938\u0947 10,000 USDT \u0924\u0915 \u0915\u0947 \u092c\u0921\u093c\u0947 \u0905\u092e\u093e\u0909\u0902\u091f \u0915\u0947 \u0932\u093f\u090f TRC-20 \u0928\u0947\u091f\u0935\u0930\u094d\u0915 \u091a\u0941\u0928\u0947\u0902, \u0905\u0928\u094d\u092f\u0925\u093e \u091f\u094d\u0930\u093e\u0902\u091c\u0947\u0915\u094d\u0936\u0928 \u092e\u0947\u0902 \u0926\u0947\u0930\u0940 \u0939\u094b \u0938\u0915\u0924\u0940 \u0939\u0948\u0964";

/* ------------------------------------------------------------------ utils */

const money = (n) => Number(Number(n).toFixed(6));
const inr = (n) => Number(Number(n).toFixed(2));

/**
 * Optional external balance hook (e.g. Firebase RTDB in the Cloud Run app).
 * Wired by usdtRoutes.attachUsdtRoutes(app, admin).
 */
let balanceCreditor = null;
function setBalanceCreditor(fn) {
  balanceCreditor = typeof fn === "function" ? fn : null;
}

function orderPayload(order, extra = {}) {
  return {
    orderId: order.order_ref,
    userId: order.user_id,
    network: order.network,
    tempAddress: order.temp_address,
    masterWallet: order.master_wallet,
    expectedAmount: Number(order.expected_amount),
    receivedAmount: Number(order.received_amount),
    inrRate: Number(order.inr_rate),
    inrCredited: Number(order.inr_credited),
    status: order.status,
    sweepStatus: order.sweep_status,
    txHash: order.tx_hash,
    expiresAt: order.expires_at,
    ...extra,
  };
}

/* -------------------------------------------------- shared credit routine */

/**
 * Atomically record an on-chain hit and credit the order.
 * Returns the updated order, or null when the tx hash was already used.
 */
async function creditOrder(order, hit) {
  const amount = money(hit.amount);
  if (!(amount > 0)) return null;

  const txHash = hit.txHash || `listener:${order.network}:${order.temp_address}`;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows: locked } = await client.query(
      `SELECT * FROM usdt_orders WHERE id = $1 FOR UPDATE`,
      [order.id]
    );
    const current = locked[0];
    if (!current) {
      await client.query("ROLLBACK");
      return null;
    }
    if (current.status === "SUCCESS") {
      await client.query("ROLLBACK");
      return current;
    }

    // Unique index on lower(tx_hash) is the double-spend stop.
    const { rows: dep } = await client.query(
      `INSERT INTO usdt_deposits
         (order_id, network, tx_hash, from_address, to_address, amount, source, block_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        current.id,
        current.network,
        txHash,
        hit.from || null,
        current.temp_address,
        amount,
        hit.source,
        hit.blockNumber || null,
      ]
    );

    if (dep.length === 0) {
      await client.query("ROLLBACK");
      return null; // tx hash already consumed by another order
    }

    const rate = Number(current.inr_rate) || DEFAULT_INR_RATE;
    const credited = inr(amount * rate);

    const { rows: updated } = await client.query(
      `UPDATE usdt_orders
          SET status = 'SUCCESS',
              received_amount = $2,
              inr_credited = $3,
              tx_hash = $4,
              credited_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [current.id, amount, credited, hit.txHash || null]
    );

    await client.query("COMMIT");

    const saved = updated[0];

    if (balanceCreditor) {
      try {
        await balanceCreditor({
          userId: saved.user_id,
          usdt: amount,
          inr: credited,
          orderRef: saved.order_ref,
          network: saved.network,
          txHash: saved.tx_hash,
        });
      } catch (err) {
        console.error("[usdt] balance hook failed:", err.message);
      }
    }

    // Gas top-up + 100% sweep to the master receiver wallet.
    svc.queueSweep(saved.id).catch((err) => console.error("[usdt] queueSweep:", err.message));

    return saved;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* ---------------------------------- 1. HD TEMP ADDRESS & ORDER CREATION -- */

/** POST /api/v1/usdt/create-order  { userId, amount, network } */
exports.createOrder = async (req, res) => {
  try {
    // Global admin master switch — refuse new records while service is closed.
    if (await systemStatus.guard(res)) return;

    const userId = String(req.body.userId || req.body.user_id || "").trim();

    const amount = Number(req.body.amount);
    const network = svc.normalizeNetwork(req.body.network);
    const rate = Number(req.body.rate) > 0 ? Number(req.body.rate) : DEFAULT_INR_RATE;

    if (!userId) return res.status(400).json({ success: false, error: "userId is required" });
    if (!Number.isFinite(amount) || amount < MIN_USDT || amount > MAX_USDT) {
      return res
        .status(400)
        .json({ success: false, error: `Amount must be between ${MIN_USDT} and ${MAX_USDT} USDT` });
    }

    const { rows: seq } = await pool.query(`SELECT nextval('usdt_hd_index_seq') AS idx`);
    const hdIndex = Number(seq[0].idx);
    const tempAddress = svc.deriveAddress(network, hdIndex);
    const orderRef = `USDT-${Date.now().toString(36).toUpperCase()}-${crypto
      .randomBytes(3)
      .toString("hex")
      .toUpperCase()}`;

    const { rows } = await pool.query(
      `INSERT INTO usdt_orders
         (order_ref, user_id, network, hd_index, temp_address, master_wallet,
          expected_amount, inr_rate, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING', NOW() + ($9 || ' minutes')::INTERVAL)
       RETURNING *`,
      [
        orderRef,
        userId,
        network,
        hdIndex,
        tempAddress,
        MASTER_WALLETS[network],
        money(amount),
        rate,
        ORDER_TTL_MINUTES,
      ]
    );

    const order = rows[0];
    return res.status(201).json({
      success: true,
      ...orderPayload(order),
      qrCodeUrl: `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(
        tempAddress
      )}`,
      contract: svc.USDT_CONTRACTS[network],
      expiresInSeconds: ORDER_TTL_MINUTES * 60,
      networkNote: NETWORK_NOTE,
    });
  } catch (err) {
    console.error("[usdt/create-order]", err);
    return res.status(500).json({ success: false, error: "Could not create USDT deposit order" });
  }
};

/* ------------------- 2. AUTOMATIC DETECTION & PARTIAL CREDITING (status) - */

/** GET /api/v1/usdt/check-status?orderId=USDT-xxxx */
exports.checkStatus = async (req, res) => {
  try {
    const orderRef = String(req.query.orderId || req.query.order_id || "").trim();
    if (!orderRef) return res.status(400).json({ success: false, error: "orderId is required" });

    const { rows } = await pool.query(`SELECT * FROM usdt_orders WHERE order_ref = $1`, [orderRef]);
    let order = rows[0];
    if (!order) return res.status(404).json({ success: false, error: "Order not found" });

    if (order.status === "PENDING" && new Date(order.expires_at) < new Date()) {
      const { rows: exp } = await pool.query(
        `UPDATE usdt_orders SET status = 'EXPIRED' WHERE id = $1 RETURNING *`,
        [order.id]
      );
      order = exp[0];
    }

    // Live RPC read on demand, on top of the 3-second background listener.
    if (order.status === "PENDING") {
      try {
        const balance = await svc.getUsdtBalance(order.network, order.temp_address);
        if (balance > 0) {
          const credited = await creditOrder(order, {
            amount: balance,
            txHash: null,
            source: "LISTENER",
          });
          if (credited) order = credited;
        }
      } catch (err) {
        console.error("[usdt/check-status] rpc:", err.message);
        return res.status(200).json({
          success: true,
          status: order.status,
          rpcAvailable: false,
          allowManualTxHash: true,
          order: orderPayload(order),
        });
      }
    }

    return res.status(200).json({
      success: true,
      status: order.status,
      rpcAvailable: true,
      allowManualTxHash: order.status === "PENDING" || order.status === "EXPIRED",
      receivedAmount: Number(order.received_amount),
      inrCredited: Number(order.inr_credited),
      txHash: order.tx_hash,
      order: orderPayload(order),
    });
  } catch (err) {
    console.error("[usdt/check-status]", err);
    return res.status(500).json({ success: false, error: "Status check failed" });
  }
};

/* ------------------------ 3. MANUAL FALLBACK VERIFICATION (TRX ID / HASH) */

/** POST /api/v1/usdt/verify-txhash  { orderId, txHash } */
exports.verifyTxHash = async (req, res) => {
  try {
    const orderRef = String(req.body.orderId || req.body.order_id || "").trim();
    const txHash = String(req.body.txHash || req.body.txId || "").trim();

    if (!orderRef) return res.status(400).json({ success: false, error: "orderId is required" });
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(txHash)) {
      return res
        .status(400)
        .json({ success: false, error: "Enter a valid 64-character transaction hash" });
    }

    const { rows } = await pool.query(`SELECT * FROM usdt_orders WHERE order_ref = $1`, [orderRef]);
    const order = rows[0];
    if (!order) return res.status(404).json({ success: false, error: "Order not found" });
    if (order.status === "SUCCESS") {
      return res.status(200).json({ success: true, status: "SUCCESS", order: orderPayload(order) });
    }

    const { rows: used } = await pool.query(
      `SELECT order_id FROM usdt_deposits WHERE lower(tx_hash) = lower($1)`,
      [txHash]
    );
    if (used.length) {
      return res.status(409).json({
        success: false,
        status: "DUPLICATE",
        error: "This transaction hash has already been used for another order",
      });
    }

    const hit = await svc.findUsdtTransfer(order.network, txHash, order.temp_address);
    if (!hit) {
      return res.status(422).json({
        success: false,
        status: order.status,
        error:
          "No confirmed USDT transfer to this deposit address was found for that hash. Wait for confirmations and retry.",
      });
    }

    const credited = await creditOrder(order, { ...hit, source: "MANUAL_TXHASH" });
    if (!credited) {
      return res
        .status(409)
        .json({ success: false, status: "DUPLICATE", error: "Transaction already credited" });
    }

    return res.status(200).json({
      success: true,
      status: credited.status,
      receivedAmount: Number(credited.received_amount),
      inrCredited: Number(credited.inr_credited),
      txHash: credited.tx_hash,
      order: orderPayload(credited),
    });
  } catch (err) {
    console.error("[usdt/verify-txhash]", err);
    return res.status(500).json({ success: false, error: "Verification failed" });
  }
};

exports.creditOrder = creditOrder;
exports.setBalanceCreditor = setBalanceCreditor;
exports.NETWORK_NOTE = NETWORK_NOTE;
