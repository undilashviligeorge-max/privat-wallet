import { ethers } from "ethers";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

/** Listen on all interfaces (Railway / Docker). */
const RELAYER_HOST = "0.0.0.0";

const startupDiagnostics = {
  warnings: [],
  errors: [],
};

function addStartupWarning(msg) {
  startupDiagnostics.warnings.push(msg);
  console.warn(`[relayer][startup] ${msg}`);
}

function addStartupError(msg) {
  startupDiagnostics.errors.push(msg);
  console.error(`[relayer][startup] ${msg}`);
}

function envFirst(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

/** Deployed TelegramPrivacyPool on Sepolia (override with POOL_ADDRESS in .env). */
const POOL_ADDRESS =
  process.env.POOL_ADDRESS?.trim() ||
  "0xdF91714EAC240b6c5AA652669f11Ef1776BbB2a9";

/** Mock ERC20 USDT used by the pool on Sepolia (override with MOCK_USDT_ADDRESS in .env). */
const MOCK_USDT_ADDRESS =
  process.env.MOCK_USDT_ADDRESS?.trim() ||
  "0xDe1090EbcDb237C5437b81BfCE6663959BED67c0";

/**
 * Static AML / OFAC-style blocklist (lowercase checksummed normalization).
 * Extend via env `COMPLIANCE_BLOCKLIST=0xabc,0xdef` (comma-separated).
 */
const STATIC_COMPLIANCE_BLOCKLIST = [
  "0x000000000000000000000000000000000000dEaD",
];

function parseOptionalAddressList(raw) {
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const complianceBlocklist = new Set(
  [
    ...STATIC_COMPLIANCE_BLOCKLIST,
    ...parseOptionalAddressList(process.env.COMPLIANCE_BLOCKLIST),
  ]
    .filter((a) => ethers.isAddress(a))
    .map((a) => ethers.getAddress(a).toLowerCase())
);

function isSanctionedAddress(addr) {
  if (addr == null || addr === "") return false;
  if (!ethers.isAddress(String(addr))) return false;
  try {
    return complianceBlocklist.has(ethers.getAddress(String(addr)).toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Express middleware: before any relay withdrawal, block sanctioned sender/recipient (403).
 */
function sanctionsComplianceMiddleware(req, res, next) {
  if (req.method !== "POST") return next();
  const path = req.path || "";
  const body = req.body || {};
  const isWithdrawRelay =
    path === "/withdraw" || (path === "/relay" && body.action === "withdraw");
  if (!isWithdrawRelay) return next();

  if (isSanctionedAddress(body.recipient)) {
    console.warn("[relayer][aml] blocked withdrawal: sanctioned recipient", body.recipient);
    res.status(403).json({
      success: false,
      message: "Address blocked due to compliance policies.",
    });
    return;
  }
  if (isSanctionedAddress(body.sender)) {
    console.warn("[relayer][aml] blocked withdrawal: sanctioned sender", body.sender);
    res.status(403).json({
      success: false,
      message: "Address blocked due to compliance policies.",
    });
    return;
  }
  next();
}

/** Must match `TelegramPrivacyPool` constants (used to compute relayer fee from FEE_PERCENTAGE). */
const POOL_DENOMS = Object.freeze({
  ETH_WEI: 10n ** 16n, // 0.01 ether
  PROTOCOL_ETH_WEI: 10n ** 15n, // 0.001 ether
  USDT: 100n * 1_000_000n, // 100 * 1e6
  PROTOCOL_USDT: 100_000n, // 0.1 USDT (6 decimals) — must match `TelegramPrivacyPool.PROTOCOL_WITHDRAW_FEE_USDT`
});

const POOL_ABI = [
  "error NullifierAlreadyUsed()",
  "error FeeExceedsDenomination()",
  "error ZeroAddress()",
  "error UnknownStateRoot()",
  "error UnknownAspRoot()",
  "error InvalidProof()",
  "error EthTransferFailed()",
  "error RecipientSanctioned(address)",
  "error RelayerSanctioned(address)",
  "function withdraw(bytes proof, bytes32 stateRoot, bytes32 aspRoot, bytes32 nullifierHash, address payable recipient, address payable relayer, uint256 fee) external",
  "function withdrawUsdt(bytes proof, bytes32 stateRoot, bytes32 aspRoot, bytes32 nullifierHash, address recipient, address relayer, uint256 fee) external",
];

/**
 * Integration-test stand-in for 12h / 24h queues. Logs label the real SLA; timers stay short locally.
 */
const WITHDRAW_QUEUE_TEST_MS = Object.freeze({
  "12h": 5_000,
  "24h": 10_000,
});

/** Default when no paid RPC is configured; avoids Tatum gateway 402 on free tier writes. */
const PUBLIC_SEPOLIA_RPC =
  process.env.SEPOLIA_RPC_FALLBACK?.trim() ||
  "https://ethereum-sepolia-rpc.publicnode.com";

function sanitizeRpcUrl(raw) {
  if (!raw) return "";
  let v = String(raw).trim();
  // Tolerate accidental markdown paste: [https://...] or (https://...)
  if (
    (v.startsWith("[") && v.endsWith("]")) ||
    (v.startsWith("(") && v.endsWith(")"))
  ) {
    v = v.slice(1, -1).trim();
  }
  // Tolerate markdown link strings: [label](https://...)
  const mdLink = v.match(/\((https?:\/\/[^)\s]+)\)\s*$/);
  if (mdLink?.[1]) return mdLink[1].trim();
  return v;
}

function createSepoliaProvider() {
  const sep = sanitizeRpcUrl(envFirst("RPC_URL_SEPOLIA", "SEPOLIA_RPC_URL"));
  if (sep && (sep.startsWith("http://") || sep.startsWith("https://"))) {
    return new ethers.JsonRpcProvider(sep);
  }

  const raw = sanitizeRpcUrl(process.env.TATUM_RPC_URL);
  if (!raw) {
    console.warn(
      "[relayer] No TATUM_RPC_URL; using public Sepolia RPC. Set SEPOLIA_RPC_URL or TATUM_RPC_URL."
    );
    return new ethers.JsonRpcProvider(PUBLIC_SEPOLIA_RPC);
  }

  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return new ethers.JsonRpcProvider(raw);
  }

  // Bare string = Tatum API key. Free gateway often returns HTTP 402 on eth_sendRawTransaction / eth_call.
  console.warn(
    "[relayer] TATUM_RPC_URL is an API key; using public Sepolia RPC for JSON-RPC (set SEPOLIA_RPC_URL=https://… for your own node)."
  );
  return new ethers.JsonRpcProvider(PUBLIC_SEPOLIA_RPC);
}

const provider = createSepoliaProvider();
const pk = process.env.PRIVATE_KEY?.trim();
let relayerWallet = null;
if (!pk) {
  addStartupError("Missing PRIVATE_KEY; withdrawal broadcasting is disabled.");
} else {
  try {
    relayerWallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, provider);
  } catch (e) {
    addStartupError(`Invalid PRIVATE_KEY format; withdrawal broadcasting is disabled. ${e?.message || e}`);
  }
}

/** @returns {number} Percent 0–100 (e.g. 0.1 = 0.1%). Default 0.1. */
function parseFeePercentage() {
  const raw = process.env.FEE_PERCENTAGE?.trim();
  if (!raw) return 0.1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) return 0.1;
  return n;
}

/** Basis points: 1% → 100 bps, 0.1% → 10 bps. */
function feePercentToBps(percent) {
  return BigInt(Math.min(10_000, Math.max(0, Math.round(percent * 100))));
}

function ceilDiv(a, b) {
  if (b === 0n) return 0n;
  return (a + b - 1n) / b;
}

/** Max pool payout to relayer + recipient slice (denomination − protocol fee). */
function maxRelayerFeeForToken(token) {
  if (token === "USDT") {
    return POOL_DENOMS.USDT - POOL_DENOMS.PROTOCOL_USDT;
  }
  return POOL_DENOMS.ETH_WEI - POOL_DENOMS.PROTOCOL_ETH_WEI;
}

/**
 * Pure profit: FEE_PERCENTAGE of the full on-chain note size (gross denomination).
 */
function computeProfitFee(token, feePercentage = parseFeePercentage()) {
  const bps = feePercentToBps(feePercentage);
  if (token === "USDT") {
    return (POOL_DENOMS.USDT * bps) / 10_000n;
  }
  return (POOL_DENOMS.ETH_WEI * bps) / 10_000n;
}

/**
 * USDT (6 decimals) atomic units per 1 ETH — for converting estimated gas (wei) into USDT.
 * Example: 2500000000 = 2500 USDT per ETH.
 */
function parseUsdtPerEthAtomic() {
  const raw = process.env.FEE_USDT_PER_ETH_USDT_ATOMIC?.trim();
  if (raw) {
    try {
      return BigInt(raw);
    } catch {
      /* fall through */
    }
  }
  return 2_500_000_000n;
}

/** Multiplier on gas cost in bps (10000 = 1.0). Default 11500 = +15% cushion. */
function parseGasCostMultiplierBps() {
  const raw = process.env.FEE_GAS_COST_MULT_BPS?.trim();
  if (!raw) return 11_500n;
  try {
    const v = BigInt(raw);
    return v < 10_000n ? 10_000n : v;
  } catch {
    return 11_500n;
  }
}

function parseEstGasUnits(token) {
  const key = token === "USDT" ? "FEE_EST_GAS_USDT" : "FEE_EST_GAS_ETH";
  const def = token === "USDT" ? "400000" : "350000";
  const raw = process.env[key]?.trim() || def;
  try {
    const g = BigInt(raw);
    return g > 0n ? g : BigInt(def);
  } catch {
    return BigInt(def);
  }
}

async function estimateWithdrawGasCostWei(token) {
  const units = parseEstGasUnits(token);
  let fd;
  try {
    fd = await provider.getFeeData();
  } catch {
    fd = {};
  }
  let wei = fd.maxFeePerGas ?? fd.gasPrice ?? 0n;
  if (wei === 0n) {
    const gwei = process.env.FEE_FALLBACK_GAS_PRICE_GWEI?.trim() || "30";
    wei = ethers.parseUnits(gwei, "gwei");
  }
  const mult = parseGasCostMultiplierBps();
  return ceilDiv(units * wei * mult, 10_000n);
}

/**
 * Total relayer fee inside the pool: `FEE_PERCENTAGE` of gross note (e.g. 0.1% → 0.1 USDT on 100 USDT).
 * ETH path adds wei gas estimate; USDT path is profit-only so relayer fee stays exactly that percentage (relayer pays gas in ETH).
 * Capped so fee + protocol ≤ denomination (must match deployed `TelegramPrivacyPool` constants).
 */
async function computeRelayerFeeDetails(token, feePercentage = parseFeePercentage()) {
  const profit = computeProfitFee(token, feePercentage);
  const gasWei = await estimateWithdrawGasCostWei(token);
  let gasCoverageInToken;
  let combined;
  if (token === "USDT") {
    gasCoverageInToken = 0n;
    combined = profit;
  } else {
    gasCoverageInToken = gasWei;
    combined = profit + gasWei;
  }
  const cap = maxRelayerFeeForToken(token);
  const capped = combined > cap;
  if (capped) {
    console.warn("[relayer] relayer fee exceeds max allowed by pool; capping", {
      token,
      combined: combined.toString(),
      cap: cap.toString(),
    });
  }
  const total = capped ? cap : combined;
  return {
    total,
    breakdown: {
      profit: profit.toString(),
      gasCoverage: gasCoverageInToken.toString(),
      estimatedGasWei: gasWei.toString(),
      total: total.toString(),
      capped,
      ...(capped ? { uncappedCombined: combined.toString() } : {}),
    },
  };
}

async function computeRelayerFeeForToken(token, feePercentage = parseFeePercentage()) {
  const { total } = await computeRelayerFeeDetails(token, feePercentage);
  return total;
}

let cachedFeeWallet = null;
async function resolveFeeWalletAddress() {
  if (cachedFeeWallet) return cachedFeeWallet;
  const raw = process.env.FEE_WALLET_ADDRESS?.trim();
  if (raw) {
    if (ethers.isAddress(raw)) {
      cachedFeeWallet = ethers.getAddress(raw);
      return cachedFeeWallet;
    }
    console.warn(
      "[relayer] FEE_WALLET_ADDRESS is not a valid address; using relayer signer as fee wallet"
    );
  }
  if (!relayerWallet) {
    throw new Error(
      "FEE_WALLET_ADDRESS is missing/invalid and relayer signer is unavailable (check PRIVATE_KEY)"
    );
  }
  cachedFeeWallet = await relayerWallet.getAddress();
  return cachedFeeWallet;
}

const app = express();

/** Reflect browser Origin (`credentials: false`) — works for every Vercel URL without maintaining an allowlist. */
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS", "HEAD"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
      "Origin",
      "X-Requested-With",
      "ngrok-skip-browser-warning",
    ],
    credentials: false,
    optionsSuccessStatus: 204,
  })
);
app.use(express.json({ limit: "4mb" }));
app.use(sanctionsComplianceMiddleware);

