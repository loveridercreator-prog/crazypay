-- ============================================================================
-- CRAZY PAY :: Auto-System P2P Discounted Auto-UTR Engine
-- PostgreSQL schema. Run once against the production database.
-- ============================================================================

CREATE TABLE IF NOT EXISTS orders_db (
    id              BIGSERIAL PRIMARY KEY,
    user_id         TEXT        NOT NULL,
    base_amount     NUMERIC(12,2) NOT NULL CHECK (base_amount > 0),
    discount_paisa  INTEGER     NOT NULL CHECK (discount_paisa BETWEEN 1 AND 99),
    payable_amount  NUMERIC(12,2) NOT NULL CHECK (payable_amount > 0),
    status          TEXT        NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','SUCCESS','FAILED')),
    retry_count     INTEGER     NOT NULL DEFAULT 0,
    utr_number      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '15 minutes'
);

-- Only ONE live slot may hold a given payable_amount at a time; this is what
-- makes "amount + UTR" matching unambiguous. Max 99 slots per base amount is
-- therefore implied by the 0.01-0.99 paisa discount space.
CREATE UNIQUE INDEX IF NOT EXISTS orders_db_unique_live_payable
    ON orders_db (payable_amount)
    WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS orders_db_user_idx     ON orders_db (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_db_status_idx   ON orders_db (status, expires_at);
CREATE INDEX IF NOT EXISTS orders_db_base_idx     ON orders_db (base_amount, status);

CREATE TABLE IF NOT EXISTS bank_transactions_db (
    id           BIGSERIAL PRIMARY KEY,
    utr_number   TEXT UNIQUE NOT NULL,
    amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    sender_name  TEXT,
    status       TEXT NOT NULL DEFAULT 'UNUSED'
                 CHECK (status IN ('UNUSED','USED')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bank_tx_match_idx
    ON bank_transactions_db (amount, status);

-- Housekeeping: expire stale slots so their payable_amount is released.
-- Schedule every minute (pg_cron) or call from the app's interval worker.
CREATE OR REPLACE FUNCTION expire_stale_orders() RETURNS INTEGER AS $$
DECLARE affected INTEGER;
BEGIN
    UPDATE orders_db
       SET status = 'FAILED'
     WHERE status = 'PENDING'
       AND expires_at < NOW();
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected;
END;
$$ LANGUAGE plpgsql;
