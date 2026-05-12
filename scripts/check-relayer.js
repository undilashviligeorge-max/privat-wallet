import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

const PUBLIC_SEPOLIA_RPC =
  process.env.SEPOLIA_RPC_URL?.trim() ||
  "https://ethereum-sepolia-rpc.publicnode.com";

function envFirst(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function resolveRpcUrl() {
  const direct = envFirst("SEPOLIA_RPC_URL", "RPC_URL_SEPOLIA");
  if (direct) return direct;
  const tatum = process.env.TATUM_RPC_URL?.trim();
  if (tatum?.startsWith("http://") || tatum?.startsWith("https://")) return tatum;
  return PUBLIC_SEPOLIA_RPC;
}

async function main() {
  const pk = process.env.PRIVATE_KEY?.trim();
  if (!pk) throw new Error("Missing PRIVATE_KEY in .env");
  const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
  const provider = new ethers.JsonRpcProvider(resolveRpcUrl());
  const balanceWei = await provider.getBalance(wallet.address);
  const balanceEth = Number(ethers.formatEther(balanceWei));

  console.log("Relayer:", wallet.address);
  console.log("RPC:", resolveRpcUrl());
  console.log("Balance ETH:", balanceEth);

  if (balanceEth <= 0.002) {
    console.log("WARNING: Relayer balance is critically low.");
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exitCode = 1;
});