app.get("/", (_req, res) => {
  res.send("Relayer is alive and running!");
});

function relayerNotReadyPayload() {
  return {
    success: false,
    message:
      "Relayer started in degraded mode. Check Railway logs for missing/invalid environment variables.",
    diagnostics: startupDiagnostics,
  };
}

function ensureRelayerReady(res) {
  if (relayerWallet) return true;
  if (res) {
    res.status(503).json(relayerNotReadyPayload());
  }
  return false;
}

function normalizeWithdrawSpeed(speed) {
  if (speed === "12h" || speed === "24h" || speed === "instant") return speed;
  return "instant";
}

function queueDelayMs(speed) {
  if (speed === "12h") return WITHDRAW_QUEUE_TEST_MS["12h"];
  if (speed === "24h") return WITHDRAW_QUEUE_TEST_MS["24h"];
  return 0;
}

function normalizeToken(token) {
  return String(token || "ETH").toUpperCase() === "USDT" ? "USDT" : "ETH";
}

function hasFullZkBundle({
  proof,
  stateRoot,
  aspRoot,
  nullifierHash,
  fee,
}) {
  if (proof == null || proof === "") return false;
  if (stateRoot == null || stateRoot === "") return false;
  if (aspRoot == null || aspRoot === "") return false;
  if (nullifierHash == null || nullifierHash === "") return false;
  if (fee === undefined || fee === null || fee === "") return false;
  return true;
}

