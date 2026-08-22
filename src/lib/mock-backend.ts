/**
 * Temporary in-memory mock backend for Crazy Pay.
 *
 * Toggle with VITE_USE_MOCK_BACKEND / USE_MOCK_BACKEND ("false" disables).
 * When disabled — or when a path isn't mocked — the request falls through to
 * the real Cloud Run backend proxy, so no code changes are needed after deploy.
 */

export const ALLOWED_SLOTS = [100, 200, 300, 400, 500, 1000, 2000, 5000];
const MIN_SLOT = 100;
const SLOT_UNITS = [500, 200, 100];

export function mockEnabled(): boolean {
  const raw =
    (typeof process !== "undefined" ? process.env?.["USE_MOCK_BACKEND"] : undefined) ??
    import.meta.env?.['VITE_USE_MOCK_BACKEND'];
  return String(raw ?? "true").toLowerCase() !== "false";
}

export function isValidSlotAmount(v: unknown): boolean {
  const n = Number(v);
  return Number.isInteger(n) && n % MIN_SLOT === 0 && ALLOWED_SLOTS.includes(n);
}

export function validateSlotAmount(v: unknown): string | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return "Amount must be a number";
  if (!isValidSlotAmount(n))
    return `Invalid amount ₹${v}. Only rounded slots allowed: ${ALLOWED_SLOTS.join(", ")}`;
  return null;
}

export function buildSellingBreakdown(balance: number) {
  const bal = Number(balance || 0);
  const sellable = Math.floor(bal / MIN_SLOT) * MIN_SLOT;
  const remainder = Number((bal - sellable).toFixed(2));
  const chunks: number[] = [];
  let left = sellable;
  for (const unit of SLOT_UNITS) {
    while (left >= unit) {
      chunks.push(unit);
      left -= unit;
    }
  }
  return { chunks, sellable, remainder };
}

type Order = {
  id: string;
  userId: string;
  amount: number;
  provider: string | null;
  upiId: string | null;
  sellerName?: string;
  status: string;
  totalPayable: number;
  rewardPercent?: number;
  gateway?: string | null;
  ledgerWritten?: boolean;
  createdAt: number;
};

type LedgerRow = {
  id: string;
  orderId: string;
  type: string;
  amount: number;
  totalPayable: number;
  gateway: string | null;
  utr: string | null;
  status: string;
  createdAt: number;
};

type Store = {
  orders: Map<string, Order>;
  wallets: Map<string, number>;
  ledger: Map<string, LedgerRow[]>;
  seq: number;
};

let store: Store | undefined;

function getStore(): Store {
  if (store) return store;
  const s: Store = { orders: new Map(), wallets: new Map(), ledger: new Map(), seq: 0 };
  const now = Date.now();
  // Seed test ads so Mobikwik + Freecharge render immediately.
  const seed: Array<[string, number, string, string]> = [
    ["seller_mbk", 500, "Mobikwik Recharge", "crazypay.mbk@ikwik"],
    ["seller_mbk", 200, "Mobikwik Recharge", "crazypay.mbk@ikwik"],
    ["seller_fc", 500, "Freecharge Recharge", "crazypay.fc@freecharge"],
    ["seller_fc", 100, "Freecharge Recharge", "crazypay.fc@freecharge"],
  ];
  seed.forEach(([userId, amount, provider, upiId], i) => {
    const id = `seed_${i + 1}`;
    s.orders.set(id, {
      id,
      userId,
      amount,
      provider,
      upiId,
      sellerName: "CRAZY PAY MERCHANT",
      status: "AVAILABLE",
      totalPayable: amount,
      createdAt: now - i * 1000,
    });
  });
  s.wallets.set("seller_mbk", 700);
  s.wallets.set("seller_fc", 600);
  store = s;
  return s;
}

