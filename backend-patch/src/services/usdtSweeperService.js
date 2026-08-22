/**
 * CRAZY PAY :: USDT CHAIN LAYER + AUTOMATED SWEEPER
 * ---------------------------------------------------------------------------
 * Responsibilities
 *   - Deterministic HD temp-address derivation (BEP-20 + TRC-20)
 *   - On-chain reads: USDT balance, transaction lookup by hash
 *   - Micro-gas funding of a temp address from the master wallet
 *   - 100% USDT sweep from temp address -> master receiver wallet
 *   - Background loops: 3s deposit listener + sweep worker
 *
 * Requires: pg, ethers@^6, tronweb@^6
 *
 * Environment
 *   DATABASE_URL              Postgres connection string
 *   USDT_HD_MNEMONIC          BIP-39 mnemonic that derives every temp address
 *   BSC_RPC_URL               default https://bsc-dataseed.binance.org
 *   BSC_MASTER_PRIVATE_KEY    funds BNB gas for BEP-20 sweeps
 *   TRON_FULL_HOST            default https://api.trongrid.io
 *   TRON_API_KEY              TronGrid API key (recommended)
 *   TRON_MASTER_PRIVATE_KEY   funds TRX gas for TRC-20 sweeps
 */

const { Pool } = require("pg");
const { ethers } = require("ethers");

let TronWebCtor = null;
try {
  const mod = require("tronweb");
  TronWebCtor = mod.TronWeb || mod.default || mod;
} catch (_) {
  TronWebCtor = null;
}

/* ------------------------------------------------------------------ config */

const MASTER_WALLETS = {
  BSC: "0x39cbbf2fd2e8d0e197599b7e53155f9468520d13",
  TRC20: "TL8kCmde6dSuiZGovC5mfmjA94idwRUDE9",
};

const USDT_CONTRACTS = {
  BSC: "0x55d398326f99059fF775485246999027B3197955",
  TRC20: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
};

const DECIMALS = { BSC: 18, TRC20: 6 };

// HD paths: BIP-44 coin 60 (EVM) and coin 195 (TRON).
const HD_PATHS = {
  BSC: (i) => `m/44'/60'/0'/0/${i}`,
  TRC20: (i) => `m/44'/195'/0'/0/${i}`,
};

// Gas policy for the temp address before a sweep can be broadcast.
const GAS = {
  BSC: { minWei: ethers.parseEther("0.0004"), topUpWei: ethers.parseEther("0.0008") },
  TRC20: { minSun: 15_000_000, topUpSun: 30_000_000 }, // 15 / 30 TRX
};

const LISTENER_INTERVAL_MS = 3000;
const SWEEP_INTERVAL_MS = 12000;
const MAX_SWEEP_ATTEMPTS = 5;
const MIN_CONFIRMATIONS_BSC = 3;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

/* -------------------------------------------------------------------- pool */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
  max: 10,
});

/* ------------------------------------------------------------- chain setup */

let bscProvider = null;
function getBscProvider() {
  if (!bscProvider) {
    bscProvider = new ethers.JsonRpcProvider(
      process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
      56
    );
  }
  return bscProvider;
}

function getTronWeb(privateKey) {
  if (!TronWebCtor) throw new Error("tronweb is not installed");
  return new TronWebCtor({
    fullHost: process.env.TRON_FULL_HOST || "https://api.trongrid.io",
    headers: process.env.TRON_API_KEY ? { "TRON-PRO-API-KEY": process.env.TRON_API_KEY } : undefined,
    privateKey: privateKey || undefined,
  });
}

function requireMnemonic() {
  const m = process.env.USDT_HD_MNEMONIC;
  if (!m) throw new Error("USDT_HD_MNEMONIC is not configured");
  return m.trim();
}

/* ------------------------------------------------- HD address derivation */

/** Derive the temp deposit keypair for (network, index). Never logged. */
function deriveWallet(network, index) {
  const mnemonic = requireMnemonic();
  const path = HD_PATHS[network](index);

  if (network === "BSC") {
    const w = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, path);
    return { address: w.address, privateKey: w.privateKey };
  }

  // TRON shares BIP-39/BIP-32 with EVM; only the address encoding differs.
  const node = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, path);
  const tw = getTronWeb();
  const pk = node.privateKey.replace(/^0x/, "");
  return { address: tw.address.fromPrivateKey(pk), privateKey: pk };
}

