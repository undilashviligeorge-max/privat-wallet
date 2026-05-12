/**
 * One-time Sepolia bootstrap: grant ASP_ROLE to the deployer (pool admin) if needed,
 * then publish a non-zero ASP Merkle root so `withdraw` can pass `isKnownAspRoot`.
 *
 * Requires `TelegramMixer/.env`: PRIVATE_KEY (pool admin / DEFAULT_ADMIN_ROLE).
 * RPC: use a full HTTPS Sepolia URL if your Tatum key blocks `eth_call` on the gateway, e.g.
 *   TATUM_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com npx hardhat run scripts/bootstrap-asp-root.js --network sepolia
 *
 *   npm run bootstrap:asp
 *
 * Optional: POOL_ADDRESS=0x... in env to target a non-default pool.
 */
import { network } from "hardhat";

const DEFAULT_POOL =
  process.env.POOL_ADDRESS?.trim() ||
  "0xA53f26482dD78Baac3d1eC84E9a643B89e750145";

const BOOTSTRAP_LABEL = "telegram-privacy-pool-asp-bootstrap-v1";

async function main() {
  const { ethers } = await network.connect();
  const [signer] = await ethers.getSigners();
  const poolAddr = DEFAULT_POOL;

  const pool = new ethers.Contract(
    poolAddr,
    [
      "function ASP_ROLE() view returns (bytes32)",
      "function grantRole(bytes32 role, address account) external",
      "function hasRole(bytes32 role, address account) view returns (bool)",
      "function publishAspRoot(bytes32 newRoot) external",
      "function isKnownAspRoot(bytes32 root) view returns (bool)",
    ],
    signer
  );

  const me = await signer.getAddress();
  console.log("Signer:", me);
  console.log("Pool:  ", poolAddr);

  const ASP_ROLE = await pool.ASP_ROLE();
  let hasAsp;
  try {
    hasAsp = await pool.hasRole(ASP_ROLE, me);
  } catch (e) {
    console.warn("hasRole eth_call failed (RPC may block reads); attempting grantRole anyway.", e?.message || e);
    hasAsp = false;
  }
  if (!hasAsp) {
    console.log("Granting ASP_ROLE to signer…");
    const tx = await pool.grantRole(ASP_ROLE, me);
    await tx.wait();
    console.log("ASP_ROLE granted");
  } else {
    console.log("Signer already has ASP_ROLE");
  }

  const newRoot = ethers.keccak256(ethers.toUtf8Bytes(BOOTSTRAP_LABEL));
  try {
    if (await pool.isKnownAspRoot(newRoot)) {
      console.log("ASP root already known on-chain:", newRoot);
      return;
    }
  } catch {
    /* RPC may block reads; publishAspRoot will no-op if duplicate */
  }

  console.log("Publishing ASP root…", newRoot);
  const tx2 = await pool.publishAspRoot(newRoot);
  const receipt = await tx2.wait();
  console.log("publishAspRoot confirmed in block", receipt.blockNumber);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
