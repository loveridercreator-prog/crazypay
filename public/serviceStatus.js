/**
 * CRAZY PAY :: GLOBAL SERVICE STATUS BINDING (frontend)
 * ---------------------------------------------------------------------------
 * Binds every transaction action button on the dashboard to the realtime
 * `system_config/system_service_status` flag in Firebase.
 *
 *  - TRUE  : normal operation
 *  - FALSE : action buttons hard-disabled + "Service Offline" badge shown
 *
 * The flag is streamed with a live listener, so an admin toggle reflects on
 * every open client instantly without a refresh.
 */
(function () {
  "use strict";

  var STATE_KEY = "SYSTEM_SERVICE_STATUS";
  window[STATE_KEY] = true;
  var listenerBound = false;

  /* Selectors of transaction actions gated by the master switch. */
  var ACTION_SELECTORS = [
    "[data-service-action]",
    '[onclick*="initiateDirectBuy"]',
    '[onclick*="openBuyModal"]',
    '[onclick*="confirmBuyOrder"]',
    '[onclick*="createUsdtOrder"]',
    '[onclick*="openDepositModal"]',
    '[onclick*="openWithdrawModal"]',
    '[onclick*="submitWithdrawal"]',
    '[onclick*="startSellFlow"]',
  ];

  function actionNodes() {
    var out = [];
    ACTION_SELECTORS.forEach(function (sel) {
      try {
        document.querySelectorAll(sel).forEach(function (el) {
          if (el.closest("#admin-panel, [data-admin-panel]")) return; // never lock admin controls
          if (out.indexOf(el) === -1) out.push(el);
        });
      } catch (e) {}
    });
    return out;
  }

  function ensureBadge(offline) {
    var hosts = document.querySelectorAll("[data-service-status-badge]");
    if (!hosts.length) {
      var fallback = document.getElementById("service-status-badge-host");
      if (fallback) hosts = [fallback];
    }
    Array.prototype.forEach.call(hosts, function (host) {
      var state = offline ? "offline" : "online";
      if (host.dataset.serviceBadgeState === state) return;
      host.dataset.serviceBadgeState = state;
      host.innerHTML = offline
        ? '<span class="px-2.5 py-1 rounded-full text-[9px] font-black uppercase bg-rose-500/20 text-rose-400 border border-rose-500/30 inline-flex items-center gap-1">' +
          '<span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span> Service Offline</span>'
        : '<span class="px-2.5 py-1 rounded-full text-[9px] font-black uppercase bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 inline-flex items-center gap-1">' +
          '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> Service Online</span>';
    });
  }

  function applyServiceStatus(open) {
    var isOpen = open !== false;
    window[STATE_KEY] = isOpen;
    document.documentElement.classList.toggle("service-offline", !isOpen);

    actionNodes().forEach(function (el) {
      if (isOpen) {
        if (el.dataset.serviceLocked === "1") {
          el.disabled = false;
          el.removeAttribute("aria-disabled");
          el.classList.remove("opacity-40", "pointer-events-none", "cursor-not-allowed");
          if (el.dataset.serviceTitle !== undefined) {
            el.title = el.dataset.serviceTitle;
            delete el.dataset.serviceTitle;
          }
          delete el.dataset.serviceLocked;
        }
      } else if (el.dataset.serviceLocked !== "1") {
        el.dataset.serviceLocked = "1";
        el.dataset.serviceTitle = el.title || "";
        el.disabled = true;
        el.setAttribute("aria-disabled", "true");
        el.title = "Service is currently closed.";
        el.classList.add("opacity-40", "pointer-events-none", "cursor-not-allowed");
      }
    });

    ensureBadge(!isOpen);
  }

  window.applyServiceStatus = applyServiceStatus;
  window.isServiceOpen = function () {
    return window[STATE_KEY] !== false;
  };

  /* Block any client-side call path while the service is closed. */
  window.assertServiceOpen = function () {
    if (window.isServiceOpen()) return true;
    if (typeof window.showToast === "function") window.showToast("Service is currently closed.");
    else alert("Service is currently closed.");
    return false;
  };

  /* Attach the realtime listener as soon as Firebase is ready. */
  function bind() {
    if (listenerBound) return true;
    var db = window.database || (window.firebase && window.firebase.apps && window.firebase.apps.length
      ? window.firebase.database()
      : null);
    if (!db) return false;
    listenerBound = true;
    db.ref("system_config/system_service_status").on(
      "value",
      function (snap) {
        var v = snap.val();
        applyServiceStatus(v === null || v === undefined ? true : v !== false);
      },
      function (err) {
        console.warn("[service-status] listener error:", err && err.message);
      }
    );
    return true;
  }

  var tries = 0;
  var poll = setInterval(function () {
    if (bind() || ++tries > 60) clearInterval(poll);
  }, 500);

  document.addEventListener("DOMContentLoaded", function () {
    bind();
    applyServiceStatus(window[STATE_KEY]);
    // Re-apply after dynamic renders (order cards, ledgers, modals).
    var obs = new MutationObserver(function () {
      applyServiceStatus(window[STATE_KEY]);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  });
})();
