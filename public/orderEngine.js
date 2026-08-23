/**
 * CRAZY PAY :: FRONTEND ORDER CREATION ENGINE (full overwrite)
 * ---------------------------------------------------------------------------
 * Purges all legacy client-side order creation (fixed splits, simulated
 * auto-match sweeps, locally-computed paisa offsets) and drives everything
 * from the authoritative backend at /api/v1/orders.
 *
 * MODULE 1  bound order data from the server (never recomputed locally)
 * MODULE 2  two-stage split timer: 5-min buy lock -> 15-min payment/UTR
 * MODULE 3  Pay Now direct UPI deep link (Mobikwik target + generic fallback)
 * MODULE 4  realtime sale ledger (active only) + atomic buy-history state lock
 */
(function () {
  "use strict";

  var API = "/api/v1/orders";
  var ACTIVE = ["AVAILABLE", "LOCKED", "PAYING"];
  var TERMINAL = ["SUCCESS", "CANCELLED", "FAILED"];

  /* ------------------------------------------------------------- helpers */

  function api(path, options) {
    return fetch(API + path, Object.assign({ headers: { "Content-Type": "application/json" } }, options || {}))
      .then(function (r) {
        return r.json().then(function (body) {
          if (!r.ok || body.ok === false) throw new Error(body.error || "Request failed");
          return body;
        });
      });
  }

  function fmtClock(seconds) {
    var s = Math.max(0, Math.floor(seconds));
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }

  function emit(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail: detail }));
  }

  /* -------------------------------------- MODULE 2 :: two-stage timer */

  var timers = {}; // order_id -> { id, stage }

  /**
   * Runs a single countdown for an order. Stage 1 (buy lock) is cleared and
   * replaced by stage 2 (payment/UTR) the moment the buyer confirms.
   */
  function startTimer(orderId, stage, seconds, opts) {
    clearTimer(orderId);
    opts = opts || {};
    var deadline = Date.now() + seconds * 1000;

    function tick() {
      var left = Math.round((deadline - Date.now()) / 1000);
      if (opts.onTick) opts.onTick(left, fmtClock(left), stage);
      emit("crazypay:timer", { order_id: orderId, stage: stage, seconds_left: left, clock: fmtClock(left) });
      if (left <= 0) {
        clearTimer(orderId);
        if (opts.onExpire) opts.onExpire(stage);
        emit("crazypay:timer-expired", { order_id: orderId, stage: stage });
      }
    }

    tick();
    timers[orderId] = { id: setInterval(tick, 1000), stage: stage };
    return timers[orderId];
  }

  function clearTimer(orderId) {
    if (timers[orderId]) {
      clearInterval(timers[orderId].id);
      delete timers[orderId];
    }
  }

  function clearAllTimers() {
    Object.keys(timers).forEach(clearTimer);
  }

  /* ------------------------------------------ MODULE 1 :: order actions */

  function runWithdrawalEngine(sellerId) {
    return api("/engine/run", { method: "POST", body: JSON.stringify({ seller_id: sellerId }) });
  }

  function listAvailable() {
    return api("/available").then(function (b) { return b.orders || []; });
  }

  /** Stage 1: buyer opened the order card -> lock it for 5 minutes. */
  function openOrder(orderId, buyerId, handlers) {
    return api("/" + orderId + "/lock", { method: "POST", body: JSON.stringify({ buyer_id: buyerId }) })
      .then(function (res) {
        startTimer(orderId, 1, res.timer_seconds, {
          onTick: handlers && handlers.onTick,
          onExpire: function () {
            // Backend already cancels + regenerates; just reflect it in the UI.
            if (handlers && handlers.onBuyLockExpired) handlers.onBuyLockExpired(res.order);
          },
        });
        return res.order;
      });
  }

  /** Stage 2: buyer clicked Buy/Confirm -> swap to the 15-minute UTR window. */
  function confirmOrder(orderId, buyerId, handlers) {
    return api("/" + orderId + "/confirm", { method: "POST", body: JSON.stringify({ buyer_id: buyerId }) })
      .then(function (res) {
        clearTimer(orderId); // kill the 5-minute lock timer
        startTimer(orderId, 2, res.timer_seconds, {
          onTick: handlers && handlers.onTick,
          onExpire: function () {
            if (handlers && handlers.onPaymentExpired) handlers.onPaymentExpired(res.order);
          },
        });
        return res.order;
      });
  }

  function settleOrder(orderId, status, utr) {
    return api("/" + orderId + "/settle", {
      method: "POST",
      body: JSON.stringify({ status: status, utr_number: utr || null }),
    }).then(function (res) {
      clearTimer(orderId);
      lockHistoryRecord(res.order);
      return res.order;
    });
  }

  /* ---------------------------------------------- MODULE 3 :: Pay Now */

  function payNow(order) {
    if (!window.CrazyPayUpi) throw new Error("UPI deep link handler not loaded");
    return window.CrazyPayUpi.launchUpiPayment(order, order.payment_app_type || "mobikwik");
  }

  /* -------------------------------- MODULE 4 :: ledgers + state lock */

  var historyLock = Object.create(null); // order_id -> frozen record

  /** Freezes a terminal record so nothing can move it back into processing. */
  function lockHistoryRecord(order) {
    if (!order) return null;
    if (TERMINAL.indexOf(order.status) === -1) return order;
    if (historyLock[order.order_id]) return historyLock[order.order_id];
    historyLock[order.order_id] = Object.freeze(Object.assign({}, order, { state_locked: true }));
    clearTimer(order.order_id);
    emit("crazypay:history-locked", historyLock[order.order_id]);
    return historyLock[order.order_id];
  }

  function isLocked(orderId) {
    return Boolean(historyLock[orderId]);
  }

  /** Seller dashboard: ONLY live orders (AVAILABLE / LOCKED / PAYING). */
  function filterActiveLedger(orders) {
    return (orders || []).filter(function (o) { return ACTIVE.indexOf(o.status) !== -1; });
  }

  function loadSaleLedger(sellerId) {
    return api("/sale-ledger?seller_id=" + encodeURIComponent(sellerId))
      .then(function (b) { return filterActiveLedger(b.orders); });
  }

  function loadBuyHistory(buyerId) {
    return api("/buy-history?buyer_id=" + encodeURIComponent(buyerId)).then(function (b) {
      return (b.orders || []).map(function (o) {
        return TERMINAL.indexOf(o.status) !== -1 ? lockHistoryRecord(o) : o;
      });
    });
  }

  /* ------------------------------------------- realtime state listener */

  var source = null;

  /**
   * Live SSE listener. Sale ledger rows drop out the instant an order becomes
   * SUCCESS/CANCELLED and buy-history rows are frozen — no page refresh.
   */
  function connectRealtime(opts) {
    opts = opts || {};
    disconnectRealtime();

    var qs = [];
    if (opts.sellerId) qs.push("seller_id=" + encodeURIComponent(opts.sellerId));
    if (opts.buyerId) qs.push("buyer_id=" + encodeURIComponent(opts.buyerId));
    source = new EventSource(API + "/stream" + (qs.length ? "?" + qs.join("&") : ""));

    source.onmessage = handleMessage;
    ["ORDER_CREATED", "ORDER_LOCKED", "ORDER_CONFIRMED", "ORDER_SUCCESS", "ORDER_CANCELLED",
      "ORDER_FAILED", "BUY_LOCK_EXPIRED", "PAYMENT_WINDOW_EXPIRED"].forEach(function (evt) {
      source.addEventListener(evt, handleMessage);
    });

    function handleMessage(e) {
      var data;
      try { data = JSON.parse(e.data); } catch (_) { return; }
      var order = data.order;
      if (!order) return;

      if (TERMINAL.indexOf(order.status) !== -1) lockHistoryRecord(order);
      emit("crazypay:order-update", data);
      if (opts.onUpdate) opts.onUpdate(data);
    }

    return source;
  }

  function disconnectRealtime() {
    if (source) { source.close(); source = null; }
  }

  /* -------------------------------------- purge legacy client engines */

  function purgeLegacyEngines() {
    var noop = function () { return undefined; };
    [
      "generateRandomQuotaEvent",
      "startWithdrawalEngineMonitor",
      "startLiveQuotaEngine",
      "autoGenerateSplitOrders",
      "createLocalOrder",
    ].forEach(function (name) {
      if (typeof window[name] === "function") window[name] = noop;
    });
    if (typeof window.withdrawalEngineMonitorId === "number") clearInterval(window.withdrawalEngineMonitorId);
  }

  window.CrazyPayOrderEngine = {
    API: API,
    ACTIVE_STATUSES: ACTIVE,
    TERMINAL_STATUSES: TERMINAL,
    fmtClock: fmtClock,
    runWithdrawalEngine: runWithdrawalEngine,
    listAvailable: listAvailable,
    openOrder: openOrder,
    confirmOrder: confirmOrder,
    settleOrder: settleOrder,
    payNow: payNow,
    startTimer: startTimer,
    clearTimer: clearTimer,
    clearAllTimers: clearAllTimers,
    filterActiveLedger: filterActiveLedger,
    loadSaleLedger: loadSaleLedger,
    loadBuyHistory: loadBuyHistory,
    lockHistoryRecord: lockHistoryRecord,
    isLocked: isLocked,
    connectRealtime: connectRealtime,
    disconnectRealtime: disconnectRealtime,
    purgeLegacyEngines: purgeLegacyEngines,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", purgeLegacyEngines);
  } else {
    purgeLegacyEngines();
  }
})();
