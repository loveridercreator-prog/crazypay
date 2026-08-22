/**
 * CRAZY PAY :: Auto-UTR Engine routes.
 * Mount in server.js:  app.use(require('./src/routes/utrRoutes'));
 *
 * Every legacy UTR route (/api/verify_utr_triple_match, /api/utr/verify,
 * /api/sms-sniff, /api/dispute/escalate) must be DELETED from server.js —
 * these four routes fully replace them.
 */

const express = require("express");
const rateLimit = require("express-rate-limit");
const ctrl = require("../controllers/utrVerificationController");

const router = express.Router();

const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many verification attempts. Slow down." },
});

const ocrLimiter = rateLimit({ windowMs: 60 * 1000, max: 6 });

router.post("/api/v1/orders/auto-create", express.json({ limit: "64kb" }), ctrl.autoCreateOrder);
router.post("/api/v1/bank-transactions/webhook", express.json({ limit: "128kb" }), ctrl.ingestBankTransaction);
router.post("/api/v1/orders/verify-utr", verifyLimiter, express.json({ limit: "64kb" }), ctrl.verifyUtr);
router.post("/api/v1/orders/ocr-check", ocrLimiter, express.json({ limit: "12mb" }), ctrl.ocrCheck);

module.exports = router;
