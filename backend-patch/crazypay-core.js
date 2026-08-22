/**
 * Crazy Pay — backend core fixes (drop into your Cloud Run repo).
 *
 * Usage in server.js:
 *   const admin = require('firebase-admin');            // already initialised there
 *   const attachCoreRoutes = require('./crazypay-core');
 *   attachCoreRoutes(app, admin);                       // after app/bodyParser setup
 *
 * Assumes Firebase Realtime Database with:
 *   p2p_orders/{orderId}      { userId, provider, upiId, amount, status, ... }
 *   users/{uid}/wallet        { balance }
 *   sale_ledger/{uid}/{txnId} { ... }
 */

const SLOT_UNITS = [500, 200, 100];
const MIN_SLOT = 100;
const ACTIVE_STATUSES = [
  'AVAILABLE', 'ACTIVE', 'PENDING', 'OPEN', 'LIVE', 'IN_MARKET', 'WAITING', 'NEW', 'READY',
];


const GATEWAYS = {
  mobikwik: {
    id: 'mobikwik',
    label: 'Mobikwik Recharge',
    match: /(mobi\s*kwik|mobikwik|mbk|mkwik)/i,
    vpa: /@(ikwik|mbk|mobikwik)/i,
  },
  freecharge: {
    id: 'freecharge',
    label: 'Freecharge Recharge',
    match: /(free\s*charge|freecharge|fcharge)/i,
    vpa: /@(freecharge|fbl|fcharge)/i,
  },
  paytm: { id: 'paytm', label: 'Paytm Recharge', match: /paytm/i, vpa: /@(paytm|ptm|ptyes|ptaxis|pthdfc|ptsbi)/i },
  phonepe: { id: 'phonepe', label: 'PhonePe Recharge', match: /(phone\s*pe|phonepe)/i, vpa: /@(ybl|ibl|axl)/i },
};

// Ads live under several paths / statuses depending on how they were created.
const AD_PATHS = ['p2p_orders', 'p2p_ads', 'upi_ads', 'market_ads'];

const isActive = (o) => {
  if (!o || o.deleted === true || o.isDeleted === true || o.active === false) return false;
  const raw = String(o.status ?? o.state ?? o.orderStatus ?? '').trim().toUpperCase();
  if (!raw) return true; // legacy ads saved without a status are still live
  return ACTIVE_STATUSES.includes(raw.replace(/[\s-]+/g, '_'));
};


// ---- Part 3: strict slot validation ------------------------------------
// Only these rounded slot values may ever be created / traded.
const ALLOWED_SLOTS = [100, 200, 300, 400, 500, 1000, 2000, 5000];
const MAX_SLOT = Math.max(...ALLOWED_SLOTS);

const isValidSlotAmount = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return false;
  if (n < MIN_SLOT || n > MAX_SLOT) return false;
  if (n % MIN_SLOT !== 0) return false;         // kills 135, 684, 99.5 ...
  return ALLOWED_SLOTS.includes(n);
};

/** Returns null when valid, else a human error string. */
function validateSlotAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 'Amount must be a number';
  if (!Number.isInteger(n) || n % MIN_SLOT !== 0)
    return `Invalid amount ₹${v}. Only rounded slots allowed: ${ALLOWED_SLOTS.join(', ')}`;
  if (!ALLOWED_SLOTS.includes(n))
    return `Amount ₹${n} is not an allowed slot. Allowed: ${ALLOWED_SLOTS.join(', ')}`;
  return null;
}

/** A ghost order = invalid amount, no owner, or soft-deleted junk row. */
const isGhostOrder = (o) =>
  !o ||
  !o.userId ||
  typeof o.userId !== 'string' ||
  !isValidSlotAmount(o.amount) ||
  o.deleted === true ||
  o.isDeleted === true;


