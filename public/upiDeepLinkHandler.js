/**
 * CRAZY PAY :: MODULE 3 — Direct UPI deep-linking "Pay Now" (full overwrite).
 *
 * Canonical intent URI:
 *   upi://pay?pa={seller_upi_id}&pn={seller_name}&am={payable_amount}&tr={order_id}&cu=INR&tn={order_id}
 *
 * Default launch target is Mobikwik (com.mobikwik_new) with a generic UPI
 * fallback so the user lands straight on the UPI PIN screen with the exact
 * payable amount pre-filled.
 */
(function () {
  "use strict";

  var PACKAGES = {
    mobikwik: "com.mobikwik_new",
    paytm: "net.one97.paytm",
    phonepe: "com.phonepe.app",
    gpay: "com.google.android.apps.nbu.paisa.user",
    google: "com.google.android.apps.nbu.paisa.user",
  };

  function resolvePackage(provider) {
    var key = String(provider || "mobikwik").toLowerCase();
    for (var name in PACKAGES) {
      if (key.indexOf(name) !== -1) return PACKAGES[name];
    }
    return PACKAGES.mobikwik;
  }

  function buildQuery(order) {
    var amount = parseFloat(order.payable_amount || order.amount || 0).toFixed(2);
    var ref = String(order.order_ref || order.order_id || order.orderId || "");
    return (
      "pa=" + encodeURIComponent(order.seller_upi_id || order.upiId || "") +
      "&pn=" + encodeURIComponent(order.seller_name || "CRAZY PAY MERCHANT") +
      "&am=" + amount +
      "&tr=" + encodeURIComponent(ref) +
      "&cu=INR" +
      "&tn=" + encodeURIComponent(ref)
    );
  }

  /** Generic UPI URI (works on iOS + any UPI chooser). */
  function generateUpiUri(order) {
    return "upi://pay?" + buildQuery(order);
  }

  /** Android intent URI targeting a specific UPI app with Play Store fallback. */
  function generateUpiIntentUri(order, provider) {
    var pkg = resolvePackage(provider || order.payment_app_type);
    var q = buildQuery(order);
    return (
      "intent://pay?" + q +
      "#Intent;scheme=upi;package=" + pkg +
      ";S.browser_fallback_url=" +
      encodeURIComponent("https://play.google.com/store/apps/details?id=" + pkg) +
      ";end"
    );
  }

  var isAndroid = function () {
    return /android/i.test(navigator.userAgent || "");
  };

  /**
   * "Pay Now" launcher. Tries the targeted app intent on Android, then falls
   * back to the generic upi:// chooser if nothing handled the intent.
   */
  function launchUpiPayment(order, provider) {
    if (!order || !(order.seller_upi_id || order.upiId)) {
      throw new Error("Order is missing a verified seller UPI ID");
    }
    var generic = generateUpiUri(order);

    if (!isAndroid()) {
      window.location.href = generic;
      return generic;
    }

    var intentUri = order.intent_uri || generateUpiIntentUri(order, provider);
    var start = Date.now();

    window.location.href = intentUri;

    // If the app chooser never took over, fall back to the generic URI.
    setTimeout(function () {
      if (document.hidden || Date.now() - start > 2500) return;
      window.location.href = generic;
    }, 1200);

    return intentUri;
  }

  window.CrazyPayUpi = {
    PACKAGES: PACKAGES,
    resolvePackage: resolvePackage,
    generateUpiUri: generateUpiUri,
    generateUpiIntentUri: generateUpiIntentUri,
    launchUpiPayment: launchUpiPayment,
  };

  // Backwards-compatible shim for the old helper signature.
  window.generateFrontendUpiIntentUri = function (provider, targetUpiId, sellerName, amtVal, orderId) {
    var order = {
      seller_upi_id: targetUpiId,
      seller_name: sellerName,
      payable_amount: amtVal,
      order_ref: orderId,
    };
    return provider ? generateUpiIntentUri(order, provider) : generateUpiUri(order);
  };
})();