function deriveAddress(network, index) {
  return deriveWallet(network, index).address;
}

/* ----------------------------------------------------------- amount utils */

function toUnits(network, amount) {
  return ethers.parseUnits(String(amount), DECIMALS[network]);
}

function fromUnits(network, units) {
  return Number(ethers.formatUnits(BigInt(units), DECIMALS[network]));
}

function normalizeNetwork(raw) {
  const n = String(raw || "BSC").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (n === "TRC20" || n === "TRC" || n === "TRON" || n === "TRX") return "TRC20";
  return "BSC";
}

/* --------------------------------------------------------- balance reads */

/** USDT balance of an address, as a Number in whole USDT. */
async function getUsdtBalance(network, address) {
  if (network === "BSC") {
    const c = new ethers.Contract(USDT_CONTRACTS.BSC, ERC20_ABI, getBscProvider());
    return fromUnits("BSC", await c.balanceOf(address));
  }
  const tw = getTronWeb();
  tw.setAddress(address);
  const c = await tw.contract().at(USDT_CONTRACTS.TRC20);
  const raw = await c.balanceOf(address).call();
  return fromUnits("TRC20", raw.toString());
}

/* ------------------------------------------------- transaction inspection */

/**
 * Look up a transaction hash on-chain and return the USDT transfer it carries
 * to `expectedTo`, or null. Never trusts client-supplied amounts.
 *
 * @returns {Promise<null | {txHash, from, to, amount, blockNumber}>}
 */
async function findUsdtTransfer(network, txHash, expectedTo) {
  if (network === "BSC") return findBscTransfer(txHash, expectedTo);
  return findTronTransfer(txHash, expectedTo);
}

async function findBscTransfer(txHash, expectedTo) {
  const provider = getBscProvider();
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt || receipt.status !== 1) return null;

  const confirmations = (await provider.getBlockNumber()) - receipt.blockNumber + 1;
  if (confirmations < MIN_CONFIRMATIONS_BSC) return null;

  const usdt = USDT_CONTRACTS.BSC.toLowerCase();
  const target = expectedTo.toLowerCase();

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdt) continue;
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    const to = ethers.getAddress("0x" + log.topics[2].slice(26)).toLowerCase();
    if (to !== target) continue;
    const from = ethers.getAddress("0x" + log.topics[1].slice(26));
    return {
      txHash: receipt.hash,
      from,
      to,
      amount: fromUnits("BSC", BigInt(log.data)),
      blockNumber: receipt.blockNumber,
    };
  }
  return null;
}

async function findTronTransfer(txHash, expectedTo) {
  const tw = getTronWeb();
  const info = await tw.trx.getTransactionInfo(txHash);
  if (!info || !info.id || !info.log) return null;
  if (info.receipt && info.receipt.result && info.receipt.result !== "SUCCESS") return null;

  const contractHex = tw.address.toHex(USDT_CONTRACTS.TRC20).replace(/^41/, "").toLowerCase();
  const targetHex = tw.address.toHex(expectedTo).replace(/^41/, "").toLowerCase();

  for (const log of info.log) {
    if (String(log.address || "").toLowerCase() !== contractHex) continue;
    const topics = log.topics || [];
    if (!topics[0] || "0x" + topics[0].toLowerCase() !== TRANSFER_TOPIC) continue;
    const to = String(topics[2] || "").slice(24).toLowerCase();
    if (to !== targetHex) continue;
    return {
      txHash: info.id,
      from: tw.address.fromHex("41" + String(topics[1] || "").slice(24)),
      to: expectedTo,
      amount: fromUnits("TRC20", BigInt("0x" + log.data)),
      blockNumber: info.blockNumber,
    };
  }
  return null;
}

/* --------------------------------------------------- gas funding + sweep */

