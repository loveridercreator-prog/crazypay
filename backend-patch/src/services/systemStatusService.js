/**
 * CRAZY PAY :: GLOBAL SYSTEM SERVICE STATUS
 * ---------------------------------------------------------------------------
 * Single source of truth for the admin "Open / Close" master switch.
 *
 * Priority order:
 *   1. Firebase Realtime Database  system_config/system_service_status
 *   2. PostgreSQL                  system_config (key/value) if the table exists
 *   3. env SYSTEM_SERVICE_STATUS   ("false" closes the service)
 *   4. default: OPEN
 *
 * The RTDB value is kept hot with a live listener, so an admin toggle takes
 * effect on the API within milliseconds — no polling, no restart.
 */

const CLOSED_MESSAGE = "Service is currently closed.";
const RTDB_PATH = "system_config/system_service_status";

let adminRef = null;   // firebase-admin module
let liveValue = null;  // last value pushed by the RTDB listener
let pgPool = null;

function envDefault() {
  const raw = process.env.SYSTEM_SERVICE_STATUS;
  if (raw === undefined) return true;
  return String(raw).toLowerCase() !== "false";
}

/** Wire firebase-admin so the flag is streamed in realtime. */
function attachFirebase(admin) {
  if (!admin || typeof admin.database !== "function") return false;
  adminRef = admin;
  try {
    admin
      .database()
      .ref(RTDB_PATH)
      .on(
        "value",
        (snap) => {
          const v = snap.val();
          liveValue = v === undefined || v === null ? null : v !== false;
        },
        (err) => console.warn("[system-status] RTDB listener error:", err.message)
      );
    return true;
  } catch (err) {
    console.warn("[system-status] Firebase attach failed:", err.message);
    return false;
  }
}

/** Optional PostgreSQL fallback (system_config key/value table). */
function attachPool(pool) {
  pgPool = pool || null;
}

async function readFromPg() {
  if (!pgPool) return null;
  try {
    const { rows } = await pgPool.query(
      `SELECT value FROM system_config WHERE key = 'system_service_status' LIMIT 1`
    );
    if (!rows.length) return null;
    const v = String(rows[0].value).toLowerCase();
    return !(v === "false" || v === "0" || v === "off" || v === "closed");
  } catch {
    return null; // table absent -> silently fall through
  }
}

/** @returns {Promise<boolean>} true when the service is OPEN. */
async function isServiceOpen() {
  if (liveValue !== null) return liveValue;

  if (adminRef) {
    try {
      const snap = await adminRef.database().ref(RTDB_PATH).once("value");
      const v = snap.val();
      if (v !== undefined && v !== null) {
        liveValue = v !== false;
        return liveValue;
      }
    } catch (err) {
      console.warn("[system-status] RTDB read failed:", err.message);
    }
  }

  const fromPg = await readFromPg();
  if (fromPg !== null) return fromPg;

  return envDefault();
}

/**
 * Express guard — rejects writes while the service is closed.
 * Usage: `if (await guard(res)) return;`
 */
async function guard(res) {
  const open = await isServiceOpen();
  if (open) return false;
  res.status(400).json({ success: false, message: CLOSED_MESSAGE });
  return true;
}

/** Express middleware form. */
async function requireServiceOpen(_req, res, next) {
  if (await guard(res)) return;
  next();
}

module.exports = {
  CLOSED_MESSAGE,
  RTDB_PATH,
  attachFirebase,
  attachPool,
  isServiceOpen,
  guard,
  requireServiceOpen,
};
