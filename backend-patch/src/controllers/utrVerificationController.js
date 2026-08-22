/**
 * CRAZY PAY :: Auto-System P2P Discounted Auto-UTR Engine
 * ---------------------------------------------------------------------------
 * ALL legacy UTR handlers (triple-match, SMS sniffing, 3-minute retry loops,
 * localStorage duplicate lists, manual dispute escalation) are PURGED and
 * replaced by the four modules below.
 *
 *  1. POST /api/v1/orders/auto-create        System paisa-discount slot engine
 *  2. POST /api/v1/bank-transactions/webhook Bank statement / SMS ingestion
 *  3. POST /api/v1/orders/verify-utr         Auto-match + retry + UI directives
 *  4. POST /api/v1/orders/ocr-check          Tesseract OCR + ELA forensics
 *
 * Requires: pg, tesseract.js, sharp
 */

const crypto = require("crypto");
const { Pool } = require("pg");
const Tesseract = require("tesseract.js");
const sharp = require("sharp");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
  max: 10,
});

const ORDER_TTL_MINUTES = 15;
const MAX_SLOTS_PER_BASE = 99;
const MAX_RETRIES = 2;

/* ------------------------------------------------------------------ utils */

const money = (n) => Number(Number(n).toFixed(2));

function uiDirective(kind, extra = {}) {
  const map = {
    SUCCESS_BANNER: {
      ui: "BANNER",
      variant: "SUCCESS",
      title: "Your Order Was Successful",
      buttons: ["Close"],
    },
    RETRY_MODAL: {
      ui: "MODAL",
      variant: "WARNING",
      title: "Your Order Was Unsuccessful",
      message: "Your UTR Was Wrong or Already Used",
      buttons: ["Last Try", "Close"],
    },
    PERMANENT_FAIL_MODAL: {
      ui: "MODAL",
      variant: "ERROR",
      title: "Order Permanently Failed",
      message: "This order has been closed after 2 failed verification attempts.",
      buttons: ["Close"],
    },
    EXPIRED_MODAL: {
      ui: "MODAL",
      variant: "ERROR",
      title: "Order Expired",
      message: "The 15-minute payment window for this order has elapsed.",
      buttons: ["Close"],
    },
  };
  return { ...map[kind], ...extra };
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

async function expireStaleOrders(client) {
  await client.query(
    `UPDATE orders_db SET status='FAILED'
      WHERE status='PENDING' AND expires_at < NOW()`
  );
}

/* --------------------------------------------- 1. AUTOMATED ORDER CREATION */

/**
 * POST /api/v1/orders/auto-create   { user_id, base_amount }
 * Assigns a free 0.01-0.99 paisa discount so every live order has a unique
 * payable amount (e.g. 1000 -> 999.88). Max 99 concurrent slots per base.
 */
exports.autoCreateOrder = async (req, res) => {
  try {
    const userId = String(req.body.user_id || "").trim();
    const baseAmount = Number(req.body.base_amount);

    if (!userId) return res.status(400).json({ ok: false, error: "user_id required" });
    if (!Number.isFinite(baseAmount) || baseAmount < 1 || baseAmount > 500000)
      return res.status(400).json({ ok: false, error: "Invalid base_amount" });

    const result = await tx(async (client) => {
      await expireStaleOrders(client);

      // Serialize slot allocation per base amount.
      await client.query("SELECT pg_advisory_xact_lock($1)", [
        Number(crypto.createHash("md5").update(String(baseAmount)).digest().readUInt32BE(0)),
      ]);

      const { rows: taken } = await client.query(
        `SELECT discount_paisa FROM orders_db
          WHERE base_amount = $1 AND status = 'PENDING' AND expires_at > NOW()`,
        [baseAmount]
      );

      if (taken.length >= MAX_SLOTS_PER_BASE) {
        return { full: true, active: taken.length };
      }

      const used = new Set(taken.map((r) => Number(r.discount_paisa)));
      const free = [];
      for (let p = 1; p <= 99; p += 1) if (!used.has(p)) free.push(p);
      const discountPaisa = free[crypto.randomInt(free.length)];
      const payable = money(baseAmount - discountPaisa / 100);

      const { rows } = await client.query(
        `INSERT INTO orders_db
           (user_id, base_amount, discount_paisa, payable_amount, status, retry_count, expires_at)
         VALUES ($1,$2,$3,$4,'PENDING',0, NOW() + ($5 || ' minutes')::INTERVAL)
         RETURNING *`,
        [userId, baseAmount, discountPaisa, payable, ORDER_TTL_MINUTES]
      );
      return { order: rows[0], activeSlots: taken.length + 1 };
    });

    if (result.full) {
      return res.status(429).json({
        ok: false,
        error: `All ${MAX_SLOTS_PER_BASE} payment slots for this amount are busy. Try again shortly.`,
      });
    }

    const o = result.order;
    return res.status(201).json({
      ok: true,
      order_id: o.id,
      base_amount: money(o.base_amount),
      discount_paisa: o.discount_paisa,
      payable_amount: money(o.payable_amount),
      status: o.status,
      retry_count: o.retry_count,
      expires_at: o.expires_at,
      expires_in_seconds: ORDER_TTL_MINUTES * 60,
      active_slots: result.activeSlots,
    });
  } catch (err) {
    console.error("[auto-create]", err);
    return res.status(500).json({ ok: false, error: "Order creation failed" });
  }
};

/* ------------------------------------------ 2. BANK TRANSACTION INGESTION */

/**
 * POST /api/v1/bank-transactions/webhook  { utr_number, amount, sender_name }
 * Idempotent on utr_number (UNIQUE constraint).
 */
exports.ingestBankTransaction = async (req, res) => {
  try {
    const secret = process.env.BANK_WEBHOOK_SECRET;
    if (secret && req.get("x-webhook-secret") !== secret) {
      return res.status(401).json({ ok: false, error: "Invalid webhook signature" });
    }

    const utr = String(req.body.utr_number || "").trim();
    const amount = Number(req.body.amount);
    const sender = String(req.body.sender_name || "").slice(0, 120) || null;

    if (!/^\d{12}$/.test(utr))
      return res.status(400).json({ ok: false, error: "utr_number must be 12 digits" });
    if (!Number.isFinite(amount) || amount <= 0)
      return res.status(400).json({ ok: false, error: "Invalid amount" });

    const { rows } = await pool.query(
      `INSERT INTO bank_transactions_db (utr_number, amount, sender_name, status)
       VALUES ($1,$2,$3,'UNUSED')
       ON CONFLICT (utr_number) DO NOTHING
       RETURNING id, status`,
      [utr, money(amount), sender]
    );

    return res.status(200).json({
      ok: true,
      ingested: rows.length > 0,
      duplicate: rows.length === 0,
      id: rows[0] ? rows[0].id : null,
    });
  } catch (err) {
    console.error("[bank-webhook]", err);
    return res.status(500).json({ ok: false, error: "Ingestion failed" });
  }
};

/* ------------------------------- 3. AUTO-UTR MATCHING, RETRY & UI POPUPS */

/**
 * POST /api/v1/orders/verify-utr   { order_id, buyer_entered_utr }
 */
exports.verifyUtr = async (req, res) => {
  try {
    const orderId = Number(req.body.order_id);
    const utr = String(req.body.buyer_entered_utr || "").trim();

    if (!Number.isFinite(orderId))
      return res.status(400).json({ ok: false, error: "order_id required" });
    if (!/^\d{12}$/.test(utr))
      return res.status(400).json({
        ok: false,
        error: "Enter a valid 12-digit UTR",
        ...uiDirective("RETRY_MODAL"),
      });

    const outcome = await tx(async (client) => {
      const { rows: orders } = await client.query(
        `SELECT * FROM orders_db WHERE id = $1 FOR UPDATE`,
        [orderId]
      );
      const order = orders[0];
      if (!order) return { http: 404, body: { ok: false, error: "Order not found" } };

      if (order.status === "SUCCESS")
        return {
          http: 200,
          body: {
            ok: true,
            status: "SUCCESS",
            idempotent: true,
            order_id: order.id,
            credited_amount: money(order.payable_amount),
            ...uiDirective("SUCCESS_BANNER"),
          },
        };

      if (order.status === "FAILED")
        return {
          http: 200,
          body: { ok: false, status: "FAILED", order_id: order.id, ...uiDirective("PERMANENT_FAIL_MODAL") },
        };

      if (new Date(order.expires_at).getTime() < Date.now()) {
        await client.query(`UPDATE orders_db SET status='FAILED' WHERE id=$1`, [order.id]);
        return {
          http: 200,
          body: { ok: false, status: "FAILED", order_id: order.id, ...uiDirective("EXPIRED_MODAL") },
        };
      }

      // (a) Atomically claim a matching UNUSED bank credit for this exact amount.
      const { rows: claimed } = await client.query(
        `UPDATE bank_transactions_db
            SET status = 'USED'
          WHERE id = (
              SELECT id FROM bank_transactions_db
               WHERE utr_number = $1
                 AND amount = $2
                 AND status = 'UNUSED'
               FOR UPDATE SKIP LOCKED
               LIMIT 1)
        RETURNING id, utr_number, amount, sender_name`,
        [utr, money(order.payable_amount)]
      );

      // (b) SUCCESS
      if (claimed.length) {
        await client.query(
          `UPDATE orders_db SET status='SUCCESS', utr_number=$2 WHERE id=$1`,
          [order.id, utr]
        );
        await client.query(
          `INSERT INTO wallets (user_id, balance)
           VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET balance = wallets.balance + EXCLUDED.balance`,
          [order.user_id, money(order.payable_amount)]
        );
        return {
          http: 200,
          body: {
            ok: true,
            status: "SUCCESS",
            order_id: order.id,
            utr_number: utr,
            credited_amount: money(order.payable_amount),
            sender_name: claimed[0].sender_name,
            ...uiDirective("SUCCESS_BANNER"),
          },
        };
      }

      // (c) FAILED MATCH -> retry ladder
      const { rows: bumped } = await client.query(
        `UPDATE orders_db
            SET retry_count = retry_count + 1,
                status = CASE WHEN retry_count + 1 >= $2 THEN 'FAILED' ELSE status END
          WHERE id = $1
        RETURNING retry_count, status`,
        [order.id, MAX_RETRIES]
      );
      const retryCount = bumped[0].retry_count;

      if (retryCount >= MAX_RETRIES) {
        return {
          http: 200,
          body: {
            ok: false,
            status: "FAILED",
            order_id: order.id,
            retry_count: retryCount,
            can_retry: false,
            ...uiDirective("PERMANENT_FAIL_MODAL"),
          },
        };
      }

      return {
        http: 200,
        body: {
          ok: false,
          status: "PENDING",
          order_id: order.id,
          retry_count: retryCount,
          can_retry: true,
          ...uiDirective("RETRY_MODAL"),
        },
      };
    });

    return res.status(outcome.http).json(outcome.body);
  } catch (err) {
    console.error("[verify-utr]", err);
    return res.status(500).json({ ok: false, error: "Verification failed" });
  }
};

/* ------------------------------ 4. AI SCREENSHOT FORENSICS & OCR GATEWAY */

function decodeImage(input) {
  const raw = String(input || "");
  const b64 = raw.includes(",") ? raw.split(",").pop() : raw;
  return Buffer.from(b64, "base64");
}

/** Error Level Analysis: recompress at q90 and measure residual energy. */
async function errorLevelAnalysis(buffer) {
  const base = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
  const a = await sharp(buffer).greyscale().resize(512, 512, { fit: "fill" }).raw().toBuffer();
  const b = await sharp(base).greyscale().resize(512, 512, { fit: "fill" }).raw().toBuffer();

  let sum = 0;
  let peak = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > peak) peak = d;
  }
  const mean = sum / a.length;
  // Splices/edited text regions produce isolated high-energy blocks: high peak
  // against a low global mean.
  return { meanError: Number(mean.toFixed(3)), peakError: peak, spliceRatio: Number((peak / (mean + 1)).toFixed(2)) };
}

