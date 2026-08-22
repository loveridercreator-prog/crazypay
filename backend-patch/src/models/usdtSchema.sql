-- ===========================================================================
-- CRAZY PAY :: USDT DEPOSIT ENGINE (BEP-20 + TRC-20)
-- Full rebuild. Drops every legacy USDT artifact and recreates it clean.
-- ===========================================================================

DROP TABLE IF EXISTS usdt_sweeps      CASCADE;
DROP TABLE IF EXISTS usdt_deposits    CASCADE;
DROP TABLE IF EXISTS usdt_orders      CASCADE;
DROP SEQUENCE IF EXISTS usdt_hd_index_seq;

-- Monotonic HD derivation index. One address is never reused for two orders.
CREATE SEQUENCE usdt_hd_index_seq START 1;

-- --------------------------------------------------------------- orders ---
CREATE TABLE usdt_orders (
  id              BIGSERIAL PRIMARY KEY,
  order_ref       TEXT        NOT NULL UNIQUE,
  user_id         TEXT        NOT NULL,
  network         TEXT        NOT NULL CHECK (network IN ('BSC', 'TRC20')),
  hd_index        BIGINT      NOT NULL,
  temp_address    TEXT        NOT NULL,
  master_wallet   TEXT        NOT NULL,
  expected_amount NUMERIC(20, 6) NOT NULL CHECK (expected_amount > 0),
  received_amount NUMERIC(20, 6) NOT NULL DEFAULT 0,
  inr_rate        NUMERIC(12, 4) NOT NULL DEFAULT 0,
  inr_credited    NUMERIC(20, 2) NOT NULL DEFAULT 0,
  status          TEXT        NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'SUCCESS', 'EXPIRED', 'FAILED')),
  tx_hash         TEXT,
  credited_at     TIMESTAMPTZ,
  sweep_status    TEXT        NOT NULL DEFAULT 'NONE'
                    CHECK (sweep_status IN ('NONE', 'QUEUED', 'GAS_FUNDING', 'SWEEPING', 'SWEPT', 'SWEEP_FAILED')),
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (network, hd_index)
);

-- One live PENDING order per temp address; the address is single-use.
CREATE UNIQUE INDEX usdt_orders_temp_address_uq  ON usdt_orders (network, temp_address);
CREATE INDEX        usdt_orders_pending_idx      ON usdt_orders (status, expires_at)
  WHERE status = 'PENDING';
CREATE INDEX        usdt_orders_user_idx         ON usdt_orders (user_id, created_at DESC);
CREATE INDEX        usdt_orders_sweep_idx        ON usdt_orders (sweep_status)
  WHERE sweep_status IN ('QUEUED', 'GAS_FUNDING', 'SWEEPING', 'SWEEP_FAILED');

-- ------------------------------------------------------------- deposits ---
-- Every on-chain credit ever accepted. tx_hash is globally unique, which is
-- the hard stop against replaying one transaction across many orders.
CREATE TABLE usdt_deposits (
  id           BIGSERIAL PRIMARY KEY,
  order_id     BIGINT      NOT NULL REFERENCES usdt_orders (id) ON DELETE CASCADE,
  network      TEXT        NOT NULL,
  tx_hash      TEXT        NOT NULL,
  from_address TEXT,
  to_address   TEXT        NOT NULL,
  amount       NUMERIC(20, 6) NOT NULL CHECK (amount > 0),
  source       TEXT        NOT NULL CHECK (source IN ('LISTENER', 'MANUAL_TXHASH')),
  block_number BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX usdt_deposits_tx_hash_uq ON usdt_deposits (lower(tx_hash));
CREATE INDEX        usdt_deposits_order_idx  ON usdt_deposits (order_id);

-- --------------------------------------------------------------- sweeps ---
CREATE TABLE usdt_sweeps (
  id            BIGSERIAL PRIMARY KEY,
  order_id      BIGINT      NOT NULL REFERENCES usdt_orders (id) ON DELETE CASCADE,
  network       TEXT        NOT NULL,
  temp_address  TEXT        NOT NULL,
  master_wallet TEXT        NOT NULL,
  amount        NUMERIC(20, 6),
  gas_tx_hash   TEXT,
  sweep_tx_hash TEXT,
  attempts      INT         NOT NULL DEFAULT 0,
  last_error    TEXT,
  status        TEXT        NOT NULL DEFAULT 'QUEUED'
                  CHECK (status IN ('QUEUED', 'GAS_FUNDING', 'SWEEPING', 'SWEPT', 'FAILED')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX usdt_sweeps_order_uq   ON usdt_sweeps (order_id);
CREATE INDEX        usdt_sweeps_status_idx ON usdt_sweeps (status);

-- ------------------------------------------------------------- triggers ---
CREATE OR REPLACE FUNCTION usdt_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER usdt_orders_touch BEFORE UPDATE ON usdt_orders
  FOR EACH ROW EXECUTE FUNCTION usdt_touch_updated_at();

CREATE TRIGGER usdt_sweeps_touch BEFORE UPDATE ON usdt_sweeps
  FOR EACH ROW EXECUTE FUNCTION usdt_touch_updated_at();