function nextId(prefix: string) {
  const s = getStore();
  s.seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${s.seq}`;
}

const GATEWAYS = [
  { id: "mobikwik", label: "Mobikwik Recharge", match: /(mobi\s*kwik|mbk|ikwik)/i, pkg: "com.mobikwik_new" },
  { id: "freecharge", label: "Freecharge Recharge", match: /(free\s*charge|fcharge|fbl)/i, pkg: "com.freecharge.android" },
  { id: "paytm", label: "Paytm Recharge", match: /paytm|ptm/i, pkg: "net.one97.paytm" },
  { id: "phonepe", label: "PhonePe Recharge", match: /(phone\s*pe|ybl|ibl|axl)/i, pkg: "com.phonepe.app" },
];

const ACTIVE = ["AVAILABLE", "ACTIVE", "PENDING", "OPEN", "LIVE", "READY"];
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const walletOf = (uid: string) => getStore().wallets.get(uid) ?? 0;

/** Returns a Response when the path is mocked, otherwise null (fall through to proxy). */
export async function handleMock(request: Request): Promise<Response | null> {
  if (!mockEnabled()) return null;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const s = getStore();
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? {}
      : await request.json().catch(() => ({}));
  const b = body as Record<string, unknown>;

  // 1. Dynamic gateway detection from active ads
  if (path === "/api/gateways/active") {
    const amount = url.searchParams.get("amount");
    const wanted = amount ? Number(amount) : NaN;
    const ads = [...s.orders.values()].filter(
      (o) =>
        ACTIVE.includes(o.status) &&
        String(o.upiId || "").includes("@") &&
        (!Number.isFinite(wanted) || o.amount >= wanted),
    );
    const gateways = GATEWAYS.map((g) => {
      const mine = ads.filter((o) => g.match.test(`${o.provider} ${o.upiId}`));
      return mine.length
        ? { id: g.id, label: g.label, enabled: true, adCount: mine.length, orderIds: mine.map((a) => a.id) }
        : null;
    }).filter(Boolean);
    return json({ ok: true, mock: true, gateways, scanned: ads.length });
  }

  // 2. Wallet balance + split selling breakdown
  const bd = path.match(/^\/api\/wallet\/([^/]+)\/selling-breakdown$/);
  if (bd) {
    const balance = walletOf(decodeURIComponent(bd[1]!));
    return json({ ok: true, mock: true, balance, ...buildSellingBreakdown(balance) });
  }

  // Order creation guarded by wallet balance
  if (path === "/api/orders/create" && request.method === "POST") {
    const userId = String(b['userId'] || "").trim();
    if (!userId) return json({ ok: false, error: "userId required" }, 400);
    const err = validateSlotAmount(b['amount']);
    if (err) return json({ ok: false, error: err, allowedSlots: ALLOWED_SLOTS }, 400);

    const requested = Number(b['amount']);
    const availableBalance = walletOf(userId);
    const activeLocked = [...s.orders.values()]
      .filter((o) => o.userId === userId && ACTIVE.concat("IN_TRANSACTION", "PROCESSING").includes(o.status))
      .reduce((sum, o) => sum + o.amount, 0);

    if (requested + activeLocked > availableBalance) {
      return json(
        {
          ok: false,
          error: `Insufficient wallet balance. Available ₹${availableBalance}, requested ₹${requested}`,
          requested,
          activeLocked,
          totalExposure: requested + activeLocked,
          availableBalance,
        },
        400,
      );
    }

    s.wallets.set(userId, availableBalance - requested);
    const id = nextId("ord");
    const order: Order = {
      id,
      userId,
      amount: requested,
      provider: (b['provider'] as string) || null,
      upiId: (b['upiId'] as string) || null,
      sellerName: (b['sellerName'] as string) || "CRAZY PAY MERCHANT",
      status: "AVAILABLE",
      totalPayable: requested,
      rewardPercent: Number(b['rewardPercent'] || 0),
      createdAt: Date.now(),
    };
    s.orders.set(id, order);
    return json({ ok: true, mock: true, orderId: id, order, walletBalance: s.wallets.get(userId) });
  }

  // User-scoped queries
  const mine = path.match(/^\/api\/orders\/mine\/([^/]+)$/);
  if (mine) {
    const uid = decodeURIComponent(mine[1]!);
    return json({ ok: true, mock: true, orders: [...s.orders.values()].filter((o) => o.userId === uid) });
  }

  if (path === "/api/orders/market") {
    const uid = String(url.searchParams.get("userId") || "").trim();
    const orders = [...s.orders.values()].filter(
      (o) => ACTIVE.includes(o.status) && isValidSlotAmount(o.amount) && o.userId !== uid,
    );
    return json({ ok: true, mock: true, orders, allowedSlots: ALLOWED_SLOTS });
  }

  const inTx = path.match(/^\/api\/orders\/in-transaction\/([^/]+)$/);
  if (inTx) {
    const uid = decodeURIComponent(inTx[1]!);
    const rows = [...s.orders.values()]
      .filter((o) => o.userId === uid && ["PENDING", "IN_TRANSACTION", "PROCESSING"].includes(o.status))
      .map((o) => {
        const payable = Number((o.amount + (o.amount * Number(o.rewardPercent || 0)) / 100).toFixed(2));
        return { ...o, totalPayable: payable };
      });
    return json({
      ok: true,
      mock: true,
      orders: rows,
      totalPayable: Number(rows.reduce((t, r) => t + r.totalPayable, 0).toFixed(2)),
    });
  }

  // 3. Payment initiation -> real redirect URL
  if (path === "/api/payments/initiate" && request.method === "POST") {
    const orderId = String(b['orderId'] || "");
    const order = s.orders.get(orderId);
    if (!order) return json({ ok: false, error: "Order not found" }, 404);
    if (!String(order.upiId || "").includes("@"))
      return json({ ok: false, error: "Seller has no valid UPI on this ad" }, 409);

    const key = String(b['gateway'] || order.provider || "");
    const g = GATEWAYS.find((x) => x.id === key.toLowerCase() || x.match.test(key));
    const q =
      `pa=${encodeURIComponent(order.upiId!)}` +
      `&pn=${encodeURIComponent(order.sellerName || "CRAZY PAY MERCHANT")}` +
      `&am=${order.amount.toFixed(2)}&tr=${orderId}&tn=${orderId}&cu=INR`;
    const paymentUrl = g
      ? `intent://pay?${q}#Intent;scheme=upi;package=${g.pkg};S.browser_fallback_url=https://play.google.com/store/apps/details?id=${g.pkg};end`
      : `upi://pay?${q}`;

    order.status = "IN_TRANSACTION";
    order.gateway = g ? g.id : null;
    return json({ ok: true, mock: true, paymentUrl, orderId, amount: order.amount });
  }

  // UTR verify + webhook -> instant Sale Ledger credit
  if ((path === "/api/payments/webhook" || path === "/api/utr/verify") && request.method === "POST") {
    const orderId = String(b['orderId'] || "");
    const order = s.orders.get(orderId);
    if (!order) return json({ ok: false, error: "Order not found" }, 404);

    const status = String(b['status'] || "SUCCESS").toUpperCase();
    const success = path === "/api/utr/verify" || ["SUCCESS", "PAID", "COMPLETED"].includes(status);
    if (!success) {
      order.status = "FAILED";
      s.wallets.set(order.userId, walletOf(order.userId) + order.amount);
      return json({ ok: true, mock: true, credited: false });
    }
    if (order.ledgerWritten) return json({ ok: true, mock: true, credited: true, idempotent: true });

    const row: LedgerRow = {
      id: nextId("led"),
      orderId,
      type: "SELL",
      amount: order.amount,
      totalPayable: order.totalPayable || order.amount,
      gateway: order.gateway || order.provider || null,
      utr: (b['utr'] as string) || null,
      status: "CREDITED",
      createdAt: Date.now(),
    };
    const rows = s.ledger.get(order.userId) ?? [];
    rows.unshift(row);
    s.ledger.set(order.userId, rows);
    order.status = "COMPLETED";
    order.ledgerWritten = true;
    return json({ ok: true, mock: true, credited: true, ledgerId: row.id, entry: row });
  }

  const led = path.match(/^\/api\/sale-ledger\/([^/]+)$/);
  if (led) {
    const rows = s.ledger.get(decodeURIComponent(led[1]!)) ?? [];
    return json({
      ok: true,
      mock: true,
      entries: rows,
      total: rows.reduce((t, r) => t + r.amount, 0),
    });
  }


  // ===================== AUTO-SYSTEM AUTO-UTR ENGINE (v1) =====================
  const v1 = getUtrStore();

  // Module 1: system automated discounted order creation (0.01 - 0.99 paisa)
  if (path === "/api/v1/orders/auto-create" && request.method === "POST") {
    const userId = String(b['user_id'] || "").trim();
    const baseAmount = Number(b['base_amount']);
    if (!userId) return json({ ok: false, error: "user_id required" }, 400);
    if (!Number.isFinite(baseAmount) || baseAmount < 1)
      return json({ ok: false, error: "Invalid base_amount" }, 400);

    expireStaleUtrOrders();
    const taken = new Set(
      [...v1.orders.values()]
        .filter((o) => o.baseAmount === baseAmount && o.status === "PENDING")
        .map((o) => o.discountPaisa),
    );
    if (taken.size >= 99)
      return json({ ok: false, error: "All 99 payment slots for this amount are busy. Try again shortly." }, 429);

    const free: number[] = [];
    for (let p = 1; p <= 99; p += 1) if (!taken.has(p)) free.push(p);
    const discountPaisa = free[Math.floor(Math.random() * free.length)]!;
    const payable = Number((baseAmount - discountPaisa / 100).toFixed(2));
    const id = nextId("v1ord");
    v1.orders.set(id, {
      id, userId, baseAmount, discountPaisa, payableAmount: payable,
      status: "PENDING", retryCount: 0, utrNumber: null,
      createdAt: Date.now(), expiresAt: Date.now() + 15 * 60 * 1000,
    });
    return json({
      ok: true, order_id: id, base_amount: baseAmount, discount_paisa: discountPaisa,
      payable_amount: payable, status: "PENDING", retry_count: 0,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      expires_in_seconds: 900, active_slots: taken.size + 1,
    }, 201);
  }

  // Module 2: bank statement / SMS ingestion (unique per UTR)
  if (path === "/api/v1/bank-transactions/webhook" && request.method === "POST") {
    const utr = String(b['utr_number'] || "").trim();
    const amount = Number(b['amount']);
    if (!/^\d{12}$/.test(utr)) return json({ ok: false, error: "utr_number must be 12 digits" }, 400);
    if (!Number.isFinite(amount) || amount <= 0) return json({ ok: false, error: "Invalid amount" }, 400);
    if (v1.bank.has(utr)) return json({ ok: true, ingested: false, duplicate: true });
    v1.bank.set(utr, {
      utrNumber: utr, amount: Number(amount.toFixed(2)),
      senderName: (b['sender_name'] as string) || null, status: "UNUSED", createdAt: Date.now(),
    });
    return json({ ok: true, ingested: true, duplicate: false, id: utr });
  }

  // Module 3: auto-matching + retry ladder + UI directives
  if (path === "/api/v1/orders/verify-utr" && request.method === "POST") {
    const orderId = String(b['order_id'] || "");
    const utr = String(b['buyer_entered_utr'] || "").trim();
    const order = v1.orders.get(orderId);
    if (!order) return json({ ok: false, error: "Order not found" }, 404);
    if (!/^\d{12}$/.test(utr))
      return json({ ok: false, status: order.status, ...UI_RETRY, error: "Enter a valid 12-digit UTR" });

    if (order.status === "SUCCESS")
      return json({ ok: true, status: "SUCCESS", idempotent: true, order_id: orderId,
        credited_amount: order.payableAmount, ...UI_SUCCESS });
    if (order.status === "FAILED")
      return json({ ok: false, status: "FAILED", order_id: orderId, can_retry: false, ...UI_PERMANENT });
    if (order.expiresAt < Date.now()) {
      order.status = "FAILED";
      return json({ ok: false, status: "FAILED", order_id: orderId, can_retry: false, ...UI_EXPIRED });
    }

    const credit = v1.bank.get(utr);
    if (credit && credit.status === "UNUSED" && credit.amount === order.payableAmount) {
      credit.status = "USED";
      order.status = "SUCCESS";
      order.utrNumber = utr;
      s.wallets.set(order.userId, (s.wallets.get(order.userId) ?? 0) + order.payableAmount);
      return json({ ok: true, status: "SUCCESS", order_id: orderId, utr_number: utr,
        credited_amount: order.payableAmount, sender_name: credit.senderName, ...UI_SUCCESS });
    }

    order.retryCount += 1;
    if (order.retryCount >= 2) {
      order.status = "FAILED";
      return json({ ok: false, status: "FAILED", order_id: orderId, retry_count: order.retryCount,
        can_retry: false, ...UI_PERMANENT });
    }
    return json({ ok: false, status: "PENDING", order_id: orderId, retry_count: order.retryCount,
      can_retry: true, ...UI_RETRY });
  }

  // Module 4: OCR + forensics gateway (server-side OCR runs on the Node deploy;
  // in preview we parse any text payload and screen obvious editor metadata).
  if (path === "/api/v1/orders/ocr-check" && request.method === "POST") {
    const img = String(b['image_base64'] || "");
    if (!img) return json({ ok: false, error: "Image missing" }, 400);
    const name = String(b['filename'] || "").toLowerCase();
    const editors = ["canva", "photoshop", "psd", "picsart", "edited"].filter((e) => name.includes(e));
    if (editors.length) {
      return json({ ok: true, authentic: false, rejected: true,
        rejection_reasons: [`Image metadata shows editing software: ${editors.join(", ")}`],
        extracted: {}, ui: "MODAL", title: "Receipt Rejected",
        message: `This receipt appears edited (${editors.join(", ")}) and cannot be accepted.`,
        buttons: ["Close"] });
    }
    const text = String(b['ocr_text'] || "");
    const utr = text.match(/\b(\d{12})\b/);
    return json({ ok: true, authentic: true, rejected: false, rejection_reasons: [],
      extracted: { utr: utr ? utr[1] : null, amount: null, date: null },
      ui: "PREFILL", title: "Receipt Verified",
      message: "Payment receipt looks authentic.", buttons: ["Close"] });
  }

  return null;
}

