const DATABASE_URL =
  "https://studio-423535862-617fb-default-rtdb.asia-southeast1.firebasedatabase.app";

type JsonRecord = Record<string, unknown>;

/** Strongly-typed API response payloads shared across handlers. */
interface ApiOk<T extends Record<string, unknown>> extends Record<string, unknown> {
  ok: true;
  data?: T;
}
interface ApiError extends Record<string, unknown> {
  ok: false;
  error: string;
}
interface AutoUtrOrderResponse extends Record<string, unknown> {
  ok: boolean;
  order_id: string;
  base_amount: number;
  discount_paisa: number;
  payable_amount: number;
  status: "PENDING" | "SUCCESS" | "FAILED";
  retry_count: number;
  expires_at: string;
  expires_in_seconds: number;
}
interface VerifyUtrResponse extends Record<string, unknown> {
  ok: boolean;
  status: "PENDING" | "SUCCESS" | "FAILED";
  order_id?: string;
  utr_number?: string;
  credited_amount?: number;
  retry_count?: number;
  can_retry?: boolean;
  title?: string;
  message?: string;
  idempotent?: boolean;
  error?: string;
}
interface UsdtStatusResponse extends Record<string, unknown> {
  success: boolean;
  status?: string;
  receivedAmount?: number;
  inrCredited?: number;
  txHash?: string | null;
  order?: {
    orderId: string;
    network?: string;
    tempAddress?: string;
    masterWallet?: string;
    expectedAmount: number;
    receivedAmount: number;
    status?: string;
    txHash?: string | null;
    expiresAt?: string | number;
  };
  error?: string;
}