function toProofBytes(proof) {
  if (typeof proof === "string") {
    const s = proof.trim();
    if (s.startsWith("[")) {
      throw new Error(
        "proof must be ABI-encoded Groth16 bytes (0x hex), not snarkjs exportSolidityCallData bracket text"
      );
    }
    const hex = s.startsWith("0x") ? s : `0x${s}`;
    if (hex.length > 2 && !ethers.isHexString(hex)) {
      throw new Error("proof is not valid hex");
    }
    return hex;
  }
  if (proof instanceof Uint8Array) return ethers.hexlify(proof);
  throw new Error("Unsupported proof type (expected hex string or Uint8Array)");
}

function toBytes32(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a hex string`);
  }
  const v = value.startsWith("0x") ? value : `0x${value}`;
  const bytes = ethers.getBytes(v);
  if (bytes.length !== 32) {
    throw new Error(`${label} must be 32 bytes`);
  }
  return v;
}

/**
 * @param {object} p
 * @param {string} p.recipient
 * @param {string} p.token "ETH" | "USDT"
 */
async function tryBroadcastWithdraw(p) {
  const { recipient, token, proof, stateRoot, aspRoot, nullifierHash, fee } = p;

  if (!hasFullZkBundle({ proof, stateRoot, aspRoot, nullifierHash, fee })) {
    const msg =
      "ZK bundle incomplete (need proof, stateRoot, aspRoot, nullifierHash, fee); on-chain withdraw not broadcast";
    console.warn("[relayer]", msg, { token, recipient, mockUsdt: MOCK_USDT_ADDRESS });
    return { success: false, message: msg, token, pool: POOL_ADDRESS };
  }

  const pool = new ethers.Contract(POOL_ADDRESS, POOL_ABI, relayerWallet);
  const feeWallet = await resolveFeeWalletAddress();
  const expectedRelayerFee = await computeRelayerFeeForToken(token);
  const proofBytes = toProofBytes(proof);
  const sr = toBytes32(stateRoot, "stateRoot");
  const ar = toBytes32(aspRoot, "aspRoot");
  const nh = toBytes32(nullifierHash, "nullifierHash");
  const feeBn = typeof fee === "bigint" ? fee : BigInt(fee);

  if (feeBn !== expectedRelayerFee) {
    const msg = `Relayer fee mismatch: request has ${feeBn.toString()} but server expects ${expectedRelayerFee.toString()} for ${token} (${parseFeePercentage()}% profit on note + gas coverage; see GET /fee-config). Regenerate the ZK witness.`;
    console.warn("[relayer]", msg);
    return {
      success: false,
      message: msg,
      token,
      pool: POOL_ADDRESS,
      mockUsdt: token === "USDT" ? MOCK_USDT_ADDRESS : undefined,
      expectedRelayerFee: expectedRelayerFee.toString(),
      feeWallet,
    };
  }

  try {
    if (token === "USDT") {
      console.log(
        "[relayer] Broadcasting withdrawUsdt → pool",
        POOL_ADDRESS,
        "MOCK_USDT",
        MOCK_USDT_ADDRESS,
        "feeWallet",
        feeWallet,
        "relayerFee",
        feeBn.toString()
      );
      const tx = await pool.withdrawUsdt(proofBytes, sr, ar, nh, recipient, feeWallet, feeBn);
      const receipt = await tx.wait();
      console.log("[relayer] USDT withdrawal confirmed", receipt.hash);
      return {
        success: true,
        message: "USDT withdrawal confirmed",
        txHash: receipt.hash,
        token: "USDT",
        pool: POOL_ADDRESS,
        mockUsdt: MOCK_USDT_ADDRESS,
      };
    }

    console.log(
      "[relayer] Broadcasting withdraw (ETH) → pool",
      POOL_ADDRESS,
      "feeWallet",
      feeWallet,
      "relayerFee",
      feeBn.toString()
    );
    const tx = await pool.withdraw(proofBytes, sr, ar, nh, recipient, feeWallet, feeBn);
    const receipt = await tx.wait();
    console.log("[relayer] ETH withdrawal confirmed", receipt.hash);
    return {
      success: true,
      message: "ETH withdrawal confirmed",
      txHash: receipt.hash,
      token: "ETH",
      pool: POOL_ADDRESS,
    };
  } catch (e) {
    const msg = decodePoolError(pool.interface, e);
    console.error("[relayer] withdraw broadcast failed", msg);
    return {
      success: false,
      message: msg,
      token,
      pool: POOL_ADDRESS,
      mockUsdt: token === "USDT" ? MOCK_USDT_ADDRESS : undefined,
    };
  }
}

function decodePoolError(iface, err) {
  const fallback = err?.shortMessage || err?.reason || err?.message || String(err);
  const candidates = [
    err?.data,
    err?.error?.data,
    err?.info?.error?.data,
    err?.receipt?.revertReason,
  ].filter((v) => typeof v === "string" && v.startsWith("0x"));

  for (const data of candidates) {
    try {
      const parsed = iface.parseError(data);
      if (!parsed) continue;
      const args =
        parsed.args && parsed.args.length
          ? `(${parsed.args.map((x) => String(x)).join(", ")})`
          : "()";
      return `${parsed.name}${args}`;
    } catch {
      // keep trying other payload variants
    }
  }

  return fallback;
}

async function handleWithdraw(req, res) {
  try {
    const body = req.body || {};
    const {
      recipient,
      sender,
      commitment,
      token: rawToken,
      withdrawSpeed: rawSpeed,
      proof,
      stateRoot,
      aspRoot,
      nullifierHash,
      fee,
    } = body;

    if (!recipient || !ethers.isAddress(recipient)) {
      res.status(400).json({ success: false, message: "Invalid or missing recipient" });
      return;
    }

    if (!sender || !ethers.isAddress(sender)) {
      res.status(400).json({
        success: false,
        message: "Invalid or missing sender (connected wallet address)",
      });
      return;
    }

    const recipientNorm = ethers.getAddress(recipient);
    const senderNorm = ethers.getAddress(sender);
    const token = normalizeToken(rawToken);
    const withdrawSpeed = normalizeWithdrawSpeed(rawSpeed);
    const delayMs = queueDelayMs(withdrawSpeed);

    const payload = {
      recipient: recipientNorm,
      commitment: commitment ?? null,
      token,
      withdrawSpeed,
      proof,
      stateRoot,
      aspRoot,
      nullifierHash,
      fee,
    };

    if (delayMs === 0) {
      console.log(
        `[relayer] Instant ${token} withdraw for ${recipientNorm} (commitment=${commitment ?? "n/a"})`
      );
      const result = await tryBroadcastWithdraw(payload);
      const softReady =
        !result.success &&
        typeof result.message === "string" &&
        result.message.includes("ZK bundle incomplete");

      if (softReady) {
        res.json({
          success: true,
          message: `Instant withdrawal accepted (${token}); relayer ready — broadcast skipped until ZK inputs are supplied.`,
          token,
          withdrawSpeed,
          commitment: commitment ?? null,
          pool: POOL_ADDRESS,
          ...(token === "USDT" ? { mockUsdt: MOCK_USDT_ADDRESS } : {}),
          stagingNote: result.message,
        });
        return;
      }

      res.json(result);
      return;
    }

    const humanLabel = withdrawSpeed === "12h" ? "12 hours" : "24 hours";
    console.log(
      `[relayer] Queued ${token} withdrawal for ${recipientNorm} — withdrawSpeed=${withdrawSpeed} (${humanLabel} SLA; test timer ${delayMs}ms)`
    );

    setTimeout(() => {
      console.log(
        `[relayer] Executing queued ${withdrawSpeed} withdrawal for ${recipientNorm} (${token})`
      );
      tryBroadcastWithdraw(payload).catch((err) =>
        console.error("[relayer] queued withdraw runner error", err)
      );
    }, delayMs);

    res.json({
      success: true,
      queued: true,
      message: `Withdrawal queued for ${withdrawSpeed} (${humanLabel}); test firing in ${delayMs}ms`,
      withdrawSpeed,
      token,
      commitment: commitment ?? null,
      pool: POOL_ADDRESS,
      ...(token === "USDT" ? { mockUsdt: MOCK_USDT_ADDRESS } : {}),
    });
  } catch (e) {
    console.error("[relayer] /withdraw error", e);
    res.status(500).json({ success: false, message: e?.message || String(e) });
  }
}

app.get("/relayer-address", async (_req, res) => {
  if (!ensureRelayerReady(res)) return;
  try {
    const signer = await relayerWallet.getAddress();
    const pct = parseFeePercentage();
    const [relayerFeeEth, relayerFeeUsdt] = await Promise.all([
      computeRelayerFeeForToken("ETH", pct),
      computeRelayerFeeForToken("USDT", pct),
    ]);
    res.json({
      success: true,
      address: signer,
      /** Receives on-chain relayer fee from the pool (ZK public input `relayer`). */
      feeWallet: await resolveFeeWalletAddress(),
      feePercentage: pct,
      relayerFeeEth: relayerFeeEth.toString(),
      relayerFeeUsdt: relayerFeeUsdt.toString(),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e?.message || String(e) });
  }
});

app.get("/fee-config", async (_req, res) => {
  if (!ensureRelayerReady(res)) return;
  try {
    const signer = await relayerWallet.getAddress();
    const pct = parseFeePercentage();
    const [ethDetails, usdtDetails] = await Promise.all([
      computeRelayerFeeDetails("ETH", pct),
      computeRelayerFeeDetails("USDT", pct),
    ]);
    res.json({
      success: true,
      relayerSigner: signer,
      feeWallet: await resolveFeeWalletAddress(),
      feePercentage: pct,
      relayerFeeEth: ethDetails.total.toString(),
      relayerFeeUsdt: usdtDetails.total.toString(),
      breakdownEth: ethDetails.breakdown,
      breakdownUsdt: usdtDetails.breakdown,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e?.message || String(e) });
  }
});

function sendBurnerWallet(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  const w = ethers.Wallet.createRandom();
  res.json({
    address: w.address,
    privateKey: w.privateKey,
  });
}

app.get("/generate-burner", (_req, res) => sendBurnerWallet(res));
app.post("/generate-burner", (_req, res) => sendBurnerWallet(res));

app.post("/withdraw", handleWithdraw);

app.post("/relay", async (req, res) => {
  if (!ensureRelayerReady(res)) return;
  try {
    if (req.body && req.body.action === "withdraw") {
      return handleWithdraw(req, res);
    }
    const signer = await relayerWallet.getAddress();
    const pct = parseFeePercentage();
    const [relayerFeeEth, relayerFeeUsdt] = await Promise.all([
      computeRelayerFeeForToken("ETH", pct),
      computeRelayerFeeForToken("USDT", pct),
    ]);
    res.json({
      success: true,
      message: "Relayer endpoint active",
      pool: POOL_ADDRESS,
      mockUsdt: MOCK_USDT_ADDRESS,
      relayerAddress: signer,
      feeWallet: await resolveFeeWalletAddress(),
      feePercentage: pct,
      relayerFeeEth: relayerFeeEth.toString(),
      relayerFeeUsdt: relayerFeeUsdt.toString(),
    });
  } catch (e) {
    console.error("[relayer] /relay error", e);
    res.status(500).json({ success: false, message: e?.message || String(e) });
  }
});

const port = process.env.PORT || 3000;
app.use((err, _req, res, _next) => {
  console.error("[relayer] unhandled express error", err);
  if (res.headersSent) return;
  res.status(500).json({ success: false, message: "Internal server error" });
});

async function logStartupDetails() {
  console.log("Pool:", POOL_ADDRESS);
  console.log("Mock USDT:", MOCK_USDT_ADDRESS);
  console.log("CORS: permissive (reflect request Origin; credentials=false)");
  if (relayerWallet) {
    const signer = await relayerWallet.getAddress();
    console.log("Relayer wallet:", signer);
  } else {
    addStartupWarning("Relayer signer unavailable; only health checks and diagnostics routes should be used.");
  }
  try {
    console.log("Fee wallet:", await resolveFeeWalletAddress());
  } catch (e) {
    addStartupError(e?.message || String(e));
  }
  const pct = parseFeePercentage();
  console.log("FEE_PERCENTAGE:", pct, "% (USDT: profit-only relayer fee; ETH: profit + gas wei)");
  if (relayerWallet) {
    try {
      const [fEth, fUsdt] = await Promise.all([
        computeRelayerFeeForToken("ETH", pct),
        computeRelayerFeeForToken("USDT", pct),
      ]);
      console.log("Sample relayer fee ETH wei:", fEth.toString());
      console.log("Sample relayer fee USDT atomic:", fUsdt.toString());
    } catch (e) {
      console.warn("[relayer] could not precompute fees:", e?.message || e);
    }
  }
  if (startupDiagnostics.errors.length > 0) {
    console.error("[relayer] startup diagnostics errors:", startupDiagnostics.errors);
  }
  if (startupDiagnostics.warnings.length > 0) {
    console.warn("[relayer] startup diagnostics warnings:", startupDiagnostics.warnings);
  }
}

async function startServer() {
  try {
    app.listen(port, RELAYER_HOST, async () => {
      console.log(`Relayer is running on ${RELAYER_HOST}:${port}`);
      await logStartupDetails();
    });
  } catch (e) {
    console.error("[relayer] failed to start server", e);
    process.exitCode = 1;
  }
}

process.on("uncaughtException", (err) => {
  console.error("[relayer] uncaughtException", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[relayer] unhandledRejection", reason);
});

startServer();
