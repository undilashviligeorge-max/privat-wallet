import { ethers } from "ethers";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

/** Deployed TelegramPrivacyPool on Sepolia (override with POOL_ADDRESS in .env). */
const POOL_ADDRESS =
  process.env.POOL_ADDRESS?.trim() ||
  "0x84025852E750693826bC12596F1E917343CFdbAE";

/** Mock ERC20 USDT used by the pool on Sepolia (override with MOCK_USDT_ADDRESS in .env). */
const MOCK_USDT_ADDRESS =
  process.env.MOCK_USDT_ADDRESS?.trim() ||
  "0x41DA8EaeC31F04bf29f1c30F046DD9A1Eef1218A";

const POOL_ABI = [
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

function createSepoliaProvider() {
  const raw = process.env.TATUM_RPC_URL?.trim();
  if (!raw) throw new Error("Missing TATUM_RPC_URL");
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return new ethers.JsonRpcProvider(raw);
  }
  const req = new ethers.FetchRequest("https://ethereum-sepolia.gateway.tatum.io/");
  req.setHeader("x-api-key", raw);
  return new ethers.JsonRpcProvider(req);
}

const provider = createSepoliaProvider();
const pk = process.env.PRIVATE_KEY?.trim();
const relayerWallet = new ethers.Wallet(
  pk?.startsWith("0x") ? pk : `0x${pk}`,
  provider
);

const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "ngrok-skip-browser-warning"],
  })
);
app.use(express.json());

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
    return proof.startsWith("0x") ? proof : `0x${proof}`;
  }
  if (proof instanceof Uint8Array) return ethers.hexlify(proof);
  return ethers.hexlify(proof);
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
  const relayerAddr = await relayerWallet.getAddress();
  const proofBytes = toProofBytes(proof);
  const sr = toBytes32(stateRoot, "stateRoot");
  const ar = toBytes32(aspRoot, "aspRoot");
  const nh = toBytes32(nullifierHash, "nullifierHash");
  const feeBn = typeof fee === "bigint" ? fee : BigInt(fee);

  try {
    if (token === "USDT") {
      console.log("[relayer] Broadcasting withdrawUsdt → pool", POOL_ADDRESS, "MOCK_USDT", MOCK_USDT_ADDRESS);
      const tx = await pool.withdrawUsdt(proofBytes, sr, ar, nh, recipient, relayerAddr, feeBn);
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

    console.log("[relayer] Broadcasting withdraw (ETH) → pool", POOL_ADDRESS);
    const tx = await pool.withdraw(proofBytes, sr, ar, nh, recipient, relayerAddr, feeBn);
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
    const msg = e?.shortMessage || e?.reason || e?.message || String(e);
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

async function handleWithdraw(req, res) {
  try {
    const body = req.body || {};
    const {
      recipient,
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

    const recipientNorm = ethers.getAddress(recipient);
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

app.get("/generate-burner", (req, res) => {
  const w = ethers.Wallet.createRandom();
  res.json({
    address: w.address,
    privateKey: w.privateKey,
  });
});

app.post("/withdraw", handleWithdraw);

app.post("/relay", async (req, res) => {
  if (req.body && req.body.action === "withdraw") {
    return handleWithdraw(req, res);
  }
  res.json({
    success: true,
    message: "Relayer endpoint active",
    pool: POOL_ADDRESS,
    mockUsdt: MOCK_USDT_ADDRESS,
  });
});

app.listen(3000, async () => {
  console.log("Relayer is running on port 3000");
  console.log("Pool:", POOL_ADDRESS);
  console.log("Mock USDT:", MOCK_USDT_ADDRESS);
  console.log("Relayer wallet:", await relayerWallet.getAddress());
});