async function ensureBscGas(tempAddress) {
  const provider = getBscProvider();
  const balance = await provider.getBalance(tempAddress);
  if (balance >= GAS.BSC.minWei) return null;

  const key = process.env.BSC_MASTER_PRIVATE_KEY;
  if (!key) throw new Error("BSC_MASTER_PRIVATE_KEY is not configured");

  const master = new ethers.Wallet(key, provider);
  const tx = await master.sendTransaction({
    to: tempAddress,
    value: GAS.BSC.topUpWei - balance,
  });
  await tx.wait(1);
  return tx.hash;
}

async function sweepBsc(order) {
  const gasTxHash = await ensureBscGas(order.temp_address);
  const { privateKey } = deriveWallet("BSC", Number(order.hd_index));
  const signer = new ethers.Wallet(privateKey, getBscProvider());
  const contract = new ethers.Contract(USDT_CONTRACTS.BSC, ERC20_ABI, signer);

  const balance = await contract.balanceOf(order.temp_address);
  if (balance === 0n) return { gasTxHash, sweepTxHash: null, amount: 0 };

  const tx = await contract.transfer(MASTER_WALLETS.BSC, balance);
  await tx.wait(1);
  return { gasTxHash, sweepTxHash: tx.hash, amount: fromUnits("BSC", balance) };
}

async function ensureTronGas(tempAddress) {
  const tw = getTronWeb();
  const account = await tw.trx.getAccount(tempAddress);
  const balance = Number((account && account.balance) || 0);
  if (balance >= GAS.TRC20.minSun) return null;

  const key = process.env.TRON_MASTER_PRIVATE_KEY;
  if (!key) throw new Error("TRON_MASTER_PRIVATE_KEY is not configured");

  const masterTw = getTronWeb(key);
  const receipt = await masterTw.trx.sendTransaction(
    tempAddress,
    GAS.TRC20.topUpSun - balance
  );
  if (!receipt || receipt.result !== true) throw new Error("TRX gas funding rejected");
  await sleep(4000); // let the funding tx settle before the sweep
  return receipt.txid || receipt.transaction?.txID || null;
}

async function sweepTron(order) {
  const gasTxHash = await ensureTronGas(order.temp_address);
  const { privateKey } = deriveWallet("TRC20", Number(order.hd_index));
  const tw = getTronWeb(privateKey);

  const contract = await tw.contract().at(USDT_CONTRACTS.TRC20);
  const raw = await contract.balanceOf(order.temp_address).call();
  const balance = BigInt(raw.toString());
  if (balance === 0n) return { gasTxHash, sweepTxHash: null, amount: 0 };

  const sweepTxHash = await contract
    .transfer(MASTER_WALLETS.TRC20, balance.toString())
    .send({ feeLimit: 40_000_000 });

  return { gasTxHash, sweepTxHash, amount: fromUnits("TRC20", balance) };
}

/** Queue an order for gas funding + sweep. Idempotent per order. */
async function queueSweep(orderId) {
  await pool.query(
    `INSERT INTO usdt_sweeps (order_id, network, temp_address, master_wallet, amount, status)
     SELECT id, network, temp_address, master_wallet, received_amount, 'QUEUED'
       FROM usdt_orders WHERE id = $1
     ON CONFLICT (order_id) DO NOTHING`,
    [orderId]
  );
  await pool.query(
    `UPDATE usdt_orders SET sweep_status = 'QUEUED'
      WHERE id = $1 AND sweep_status IN ('NONE', 'SWEEP_FAILED')`,
    [orderId]
  );
}

async function runSweep(sweep) {
  const { rows } = await pool.query(`SELECT * FROM usdt_orders WHERE id = $1`, [sweep.order_id]);
  const order = rows[0];
  if (!order) return;

  await setSweepState(sweep.id, order.id, "GAS_FUNDING");

  const result = order.network === "BSC" ? await sweepBsc(order) : await sweepTron(order);

  await pool.query(
    `UPDATE usdt_sweeps
        SET status = 'SWEPT', gas_tx_hash = $2, sweep_tx_hash = $3, amount = $4, last_error = NULL
      WHERE id = $1`,
    [sweep.id, result.gasTxHash, result.sweepTxHash, result.amount]
  );
  await pool.query(`UPDATE usdt_orders SET sweep_status = 'SWEPT' WHERE id = $1`, [order.id]);
}

