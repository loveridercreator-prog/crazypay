-- ============================================================================
-- CRAZY PAY :: ORDER CREATION ENGINE (full overwrite)
-- Modules: data binding, random chunking, two-stage split timer, sale ledger,
--          buy history atomic state lock.
-- Run once against the production PostgreSQL database.
-- ============================================================================

-- ---------------------------------------------------------------- PURGE ----
-- Every legacy order-creation table/view is dropped so the new binding is the
-- only source of truth. (orders_db from the UTR engine is REPLACED by p2p_orders.)
DROP VIEW  IF EXISTS active_sale_ledger      CASCADE;
DROP VIEW  IF EXISTS buyer_history_ledger    CASCADE;
DROP TABLE IF EXISTS order_events            CASCADE;
DROP TABLE IF EXISTS p2p_orders              CASCADE;

-- ------------------------------------------------------------- SELLERS -----
CREATE TABLE IF NOT EXISTS sellers (
    id                  BIGSERIAL PRIMARY KEY,
    seller_id           TEXT UNIQUE NOT NULL,
    seller_name         TEXT NOT NULL,
    seller_referral_id  TEXT NOT NULL,
    seller_upi_id       TEXT NOT NULL,
    payment_app_type    TEXT NOT NULL DEFAULT 'Mobikwik',
    symbol              TEXT NOT NULL DEFAULT '/upi-logos/mobikwik.svg',
    available_balance   NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (available_balance >= 0),
    withdrawal_engine   BOOLEAN NOT NULL DEFAULT FALSE,
    upi_verified        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sellers TO authenticated;
GRANT ALL ON public.sellers TO service_role;

-- ------------------------------------------------------------- ORDERS ------
-- Lifecycle: AVAILABLE -> LOCKED (5 min) -> PAYING (15 min) -> SUCCESS
--                      \-> CANCELLED (expiry / manual)      -> FAILED
CREATE TABLE p2p_orders (
    id                  BIGSERIAL PRIMARY KEY,
    order_ref           TEXT UNIQUE NOT NULL,

    -- MODULE 1 :: bound data (persisted at creation, never recomputed client-side)
    seller_id           TEXT NOT NULL,
    seller_name         TEXT NOT NULL,
    seller_referral_id  TEXT NOT NULL,
    seller_upi_id       TEXT NOT NULL,
    payment_app_type    TEXT NOT NULL,
    symbol              TEXT NOT NULL,
    display_amount      NUMERIC(12,0) NOT NULL CHECK (display_amount > 0),
    discount_paisa      INTEGER NOT NULL CHECK (discount_paisa BETWEEN 1 AND 99),
    payable_amount      NUMERIC(12,2) NOT NULL CHECK (payable_amount > 0),

    -- MODULE 2 :: two-stage split timer
    status              TEXT NOT NULL DEFAULT 'AVAILABLE'
                        CHECK (status IN ('AVAILABLE','LOCKED','PAYING','SUCCESS','CANCELLED','FAILED')),
    buyer_id            TEXT,
    locked_at           TIMESTAMPTZ,
    lock_expires_at     TIMESTAMPTZ,       -- stage 1, +5 min
    confirmed_at        TIMESTAMPTZ,
    pay_expires_at      TIMESTAMPTZ,       -- stage 2, +15 min
    settled_at          TIMESTAMPTZ,       -- set when SUCCESS/CANCELLED/FAILED (state lock)
    state_locked        BOOLEAN NOT NULL DEFAULT FALSE,

    utr_number          TEXT,
    retry_count         INTEGER NOT NULL DEFAULT 0,
    chunk_batch_id      TEXT,
    reorder_of          BIGINT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only ONE live order may hold a given payable_amount: that is what makes
-- amount + UTR auto-validation unambiguous and zero-cost.
CREATE UNIQUE INDEX p2p_orders_unique_live_payable
    ON p2p_orders (payable_amount)
    WHERE status IN ('AVAILABLE','LOCKED','PAYING');

CREATE INDEX p2p_orders_seller_idx  ON p2p_orders (seller_id, status);
CREATE INDEX p2p_orders_buyer_idx   ON p2p_orders (buyer_id, created_at DESC);
CREATE INDEX p2p_orders_status_idx  ON p2p_orders (status, lock_expires_at, pay_expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.p2p_orders TO authenticated;
GRANT ALL ON public.p2p_orders TO service_role;

-- ------------------------------------------------------------- EVENTS ------
-- Append-only stream consumed by the realtime (SSE/WebSocket) broadcaster.
CREATE TABLE order_events (
    id          BIGSERIAL PRIMARY KEY,
    order_id    BIGINT NOT NULL REFERENCES p2p_orders(id) ON DELETE CASCADE,
    order_ref   TEXT   NOT NULL,
    seller_id   TEXT   NOT NULL,
    buyer_id    TEXT,
    event       TEXT   NOT NULL,
    status      TEXT   NOT NULL,
    payload     JSONB  NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX order_events_stream_idx ON order_events (id DESC);
CREATE INDEX order_events_seller_idx ON order_events (seller_id, id DESC);

GRANT SELECT, INSERT ON public.order_events TO authenticated;
GRANT ALL ON public.order_events TO service_role;

-- Notify realtime listeners on every state change.
CREATE OR REPLACE FUNCTION notify_order_event() RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify('order_events', row_to_json(NEW)::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS order_events_notify ON order_events;
CREATE TRIGGER order_events_notify
    AFTER INSERT ON order_events
    FOR EACH ROW EXECUTE FUNCTION notify_order_event();

-- -------------------------------------------------------------- VIEWS ------
-- Seller dashboard: ONLY live / paying orders.
CREATE VIEW active_sale_ledger AS
SELECT id, order_ref, seller_id, seller_name, seller_upi_id, payment_app_type, symbol,
       display_amount, payable_amount, status, buyer_id,
       lock_expires_at, pay_expires_at, created_at
  FROM p2p_orders
 WHERE status IN ('AVAILABLE','LOCKED','PAYING');

-- Buyer dashboard: every order the buyer touched, with the frozen flag.
CREATE VIEW buyer_history_ledger AS
SELECT id, order_ref, buyer_id, seller_name, payment_app_type, symbol,
       display_amount, payable_amount, status, state_locked, utr_number,
       confirmed_at, settled_at, created_at
  FROM p2p_orders
 WHERE buyer_id IS NOT NULL;

GRANT SELECT ON public.active_sale_ledger  TO authenticated;
GRANT SELECT ON public.buyer_history_ledger TO authenticated;

-- ------------------------------------------------------- TIMER SWEEPER -----
-- Stage 1 expiry -> CANCELLED (escrow released, re-order generated by the app),
-- Stage 2 expiry -> CANCELLED. Both freeze the record (state_locked).
CREATE OR REPLACE FUNCTION expire_order_timers()
RETURNS TABLE (order_id BIGINT, seller_id TEXT, display_amount NUMERIC, stage TEXT) AS $$
BEGIN
    RETURN QUERY
    WITH expired AS (
        UPDATE p2p_orders o
           SET status = 'CANCELLED',
               state_locked = TRUE,
               settled_at = NOW(),
               updated_at = NOW()
         WHERE (o.status = 'LOCKED' AND o.lock_expires_at < NOW())
            OR (o.status = 'PAYING' AND o.pay_expires_at  < NOW())
            OR (o.status = 'AVAILABLE' AND o.created_at < NOW() - INTERVAL '60 minutes')
        RETURNING o.id, o.seller_id, o.display_amount,
                  CASE WHEN o.confirmed_at IS NULL THEN 'BUY_LOCK' ELSE 'PAYMENT' END AS stage
    )
    SELECT e.id, e.seller_id, e.display_amount, e.stage FROM expired e;
END;
$$ LANGUAGE plpgsql;
