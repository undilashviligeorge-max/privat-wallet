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

/**
 * Sepolia — pinned MockUSDT. (Pool addresses vary by denomination key.)
 */
const MOCK_USDT_ADDRESS = "0x7F55f82979cb5cFdfe6DAaaDC96eF169EB63C52A";

/**
 * User-facing denomination keys → pool. Large (1 ETH / 1000 USDT) shares one deployment.
 * Keys must stay in sync with `frontend/src/App.jsx` `POOL_ADDRESSES`.
 */
const POOL_ADDRESSES_BY_DENOM_KEY = Object.freeze({
  "0.1_ETH": "0xA53f26482dD78Baac3d1eC84E9a643B89e750145",
  "100_USDT": "0xA53f26482dD78Baac3d1eC84E9a643B89e750145",
  "1_ETH": "0x5001DD1F346dc789967479BE64aAee5279C7Ea73",
  "1000_USDT": "0x5001DD1F346dc789967479BE64aAee5279C7Ea73",
});

/** Keep in sync with frontend `POOL_ADDRESSES` keys. */
const ALL_DENOM_KEYS = Object.freeze(["0.1_ETH", "1_ETH", "100_USDT", "1000_USDT"]);

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

/** Must match `TelegramPrivacyPool` withdrawal / errors. */
const POOL_ABI = [
  "error InvalidDenomConfig()",
  "error NullifierAlreadyUsed()",
  "error FeeExceedsDenomination()",
  "error ZeroAddress()",
  "error UnknownStateRoot()",
  "error UnknownAspRoot()",
  "error InvalidProof()",
  "error EthTransferFailed()",
  "error RecipientSanctioned(address)",
  "error RelayerSanctioned(address)",
  "error ERC20InsufficientBalance(address,uint256,uint256)",
  "error ERC20InvalidSender(address)",
  "error ERC20InvalidReceiver(address)",
  "error ERC20InsufficientAllowance(address,uint256,uint256)",
  "function withdraw(bytes proof, bytes32 stateRoot, bytes32 aspRoot, bytes32 nullifierHash, address payable recipient, address payable relayer, uint256 fee) external",
  "function withdrawUsdt(bytes proof, bytes32 stateRoot, bytes32 aspRoot, bytes32 nullifierHash, address recipient, address relayer, uint256 fee) external",
];

const POOL_DENOMS_READ_ABI = [
  "function ETH_DENOMINATION() view returns (uint256)",
  "function PROTOCOL_WITHDRAW_FEE_ETH() view returns (uint256)",
  "function USDT_DENOMINATION() view returns (uint256)",
  "function PROTOCOL_WITHDRAW_FEE_USDT() view returns (uint256)",
];

const poolDenomsCache = new Map();
const DENOM_KEYS = new Set(ALL_DENOM_KEYS);

async function readPoolDenoms(poolAddr) {
  const k = ethers.getAddress(poolAddr).toLowerCase();
  if (poolDenomsCache.has(k)) return poolDenomsCache.get(k);
  const c = new ethers.Contract(poolAddr, POOL_DENOMS_READ_ABI, provider);
  const [ETH_WEI, PROTOCOL_ETH_WEI, USDT_ATOMIC, PROTOCOL_USDT] = await Promise.all([
    c.ETH_DENOMINATION(),
    c.PROTOCOL_WITHDRAW_FEE_ETH(),
    c.USDT_DENOMINATION(),
    c.PROTOCOL_WITHDRAW_FEE_USDT(),
  ]);
  const row = { ETH_WEI, PROTOCOL_ETH_WEI, USDT_ATOMIC, PROTOCOL_USDT };
  poolDenomsCache.set(k, row);
  return row;
}

function normalizeDenomKey(raw) {
  const key = String(raw ?? "").trim();
  return DENOM_KEYS.has(key) ? key : null;
}

function resolvePoolAddressForDenomKey(denomKey) {
  const addr = POOL_ADDRESSES_BY_DENOM_KEY[denomKey];
  if (!addr || addr === ethers.ZeroAddress) return null;
  return ethers.getAddress(addr);
}

