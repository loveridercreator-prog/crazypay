/**
 * CRAZY PAY :: USDT ROUTES (full rebuild)
 * ---------------------------------------------------------------------------
 * Mount from server.js:
 *
 *   const { attachUsdtRoutes } = require('./src/routes/usdtRoutes');
 *   attachUsdtRoutes(app, admin); // admin = firebase-admin (optional)
 *
 * Any older /api/*usdt* handler must be removed so these take effect.
 */

const express = require("express");
const controller = require("../controllers/usdtController");
const svc = require("../services/usdtSweeperService");

const router = express.Router();

router.post("/create-order", controller.createOrder);
router.get("/check-status", controller.checkStatus);
router.post("/verify-txhash", controller.verifyTxHash);

// Lightweight health probe for the deposit engine.
router.get("/health", (_req, res) =>
  res.json({
    ok: true,
    masterWallets: svc.MASTER_WALLETS,
    contracts: svc.USDT_CONTRACTS,
    note: controller.NETWORK_NOTE,
  })
);

/**
 * Credits the user's live wallet balance in Firebase RTDB when a deposit is
 * confirmed on-chain. Idempotent per order via the usdt_credits marker node.
 */
function makeFirebaseCreditor(admin) {
  return async ({ userId, usdt, inr, orderRef, network, txHash }) => {
    const db = admin.database();
    const uid = String(userId).replace(/[^0-9a-zA-Z_-]/g, "");
    const marker = db.ref(`usdt_credits/${orderRef}`);

    const claimed = await marker.transaction((current) =>
      current === null ? { uid, usdt, inr, network, txHash, at: Date.now() } : undefined
    );
    if (!claimed.committed) return; // already credited

    await db.ref(`users/${uid}/balance`).transaction((b) => Number(b || 0) + inr);
    await db.ref(`users/${uid}/usdtBalance`).transaction((b) => Number(b || 0) + usdt);
    await db.ref(`transactions/${uid}`).push({
      type: "USDT_DEPOSIT",
      network,
      usdt,
      amount: inr,
      status: "Credited",
      orderRef,
      txHash: txHash || null,
      createdAt: Date.now(),
    });
  };
}

/**
 * @param {import('express').Express} app
 * @param {any} [admin] firebase-admin, already initialised
 * @param {{ startWorkers?: boolean }} [options]
 */
function attachUsdtRoutes(app, admin, options = {}) {
  if (admin) {
    controller.setBalanceCreditor(makeFirebaseCreditor(admin));
    systemStatus.attachFirebase(admin);
  }
  systemStatus.attachPool(svc.pool);

  app.use("/api/v1/usdt", express.json({ limit: "256kb" }), router);


  if (options.startWorkers !== false) {
    svc.startUsdtSweeper(controller.creditOrder);
  }
  return router;
}

module.exports = router;
module.exports.router = router;
module.exports.attachUsdtRoutes = attachUsdtRoutes;
module.exports.makeFirebaseCreditor = makeFirebaseCreditor;
