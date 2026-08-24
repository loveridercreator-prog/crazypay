/**
 * CRAZY PAY :: ORDER CREATION ENGINE — routes (full overwrite)
 *
 * Mount in server.js:
 *   const { attachOrderEngine } = require('./src/routes/orderEngineRoutes');
 *   attachOrderEngine(app);
 *
 * PURGE from server.js every legacy order-creation route, e.g.
 *   /api/orders/create, /api/withdraw/split, /api/sell/auto-generate,
 *   /api/v1/orders/auto-create   -> replaced by /api/v1/orders/engine/run
 */

const express = require("express");
const rateLimit = require("express-rate-limit");
const ctrl = require("../controllers/orderEngineController");
const svc = require("../services/orderEngineService");

const router = express.Router();
const json = express.json({ limit: "64kb" });

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many order operations. Slow down." },
});

// Realtime stream first (no body parser, no rate limit).
router.get("/stream", ctrl.stream);

router.post("/engine/run", writeLimiter, json, ctrl.runEngine);
router.get("/available", ctrl.listAvailable);
router.get("/sale-ledger", ctrl.saleLedger);
router.get("/buy-history", ctrl.buyHistory);
router.post("/:id/lock", writeLimiter, json, ctrl.lock);
router.post("/:id/confirm", writeLimiter, json, ctrl.confirm);
router.post("/:id/settle", writeLimiter, json, ctrl.settle);
router.get("/:id", ctrl.getOne);

/**
 * @param {import('express').Express} app
 * @param {{ startSweeper?: boolean, sweepIntervalMs?: number, admin?: any }} [options]
 */
function attachOrderEngine(app, options = {}) {
  if (options.admin) systemStatus.attachFirebase(options.admin);
  systemStatus.attachPool(svc.pool);
  app.use("/api/v1/orders", router);
  if (options.startSweeper !== false) {
    svc.startTimerSweeper(options.sweepIntervalMs || 10000);
  }
  return router;
}


module.exports = router;
module.exports.router = router;
module.exports.attachOrderEngine = attachOrderEngine;
