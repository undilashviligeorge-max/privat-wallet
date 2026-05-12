import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { defineConfig } from "hardhat/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(rootDir, ".env") });

function normalizePrivateKey(key) {
  const k = key.trim();
  if (!k) return null;
  return k.startsWith("0x") ? k : `0x${k}`;
}

const PUBLIC_SEPOLIA_RPC =
  process.env.SEPOLIA_RPC_URL?.trim() ||
  "https://ethereum-sepolia-rpc.publicnode.com";

/**
 * Sepolia: process.env.TATUM_RPC_URL and process.env.PRIVATE_KEY.
 * Bare Tatum testnet keys use the gateway for paid tiers; free tier often blocks eth_call — fall back to public RPC.
 */
function buildSepolia() {
  const rawUrlOrKey = process.env.TATUM_RPC_URL?.trim();
  const privateKey = normalizePrivateKey(process.env.PRIVATE_KEY ?? "");
  if (!privateKey) return null;

  const accounts = [privateKey];

  if (rawUrlOrKey?.startsWith("http://") || rawUrlOrKey?.startsWith("https://")) {
    return {
      type: "http",
      chainType: "l1",
      url: rawUrlOrKey,
      accounts,
    };
  }

  if (!rawUrlOrKey) {
    return {
      type: "http",
      chainType: "l1",
      url: PUBLIC_SEPOLIA_RPC,
      accounts,
    };
  }

  return {
    type: "http",
    chainType: "l1",
    url: PUBLIC_SEPOLIA_RPC,
    accounts,
  };
}

const sepolia = buildSepolia();

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin],
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  networks: sepolia ? { sepolia } : {},
});