async function detectEditorMetadata(buffer) {
  const meta = await sharp(buffer).metadata();
  const blob = [
    meta.exif && meta.exif.toString("latin1"),
    meta.xmp && meta.xmp.toString("latin1"),
    meta.iptc && meta.iptc.toString("latin1"),
  ]
    .filter(Boolean)
    .join(" ");
  const editors = ["canva", "photoshop", "adobe", "gimp", "pixlr", "picsart", "snapseed", "figma", "lightroom"];
  const hits = editors.filter((e) => blob.toLowerCase().includes(e));
  return { editors: hits, hasMetadata: Boolean(blob) };
}

/**
 * POST /api/v1/orders/ocr-check   { order_id?, image_base64 }
 * Parses UTR / date / amount and rejects manipulated receipts.
 */
exports.ocrCheck = async (req, res) => {
  try {
    const buffer = decodeImage(req.body.image_base64 || req.body.screenshot);
    if (!buffer.length || buffer.length > 8 * 1024 * 1024)
      return res.status(400).json({ ok: false, error: "Image missing or larger than 8MB" });

    const [ela, metaScan, ocr] = await Promise.all([
      errorLevelAnalysis(buffer),
      detectEditorMetadata(buffer),
      Tesseract.recognize(buffer, "eng").then((r) => r.data.text || ""),
    ]);

    const text = ocr.replace(/\s+/g, " ");
    const utrMatch =
      text.match(/(?:UTR|RRN|UPI\s*Ref(?:erence)?(?:\s*No)?)[^\d]{0,12}(\d{12})/i) ||
      text.match(/\b(\d{12})\b/);
    const amountMatch = text.match(/(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)/i);
    const dateMatch =
      text.match(/\b(\d{1,2}\s+[A-Za-z]{3,9},?\s+\d{4})\b/) ||
      text.match(/\b(\d{2}[\/-]\d{2}[\/-]\d{2,4})\b/);

    const reasons = [];
    if (metaScan.editors.length) reasons.push(`Image metadata shows editing software: ${metaScan.editors.join(", ")}`);
    if (ela.spliceRatio > 45 && ela.meanError < 4) reasons.push("Error Level Analysis detected spliced/retouched regions");
    if (!utrMatch) reasons.push("No 12-digit UTR could be read from this receipt");

    const authentic = reasons.length === 0;

    return res.status(200).json({
      ok: true,
      authentic,
      rejected: !authentic,
      rejection_reasons: reasons,
      forensics: { ...ela, ...metaScan },
      extracted: {
        utr: utrMatch ? utrMatch[1] : null,
        amount: amountMatch ? money(amountMatch[1].replace(/,/g, "")) : null,
        date: dateMatch ? dateMatch[1] : null,
      },
      ui: authentic ? "PREFILL" : "MODAL",
      title: authentic ? "Receipt Verified" : "Receipt Rejected",
      message: authentic
        ? "Payment receipt looks authentic. UTR auto-filled."
        : reasons.join(". "),
      buttons: ["Close"],
    });
  } catch (err) {
    console.error("[ocr-check]", err);
    return res.status(500).json({ ok: false, error: "OCR processing failed" });
  }
};

exports._internal = { uiDirective, errorLevelAnalysis, detectEditorMetadata, pool };