/* ------------------------- Auto-UTR engine in-memory store ---------------- */

type UtrOrder = {
  id: string; userId: string; baseAmount: number; discountPaisa: number;
  payableAmount: number; status: "PENDING" | "SUCCESS" | "FAILED";
  retryCount: number; utrNumber: string | null; createdAt: number; expiresAt: number;
};
type BankTx = {
  utrNumber: string; amount: number; senderName: string | null;
  status: "UNUSED" | "USED"; createdAt: number;
};

let utrStore: { orders: Map<string, UtrOrder>; bank: Map<string, BankTx> } | undefined;

function getUtrStore() {
  if (!utrStore) utrStore = { orders: new Map(), bank: new Map() };
  return utrStore;
}

function expireStaleUtrOrders() {
  const now = Date.now();
  for (const o of getUtrStore().orders.values()) {
    if (o.status === "PENDING" && o.expiresAt < now) o.status = "FAILED";
  }
}

const UI_SUCCESS = { ui: "BANNER", variant: "SUCCESS", title: "Your Order Was Successful", buttons: ["Close"] };
const UI_RETRY = { ui: "MODAL", variant: "WARNING", title: "Your Order Was Unsuccessful",
  message: "Your UTR Was Wrong or Already Used", buttons: ["Last Try", "Close"] };
const UI_PERMANENT = { ui: "MODAL", variant: "ERROR", title: "Order Permanently Failed",
  message: "This order has been closed after 2 failed verification attempts.", buttons: ["Close"] };
const UI_EXPIRED = { ui: "MODAL", variant: "ERROR", title: "Order Expired",
  message: "The 15-minute payment window for this order has elapsed.", buttons: ["Close"] };
