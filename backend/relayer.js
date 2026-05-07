import { ethers } from "ethers";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

/** Deployed TelegramPrivacyPool on Sepolia (updated after deploy). */
const POOL_ADDRESS = "0x77490d9542F85B12fE888924930CC3de7fabfaB2";

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

app.post("/relay", async (req, res) => {
  res.json({
    success: true,
    message: "Relayer endpoint active",
    pool: POOL_ADDRESS,
  });
});

app.listen(3000, async () => {
  console.log("Relayer is running on port 3000");
  console.log("Pool:", POOL_ADDRESS);
  console.log("Relayer wallet:", await relayerWallet.getAddress());
});