/** ₹789 -> { chunks:[500,200], sellable:700, remainder:89 } */
function buildSellingBreakdown(balance) {
  let sellable = Math.floor(Number(balance || 0) / MIN_SLOT) * MIN_SLOT;
  const remainder = Number(balance || 0) - sellable;
  const chunks = [];
  let left = sellable;
  for (const unit of SLOT_UNITS) {
    while (left >= unit) {
      chunks.push(unit);
      left -= unit;
    }
  }
  return { chunks, sellable, remainder: Number(remainder.toFixed(2)) };
}

module.exports = function attachCoreRoutes(app, admin) {
  const db = admin.database();
  const ordersRef = () => db.ref('p2p_orders');
  const walletRef = (uid) => db.ref(`users/${uid}/wallet/balance`);

  const readBalance = async (uid) => Number((await walletRef(uid).once('value')).val() || 0);

  // Scans every known ad path, not just p2p_orders (this was the bug behind
  // "No UPI added for Buy" while live Mobikwik ads existed).
  const listActiveOrders = async () => {
    const out = [];
    const seen = new Set();
    const snaps = await Promise.all(
      AD_PATHS.map((p) => db.ref(p).once('value').catch(() => null)),
    );
    snaps.forEach((snap, i) => {
      if (!snap) return;
      snap.forEach((c) => {
        const o = c.val();
        if (!o || typeof o !== 'object') return;
        const key = `${AD_PATHS[i]}/${c.key}`;
        if (seen.has(key) || !isActive(o)) return;
        seen.add(key);
        out.push({ id: c.key, source: AD_PATHS[i], ...o });
      });
    });
    return out;
  };

  // Everything an ad might carry the app name in.
  const providerOf = (o) =>
    [
      o.provider, o.gateway, o.upiId, o.upi, o.vpa, o.upiApp, o.upi_app,
      o.paymentMethod, o.payment_method, o.app, o.appName, o.method,
      o.title, o.note, o.remark, o.tags,
    ]
      .filter((v) => typeof v === 'string' || typeof v === 'number')
      .join(' ');

  const adMatchesGateway = (o, g) => {
    const hay = providerOf(o);
    return g.match.test(hay) || (g.vpa && g.vpa.test(hay));
  };

  const hasUsableUpi = (o) => {
    const vpa = String(o.upiId || o.upi || o.vpa || '').trim();
    return vpa.includes('@');
  };

  /* 1. Dynamic gateways — derived from real active ads in DB ------------- */
  app.get('/api/gateways/active', async (req, res) => {
    try {
      const amount = req.query.amount ? Number(req.query.amount) : null;
      const all = await listActiveOrders();
      // Amount filter is a capacity check (ad can cover the request), not an
      // exact-equality check — exact match was hiding valid ads.
      const orders = all.filter(
        (o) => hasUsableUpi(o) && (!Number.isFinite(amount) || Number(o.amount || 0) >= amount),
      );
      const gateways = Object.values(GATEWAYS)
        .map((g) => {
          const ads = orders.filter((o) => adMatchesGateway(o, g));
          return ads.length
            ? {
                id: g.id,
                label: g.label,
                enabled: true,
                adCount: ads.length,
                orderIds: ads.map((a) => a.id),
              }
            : null; // no active ad -> gateway hidden entirely
        })
        .filter(Boolean);
      res.json({ ok: true, gateways, scanned: all.length });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });


  /* 2 + 5 + 6. Order creation guard ------------------------------------- */
  app.post('/api/orders/create', async (req, res) => {
    const { userId, amount, provider, upiId } = req.body || {};
    if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });
    const slotError = validateSlotAmount(amount);
    if (slotError) return res.status(400).json({ ok: false, error: slotError, allowedSlots: ALLOWED_SLOTS });


    try {
      const requested = Number(amount);

      // 1. Fetch seller's available wallet balance BEFORE creating anything.
      const balanceSnap = await walletRef(userId).once('value');
      const availableBalance = Number(balanceSnap.val() || 0);

      // 2. Sum all ACTIVE selling orders already created by this user so we
      //    enforce: requested + existing_active_orders <= available_balance.
      const activeOrdersSnap = await ordersRef()
        .orderByChild('userId')
        .equalTo(userId)
        .once('value');
      let activeLocked = 0;
      activeOrdersSnap.forEach((c) => {
        const o = c.val() || {};
        const s = String(o.status || '').toUpperCase();
        if (['AVAILABLE', 'ACTIVE', 'PENDING', 'IN_TRANSACTION', 'PROCESSING'].includes(s)) {
          activeLocked += Number(o.amount || 0);
        }
      });

      const totalExposure = requested + activeLocked;
      if (totalExposure > availableBalance) {
        return res.status(400).json({
          ok: false,
          error: 'Insufficient wallet balance',
          requested,
          activeLocked,
          totalExposure,
          availableBalance,
        });
      }

      // 3. Atomic debit — prevents race-condition over-creation under concurrency.
      const ref = walletRef(userId);
      let rejection = null;
      const tx = await ref.transaction((current) => {
        const bal = Number(current || 0);
        if (bal < requested) {
          rejection = `Insufficient balance. Available ₹${bal}, requested ₹${requested}`;
          return; // abort
        }
        return bal - requested;
      });
      if (!tx.committed) return res.status(400).json({ ok: false, error: rejection || 'Balance locked' });

      const orderRef = ordersRef().push();
      const order = {
        userId,
        amount: requested,
        provider: provider || null,
        upiId: upiId || null,
        status: 'AVAILABLE',
        totalPayable: requested,
        createdAt: admin.database.ServerValue.TIMESTAMP,
      };
      await orderRef.set(order);
      res.json({ ok: true, orderId: orderRef.key, order, walletBalance: tx.snapshot.val() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* 6. Split preview: what is sellable vs what stays in wallet ----------- */
  app.get('/api/wallet/:userId/selling-breakdown', async (req, res) => {
    try {
      const balance = await readBalance(req.params.userId);
      res.json({ ok: true, balance, ...buildSellingBreakdown(balance) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* 5. User-scoped queries — no ghost/invalid leakage -------------------- */
  app.get('/api/orders/mine/:userId', async (req, res) => {
    const uid = String(req.params.userId || '').trim();
    if (!uid) return res.status(400).json({ ok: false, error: 'userId required' });
    try {
      const all = await listActiveOrders();
      // strict owner scoping + ghost filter -> no cross-account leakage
      const mine = all.filter((o) => !isGhostOrder(o) && String(o.userId) === uid);
      res.json({ ok: true, orders: mine });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/orders/market', async (req, res) => {
    const uid = String(req.query.userId || '').trim();
    if (!uid) return res.status(400).json({ ok: false, error: 'userId required' });
    try {
      const all = await listActiveOrders();
      const orders = all.filter((o) => !isGhostOrder(o) && String(o.userId) !== uid);
      const hidden = all.length - orders.length;
      res.json({ ok: true, orders, hiddenInvalid: hidden, allowedSlots: ALLOWED_SLOTS });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });


  /* 6. In-transaction payload with exact total payable ------------------- */
  app.get('/api/orders/in-transaction/:userId', async (req, res) => {
    try {
      const snap = await ordersRef().orderByChild('userId').equalTo(req.params.userId).once('value');
      const rows = [];
      let totalPayable = 0;
      snap.forEach((c) => {
        const o = c.val() || {};
        if (isGhostOrder(o) || String(o.userId) !== String(req.params.userId)) return;
        if (['PENDING', 'IN_TRANSACTION', 'PROCESSING'].includes(String(o.status || '').toUpperCase())) {
          const base = Number(o.amount || 0);
          const fee = Number(o.rewardPercent || 0) / 100 * base;
          const payable = Number((base + fee).toFixed(2));
          totalPayable += payable;
          rows.push({ id: c.key, ...o, totalPayable: payable });
        }
      });
      res.json({ ok: true, orders: rows, totalPayable: Number(totalPayable.toFixed(2)) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* 3. Gateway payment initiation — returns a real paymentUrl ------------ */
  app.post('/api/payments/initiate', async (req, res) => {
    const { orderId, gateway } = req.body || {};
    if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });
    try {
      const snap = await ordersRef().child(orderId).once('value');
      const order = snap.val();
      if (!order) return res.status(404).json({ ok: false, error: 'Order not found' });
      if (!order.upiId || !String(order.upiId).includes('@'))
        return res.status(409).json({ ok: false, error: 'Seller has no valid UPI on this ad' });
      if (!isValidSlotAmount(order.amount))
        return res.status(400).json({ ok: false, error: 'Invalid order amount' });

      const g = GATEWAYS[String(gateway || order.provider || '').toLowerCase()] || null;
      const pkg = {
        mobikwik: 'com.mobikwik_new',
        freecharge: 'com.freecharge.android',
        paytm: 'net.one97.paytm',
        phonepe: 'com.phonepe.app',
      }[g && g.id];

      const q =
        `pa=${encodeURIComponent(order.upiId)}` +
        `&pn=${encodeURIComponent(order.sellerName || 'CRAZY PAY MERCHANT')}` +
        `&am=${Number(order.amount).toFixed(2)}&tr=${orderId}&tn=${orderId}&cu=INR`;

      const paymentUrl = pkg
        ? `intent://pay?${q}#Intent;scheme=upi;package=${pkg};S.browser_fallback_url=https://play.google.com/store/apps/details?id=${pkg};end`
        : `upi://pay?${q}`;

      await ordersRef().child(orderId).update({ status: 'IN_TRANSACTION', gateway: g ? g.id : null });
      res.json({ ok: true, paymentUrl, orderId, amount: Number(order.amount) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* 4. Payment success webhook -> Sale Ledger write ---------------------- */
  app.post('/api/payments/webhook', async (req, res) => {
    const { orderId, status, utr, txnId } = req.body || {};
    if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });
    try {
      const oRef = ordersRef().child(orderId);
      const order = (await oRef.once('value')).val();
      if (!order) return res.status(404).json({ ok: false, error: 'Order not found' });

      const success = ['SUCCESS', 'PAID', 'COMPLETED'].includes(String(status || '').toUpperCase());
      if (!success) {
        await oRef.update({ status: 'FAILED', failedAt: admin.database.ServerValue.TIMESTAMP });
        // refund the reserved balance back to the seller
        await walletRef(order.userId).transaction((b) => Number(b || 0) + Number(order.amount || 0));
        return res.json({ ok: true, credited: false });
      }
      if (order.ledgerWritten) return res.json({ ok: true, credited: true, idempotent: true });

      const amount = Number(order.amount || 0);
      const ledgerRef = db.ref(`sale_ledger/${order.userId}`).push();
      await ledgerRef.set({
        orderId,
        type: 'SELL',
        amount,
        totalPayable: Number(order.totalPayable || amount),
        gateway: order.gateway || order.provider || null,
        utr: utr || null,
        txnId: txnId || ledgerRef.key,
        status: 'CREDITED',
        createdAt: admin.database.ServerValue.TIMESTAMP,
      });
      await oRef.update({
        status: 'COMPLETED',
        ledgerWritten: true,
        completedAt: admin.database.ServerValue.TIMESTAMP,
      });
      res.json({ ok: true, credited: true, ledgerId: ledgerRef.key });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* 4. Sale ledger read -------------------------------------------------- */
  app.get('/api/sale-ledger/:userId', async (req, res) => {
    try {
      const snap = await db.ref(`sale_ledger/${req.params.userId}`).once('value');
      const rows = [];
      snap.forEach((c) => rows.push({ id: c.key, ...c.val() }));
      rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      res.json({ ok: true, entries: rows, total: rows.reduce((s, r) => s + Number(r.amount || 0), 0) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
};

module.exports.helpers = { isValidSlotAmount, validateSlotAmount, isGhostOrder, buildSellingBreakdown, ALLOWED_SLOTS };