async function setSweepState(sweepId, orderId, state) {
  await pool.query(`UPDATE usdt_sweeps SET status = $2 WHERE id = $1`, [sweepId, state]);
  await pool.query(`UPDATE usdt_orders SET sweep_status = $2 WHERE id = $1`, [orderId, state]);
}

/* ---------------------------------------------------------- background loops */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let listenerTimer = null;
let sweepTimer = null;
let listenerBusy = false;
let sweepBusy = false;

/** 3-second listener: credits any PENDING order whose temp address holds USDT. */
async function listenerTick(creditOrder) {
  const { rows } = await pool.query(
    `UPDATE usdt_orders SET status = 'EXPIRED'
      WHERE status = 'PENDING' AND expires_at < NOW()
      RETURNING id`
  );
  if (rows.length) console.log(`[usdt-listener] expired ${rows.length} order(s)`);

  const { rows: pending } = await pool.query(
    `SELECT * FROM usdt_orders
      WHERE status = 'PENDING' AND expires_at > NOW()
      ORDER BY created_at ASC LIMIT 40`
  );

  for (const order of pending) {
    try {
      const balance = await getUsdtBalance(order.network, order.temp_address);
      if (balance > 0) {
        // Flexible crediting: whatever actually landed is what gets credited.
        await creditOrder(order, { amount: balance, txHash: null, source: "LISTENER" });
      }
    } catch (err) {
      console.error(`[usdt-listener] order ${order.order_ref}:`, err.message);
    }
  }
}

async function sweepTick() {
  const { rows } = await pool.query(
    `SELECT * FROM usdt_sweeps
      WHERE status IN ('QUEUED', 'GAS_FUNDING', 'SWEEPING', 'FAILED')
        AND attempts < $1
      ORDER BY created_at ASC LIMIT 5`,
    [MAX_SWEEP_ATTEMPTS]
  );

  for (const sweep of rows) {
    await pool.query(`UPDATE usdt_sweeps SET attempts = attempts + 1 WHERE id = $1`, [sweep.id]);
    try {
      await runSweep(sweep);
      console.log(`[usdt-sweeper] swept order ${sweep.order_id}`);
    } catch (err) {
      console.error(`[usdt-sweeper] order ${sweep.order_id}:`, err.message);
      await pool.query(
        `UPDATE usdt_sweeps SET status = 'FAILED', last_error = $2 WHERE id = $1`,
        [sweep.id, String(err.message).slice(0, 500)]
      );
      await pool.query(`UPDATE usdt_orders SET sweep_status = 'SWEEP_FAILED' WHERE id = $1`, [
        sweep.order_id,
      ]);
    }
  }
}

/**
 * Start both background loops.
 * @param {(order, hit) => Promise<any>} creditOrder credit callback from the controller
 */
function startUsdtSweeper(creditOrder) {
  if (listenerTimer) return;

  listenerTimer = setInterval(async () => {
    if (listenerBusy) return;
    listenerBusy = true;
    try {
      await listenerTick(creditOrder);
    } catch (err) {
      console.error("[usdt-listener]", err.message);
    } finally {
      listenerBusy = false;
    }
  }, LISTENER_INTERVAL_MS);

  sweepTimer = setInterval(async () => {
    if (sweepBusy) return;
    sweepBusy = true;
    try {
      await sweepTick();
    } catch (err) {
      console.error("[usdt-sweeper]", err.message);
    } finally {
      sweepBusy = false;
    }
  }, SWEEP_INTERVAL_MS);

  console.log("[usdt] listener (3s) + sweeper started");
}

function stopUsdtSweeper() {
  if (listenerTimer) clearInterval(listenerTimer);
  if (sweepTimer) clearInterval(sweepTimer);
  listenerTimer = null;
  sweepTimer = null;
}

module.exports = {
  pool,
  MASTER_WALLETS,
  USDT_CONTRACTS,
  DECIMALS,
  normalizeNetwork,
  deriveAddress,
  deriveWallet,
  getUsdtBalance,
  findUsdtTransfer,
  queueSweep,
  startUsdtSweeper,
  stopUsdtSweeper,
  toUnits,
  fromUnits,
};