function denomKeyMatchesToken(token, denomKey) {
  if (token === "ETH") return denomKey === "0.1_ETH" || denomKey === "1_ETH";
  return denomKey === "100_USDT" || denomKey === "1000_USDT";
}

function defaultDenomKeyForToken(token) {
  return token === "ETH" ? "0.1_ETH" : "100_USDT";
}

function effectiveDenomKey(token, bodyDenomKey) {
  const normalized = normalizeDenomKey(bodyDenomKey);
  if (normalized && denomKeyMatchesToken(token, normalized)) return normalized;
  return defaultDenomKeyForToken(token);
}

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
function maxRelayerFeeForDenoms(token, denoms) {
  if (token === "USDT") {
    return denoms.USDT_ATOMIC - denoms.PROTOCOL_USDT;
  }
  return denoms.ETH_WEI - denoms.PROTOCOL_ETH_WEI;
}

/**
 * Pure profit: FEE_PERCENTAGE of the full on-chain note size (gross denomination).
 */
function computeProfitFeeForDenoms(token, denoms, feePercentage = parseFeePercentage()) {
  const bps = feePercentToBps(feePercentage);
  if (token === "USDT") {
    return (denoms.USDT_ATOMIC * bps) / 10_000n;
  }
  return (denoms.ETH_WEI * bps) / 10_000n;
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
async function computeRelayerFeeDetails(
  token,
  poolAddr,
  feePercentage = parseFeePercentage()
) {
  const denoms = await readPoolDenoms(poolAddr);
  const profit = computeProfitFeeForDenoms(token, denoms, feePercentage);
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
  const cap = maxRelayerFeeForDenoms(token, denoms);
  const capped = combined > cap;
  if (capped) {
    console.warn("[relayer] relayer fee exceeds max allowed by pool; capping", {
      token,
      poolAddr,
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

async function computeRelayerFeeForToken(token, poolAddr, feePercentage = parseFeePercentage()) {
  const { total } = await computeRelayerFeeDetails(token, poolAddr, feePercentage);
  return total;
}

async function buildFeeEntryForDenomKey(denomKey, feePercentage) {
  const poolAddr = resolvePoolAddressForDenomKey(denomKey);
  const token = denomKey.endsWith("_ETH") ? "ETH" : "USDT";
  if (!poolAddr) {
    return {
      denomKey,
      available: false,
      token,
      pool: null,
      relayerFee: null,
      breakdown: null,
    };
  }
  const details = await computeRelayerFeeDetails(token, poolAddr, feePercentage);
  return {
    denomKey,
    available: true,
    token,
    pool: poolAddr,
    relayerFee: details.total.toString(),
    breakdown: details.breakdown,
  };
}

async function buildFeesByDenomMap(feePercentage = parseFeePercentage()) {
  const entries = await Promise.all(
    ALL_DENOM_KEYS.map((k) => buildFeeEntryForDenomKey(k, feePercentage))
  );
  return Object.fromEntries(entries.map((e) => [e.denomKey, e]));
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
  const {
    recipient,
    token,
    proof,
    stateRoot,
    aspRoot,
    nullifierHash,
    fee,
    poolAddress,
    denomKey,
  } = p;

  if (!poolAddress) {
    const msg = "No pool address resolved for this denomination; deploy the pool or set POOL_ADDRESSES.";
    console.warn("[relayer]", msg, { token, recipient, denomKey });
    return { success: false, message: msg, token, pool: null, denomKey };
  }

  if (!hasFullZkBundle({ proof, stateRoot, aspRoot, nullifierHash, fee })) {
    const msg =
      "ZK bundle incomplete (need proof, stateRoot, aspRoot, nullifierHash, fee); on-chain withdraw not broadcast";
    console.warn("[relayer]", msg, { token, recipient, mockUsdt: MOCK_USDT_ADDRESS, pool: poolAddress });
    return { success: false, message: msg, token, pool: poolAddress, denomKey };
  }

  const pool = new ethers.Contract(poolAddress, POOL_ABI, relayerWallet);
  const feeWallet = await resolveFeeWalletAddress();
  const expectedRelayerFee = await computeRelayerFeeForToken(token, poolAddress);
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
      pool: poolAddress,
      denomKey,
      mockUsdt: token === "USDT" ? MOCK_USDT_ADDRESS : undefined,
      expectedRelayerFee: expectedRelayerFee.toString(),
      feeWallet,
    };
  }

  try {
    const txArgs = [proofBytes, sr, ar, nh, recipient, feeWallet, feeBn];
    const preflightError = await preflightWithdrawCall(pool, token, txArgs);
    if (preflightError) {
      console.error("[relayer] withdraw preflight revert", preflightError);
      return {
        success: false,
        message: preflightError,
        token,
        pool: poolAddress,
        denomKey,
        mockUsdt: token === "USDT" ? MOCK_USDT_ADDRESS : undefined,
        preflight: true,
      };
    }

    if (token === "USDT") {
      console.log(
        "[relayer] Broadcasting withdrawUsdt → pool",
        poolAddress,
        "MOCK_USDT",
        MOCK_USDT_ADDRESS,
        "feeWallet",
        feeWallet,
        "relayerFee",
        feeBn.toString(),
        "denomKey",
        denomKey
      );
      const tx = await pool.withdrawUsdt(...txArgs);
      const receipt = await tx.wait();
      console.log("[relayer] USDT withdrawal confirmed", receipt.hash);
      return {
        success: true,
        message: "USDT withdrawal confirmed",
        txHash: receipt.hash,
        token: "USDT",
        pool: poolAddress,
        denomKey,
        mockUsdt: MOCK_USDT_ADDRESS,
      };
    }

    console.log(
      "[relayer] Broadcasting withdraw (ETH) → pool",
      poolAddress,
      "feeWallet",
      feeWallet,
      "relayerFee",
      feeBn.toString(),
      "denomKey",
      denomKey
    );
    const tx = await pool.withdraw(...txArgs);
    const receipt = await tx.wait();
    console.log("[relayer] ETH withdrawal confirmed", receipt.hash);
    return {
      success: true,
      message: "ETH withdrawal confirmed",
      txHash: receipt.hash,
      token: "ETH",
      pool: poolAddress,
      denomKey,
    };
  } catch (e) {
    const msg = decodePoolError(pool.interface, e);
    console.error("[relayer] withdraw broadcast failed", msg);
    return {
      success: false,
      message: msg,
      token,
      pool: poolAddress,
      denomKey,
      mockUsdt: token === "USDT" ? MOCK_USDT_ADDRESS : undefined,
    };
  }
}

function decodePoolError(iface, err) {
  const fallback = err?.shortMessage || err?.reason || err?.message || String(err);
  const regexHex = (s) =>
    typeof s === "string" ? s.match(/0x[0-9a-fA-F]{8,}/g) || [] : [];
  const candidates = [
    err?.data,
    err?.error?.data,
    err?.info?.error?.data,
    err?.receipt?.revertReason,
    ...regexHex(err?.message),
    ...regexHex(err?.shortMessage),
    ...regexHex(err?.error?.message),
    ...regexHex(err?.info?.error?.message),
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

async function preflightWithdrawCall(pool, token, args) {
  try {
    if (token === "USDT") {
      await pool.withdrawUsdt.staticCall(...args);
    } else {
      await pool.withdraw.staticCall(...args);
    }
    return null;
  } catch (e) {
    return decodePoolError(pool.interface, e);
  }
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
    const denomKey = effectiveDenomKey(token, body.denomKey);
    const poolAddress = resolvePoolAddressForDenomKey(denomKey);
    if (!poolAddress) {
      res.status(400).json({
        success: false,
        message: `Pool not deployed for denomination ${denomKey}. Run deploy-large-pools and set POOL_ADDRESSES (frontend + relayer).`,
      });
      return;
    }

    const payload = {
      recipient: recipientNorm,
      commitment: commitment ?? null,
      token,
      withdrawSpeed,
      denomKey,
      poolAddress,
      proof,
      stateRoot,
      aspRoot,
      nullifierHash,
      fee,
    };

    if (delayMs === 0) {
      console.log(
        `[relayer] Instant ${token} withdraw for ${recipientNorm} sender=${senderNorm} (commitment=${commitment ?? "n/a"})`
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
          pool: poolAddress,
          denomKey,
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
      `[relayer] Queued ${token} withdrawal for ${recipientNorm} sender=${senderNorm} — withdrawSpeed=${withdrawSpeed} (${humanLabel} SLA; test timer ${delayMs}ms)`
    );

    setTimeout(() => {
      console.log(
        `[relayer] Executing queued ${withdrawSpeed} withdrawal for ${recipientNorm} sender=${senderNorm} (${token})`
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
      pool: poolAddress,
      denomKey,
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
    const feesByDenom = await buildFeesByDenomMap(pct);
    const poolEth = resolvePoolAddressForDenomKey("0.1_ETH");
    const poolUsdt = resolvePoolAddressForDenomKey("100_USDT");
    const [relayerFeeEth, relayerFeeUsdt] = await Promise.all([
      poolEth ? computeRelayerFeeForToken("ETH", poolEth, pct) : 0n,
      poolUsdt ? computeRelayerFeeForToken("USDT", poolUsdt, pct) : 0n,
    ]);
    res.json({
      success: true,
      address: signer,
      /** Receives on-chain relayer fee from the pool (ZK public input `relayer`). */
      feeWallet: await resolveFeeWalletAddress(),
      feePercentage: pct,
      relayerFeeEth: relayerFeeEth.toString(),
      relayerFeeUsdt: relayerFeeUsdt.toString(),
      poolAddresses: { ...POOL_ADDRESSES_BY_DENOM_KEY },
      feesByDenom,
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
    const feesByDenom = await buildFeesByDenomMap(pct);
    const poolEth = resolvePoolAddressForDenomKey("0.1_ETH");
    const poolUsdt = resolvePoolAddressForDenomKey("100_USDT");
    const [ethDetails, usdtDetails] = await Promise.all([
      poolEth ? computeRelayerFeeDetails("ETH", poolEth, pct) : Promise.resolve({ total: 0n, breakdown: null }),
      poolUsdt ? computeRelayerFeeDetails("USDT", poolUsdt, pct) : Promise.resolve({ total: 0n, breakdown: null }),
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
      poolAddresses: { ...POOL_ADDRESSES_BY_DENOM_KEY },
      feesByDenom,
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
    const feesByDenom = await buildFeesByDenomMap(pct);
    const poolEth = resolvePoolAddressForDenomKey("0.1_ETH");
    const poolUsdt = resolvePoolAddressForDenomKey("100_USDT");
    const [relayerFeeEth, relayerFeeUsdt] = await Promise.all([
      poolEth ? computeRelayerFeeForToken("ETH", poolEth, pct) : 0n,
      poolUsdt ? computeRelayerFeeForToken("USDT", poolUsdt, pct) : 0n,
    ]);
    res.json({
      success: true,
      message: "Relayer endpoint active",
      poolAddresses: { ...POOL_ADDRESSES_BY_DENOM_KEY },
      feesByDenom,
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
  console.log("Pools (by denom key):", { ...POOL_ADDRESSES_BY_DENOM_KEY });
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
      const pE = resolvePoolAddressForDenomKey("0.1_ETH");
      const pU = resolvePoolAddressForDenomKey("100_USDT");
      const [fEth, fUsdt] = await Promise.all([
        pE ? computeRelayerFeeForToken("ETH", pE, pct) : 0n,
        pU ? computeRelayerFeeForToken("USDT", pU, pct) : 0n,
      ]);
      console.log("Sample relayer fee (0.1_ETH pool) wei:", fEth.toString());
      console.log("Sample relayer fee (100_USDT pool) atomic:", fUsdt.toString());
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