const json = (body: ApiOk<Record<string, unknown>> | ApiError | AutoUtrOrderResponse | VerifyUtrResponse | UsdtStatusResponse | Record<string, unknown>, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

async function readNode<T>(path: string): Promise<T | null> {
  const response = await fetch(`${DATABASE_URL}/${path}.json`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Live database read failed (${response.status})`);
  return (await response.json()) as T | null;
}

async function patchRoot(updates: JsonRecord) {
  const response = await fetch(`${DATABASE_URL}/.json`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!response.ok) throw new Error(`Live database update failed (${response.status})`);
}

async function bodyOf(request: Request): Promise<JsonRecord> {
  return (await request.json().catch(() => ({}))) as JsonRecord;
}

function serviceIsOpen(config: JsonRecord | null) {
  return config?.['system_service_status'] !== false;
}

function makeUpiUrl(orderId: string, upiId: string, sellerName: string, amount: number, gateway: string) {
  const query =
    `pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(sellerName)}` +
    `&am=${amount.toFixed(2)}&tr=${encodeURIComponent(orderId)}` +
    `&tn=${encodeURIComponent(orderId)}&cu=INR`;
  const packages: Array<[RegExp, string]> = [
    [/mobi\s*kwik/i, "com.mobikwik_new"],
    [/free\s*charge/i, "com.freecharge.android"],
    [/paytm/i, "net.one97.paytm"],
    [/phone\s*pe/i, "com.phonepe.app"],
    [/(gpay|google)/i, "com.google.android.apps.nbu.paisa.user"],
  ];
  const hit = packages.find(([pattern]) => pattern.test(gateway));
  if (!hit) return `upi://pay?${query}`;
  return `intent://pay?${query}#Intent;scheme=upi;package=${hit[1]};S.browser_fallback_url=https://play.google.com/store/apps/details?id=${hit[1]};end`;
}

async function initiatePayment(request: Request) {
  const body = await bodyOf(request);
  const orderId = String(body['orderId'] ?? "").trim();
  if (!orderId) return json({ ok: false, error: "orderId required" }, 400);

  const order = await readNode<JsonRecord>(`p2p_orders/${encodeURIComponent(orderId)}`);
  if (!order) return json({ ok: false, error: "Order not found" }, 404);
  const upiId = String(order['sellerUpi'] ?? order['upi_id'] ?? order['upiId'] ?? "").trim();
  const amount = Number(order['payable_amount'] ?? order['executionAmount'] ?? order['amount']);
  const sellerName = String(order['sellerName'] ?? order['seller_name'] ?? "CRAZY PAY MERCHANT");
  const gateway = String(body['gateway'] ?? order['provider'] ?? "");
  if (!upiId.includes("@") || !Number.isFinite(amount) || amount <= 0) {
    return json({ ok: false, error: "Order payment details are incomplete" }, 409);
  }
  return json({ ok: true, orderId, amount, paymentUrl: makeUpiUrl(orderId, upiId, sellerName, amount, gateway) });
}

async function createAutoUtrOrder(request: Request) {
  const body = await bodyOf(request);
  const userId = String(body['user_id'] ?? "").trim();
  const baseAmount = Number(body['base_amount']);
  if (!userId) return json({ ok: false, error: "user_id required" }, 400);
  if (!Number.isFinite(baseAmount) || baseAmount < 1 || baseAmount > 500000) {
    return json({ ok: false, error: "Invalid base_amount" }, 400);
  }
  const config = await readNode<JsonRecord>("system_config");
  if (!serviceIsOpen(config)) return json({ success: false, message: "Service is currently closed." }, 400);

  const orders = (await readNode<Record<string, JsonRecord>>("orders_db")) ?? {};
  const now = Date.now();
  const used = new Set(
    Object.values(orders)
      .filter((order) => order['status'] === "PENDING" && Number(order['expires_at']) > now && Number(order['base_amount']) === baseAmount)
      .map((order) => Number(order['discount_paisa'])),
  );
  const available = Array.from({ length: 99 }, (_, index) => index + 1).filter((value) => !used.has(value));
  if (!available.length) return json({ ok: false, error: "All payment slots for this amount are busy." }, 429);
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  const randomValue = random.at(0) ?? 0;
  const slot = available.at(randomValue % available.length);
  if (slot === undefined) return json({ ok: false, error: "Unable to allocate a payment slot." }, 503);
  const discountPaisa = slot ?? 0;
  if (discountPaisa === 0) return json({ ok: false, error: "Unable to allocate a payment slot." }, 503);
  const orderId = `UTR-${now.toString(36).toUpperCase()}-${randomValue.toString(16).slice(-6).toUpperCase()}`;
  const payableAmount = Number((baseAmount - discountPaisa / 100).toFixed(2));
  const expiresAt = now + 15 * 60 * 1000;
  await patchRoot({
    [`orders_db/${orderId}`]: {
      order_id: orderId,
      user_id: userId,
      base_amount: baseAmount,
      discount_paisa: discountPaisa,
      payable_amount: payableAmount,
      status: "PENDING",
      retry_count: 0,
      created_at: now,
      expires_at: expiresAt,
    },
  });
  return json({
    ok: true,
    order_id: orderId,
    base_amount: baseAmount,
    discount_paisa: discountPaisa,
    payable_amount: payableAmount,
    status: "PENDING",
    retry_count: 0,
    expires_at: new Date(expiresAt).toISOString(),
    expires_in_seconds: 900,
  }, 201);
}

async function verifyUtr(request: Request) {
  const body = await bodyOf(request);
  const orderId = String(body['order_id'] ?? "").trim();
  const utr = String(body['buyer_entered_utr'] ?? "").trim();
  if (!orderId) return json({ ok: false, error: "order_id required" }, 400);
  if (!/^\d{12}$/.test(utr)) return json({ ok: false, status: "PENDING", can_retry: true, error: "Enter a valid 12-digit UTR", title: "Your Order Was Unsuccessful", message: "Your UTR Was Wrong or Already Used" }, 400);

  const [autoOrder, p2pOrder, proof] = await Promise.all([
    readNode<JsonRecord>(`orders_db/${encodeURIComponent(orderId)}`),
    readNode<JsonRecord>(`p2p_orders/${encodeURIComponent(orderId)}`),
    readNode<JsonRecord>(`payment_proofs/${encodeURIComponent(orderId)}`),
  ]);
  const order = autoOrder ?? p2pOrder;
  if (!order) return json({ ok: false, error: "Order not found" }, 404);
  if (String(order['status']).toUpperCase() === "SUCCESS") {
    return json({ ok: true, status: "SUCCESS", idempotent: true, order_id: orderId });
  }
  if (Number(order['expires_at'] ?? order['expiry'] ?? Number.MAX_SAFE_INTEGER) < Date.now()) {
    await patchRoot({ [`${autoOrder ? "orders_db" : "p2p_orders"}/${orderId}/status`]: "FAILED" });
    return json({ ok: false, status: "FAILED", can_retry: false, title: "Order Expired", message: "The payment window for this order has elapsed." });
  }

  const proofUtr = String(proof?.['utr'] ?? proof?.['utr_number'] ?? "").trim();
  const proofUsedBy = String(proof?.['used_by_order'] ?? "").trim();
  if (proof && proofUtr === utr && (!proofUsedBy || proofUsedBy === orderId)) {
    const amount = Number(order['payable_amount'] ?? order['executionAmount'] ?? order['amount'] ?? 0);
    await patchRoot({
      [`${autoOrder ? "orders_db" : "p2p_orders"}/${orderId}/status`]: "SUCCESS",
      [`${autoOrder ? "orders_db" : "p2p_orders"}/${orderId}/utr_number`]: utr,
      [`payment_proofs/${orderId}/used_by_order`]: orderId,
      [`payment_proofs/${orderId}/verified_at`]: Date.now(),
    });
    return json({ ok: true, status: "SUCCESS", order_id: orderId, utr_number: utr, credited_amount: amount, title: "Your Order Was Successful" });
  }

  const retries = Number(order['retry_count'] ?? 0) + 1;
  const failed = retries >= 2;
  await patchRoot({
    [`${autoOrder ? "orders_db" : "p2p_orders"}/${orderId}/retry_count`]: retries,
    [`${autoOrder ? "orders_db" : "p2p_orders"}/${orderId}/status`]: failed ? "FAILED" : String(order['status'] ?? "PENDING"),
  });
  return json({
    ok: false,
    status: failed ? "FAILED" : "PENDING",
    order_id: orderId,
    retry_count: retries,
    can_retry: !failed,
    title: failed ? "Order Permanently Failed" : "Your Order Was Unsuccessful",
    message: failed ? "This order has been closed after 2 failed verification attempts." : "Your UTR Was Wrong or Already Used",
  });
}

async function usdtStatus(url: URL) {
  const orderId = String(url.searchParams.get("orderId") ?? url.searchParams.get("order_id") ?? "").trim();
  if (!orderId) return json({ success: false, error: "orderId is required" }, 400);
  const order = await readNode<JsonRecord>(`usdt_orders/${encodeURIComponent(orderId)}`);
  if (!order) return json({ success: false, error: "Order not found" }, 404);
  return json({
    success: true,
    status: order['status'],
    receivedAmount: Number(order['received_amount'] ?? 0),
    inrCredited: Number(order['inr_credited'] ?? 0),
    txHash: order['tx_hash'] ?? null,
    order: {
      orderId: order['order_id'] ?? orderId,
      network: order['network'],
      tempAddress: order['temp_address'],
      masterWallet: order['master_wallet'],
      expectedAmount: Number(order['expected_amount'] ?? 0),
      receivedAmount: Number(order['received_amount'] ?? 0),
      status: order['status'],
      txHash: order['tx_hash'] ?? null,
      expiresAt: order['expires_at'],
    },
  });
}

async function availableOrders() {
  const orders = (await readNode<Record<string, JsonRecord>>("p2p_orders")) ?? {};
  const active = Object.entries(orders)
    .filter(([, order]) => ["AVAILABLE", "ACTIVE", "PENDING", "OPEN", "LIVE", "READY"].includes(String(order['status'] ?? "").toUpperCase()))
    .map(([id, order]) => ({ order_id: id, id, ...order }));
  return json({ ok: true, orders: active });
}

interface VerifyEventStatusResponse extends Record<string, unknown> {
  success: boolean;
  task1_upi_bound: boolean;
  task2_order_placed: boolean;
  task3_joined_group: boolean;
  task4_subscribed_channel: boolean;
}

async function verifyEventStatus(url: URL) {
  const phone = (url.searchParams.get("phone") ?? "").replace(/[^0-9]/g, "");
  if (!phone) {
    return json({ ok: false, error: "phone required" } satisfies ApiError, 400);
  }

  const user = await readNode<JsonRecord>(`users/${phone}`);
  const truthy = (value: unknown) => value === true || value === "true" || value === 1;

  const payload: VerifyEventStatusResponse = {
    success: true,
    task1_upi_bound: truthy(user?.['task1_upi_bound'] ?? user?.['upiBound']),
    task2_order_placed: truthy(user?.['task2_order_placed'] ?? user?.['orderPlaced']),
    task3_joined_group: truthy(user?.['task3_joined_group'] ?? user?.['joinedTelegramGroup']),
    task4_subscribed_channel: truthy(user?.['task4_subscribed_channel'] ?? user?.['subscribedSecretTrading']),
  };
  return json(payload);
}


export async function handleLivePaymentApi(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  try {
    if (request.method === "POST" && path === "/api/payments/initiate") return initiatePayment(request);
    if (request.method === "POST" && path === "/api/v1/orders/auto-create") return createAutoUtrOrder(request);
    if (request.method === "POST" && path === "/api/v1/orders/verify-utr") return verifyUtr(request);
    if (request.method === "GET" && path === "/api/v1/usdt/check-status") return usdtStatus(url);
    if (request.method === "GET" && path === "/api/v1/orders/available") return availableOrders();
    return null;
  } catch (error) {
    console.error("[live-payment-api]", error);
    return json({ ok: false, success: false, error: "Live payment service is temporarily unavailable" }, 503);
  }
}