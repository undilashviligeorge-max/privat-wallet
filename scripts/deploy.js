import { network } from "hardhat";

/**
 * Sepolia: MockUSDT, Groth16 verifier + adapter, two MockIncrementalMerkleTree
 * instances (ETH + USDT), TelegramPrivacyPool (dual asset).
 */

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

async function main() {
  const { ethers } = await network.connect();
  const [deployer] = await ethers.getSigners();

  console.log("Deployer:", deployer.address);
  console.log(
    "Balance :",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "ETH"
  );

  const usdt = await ethers.deployContract("MockUSDT", [deployer.address]);
  await usdt.waitForDeployment();
  const usdtAddr = await usdt.getAddress();
  console.log("MockUSDT deployed to:                ", usdtAddr);

  const groth16 = await ethers.deployContract("Groth16Verifier");
  await groth16.waitForDeployment();
  const groth16Addr = await groth16.getAddress();
  console.log("Groth16Verifier deployed to:          ", groth16Addr);

  const verifierAdapter = await ethers.deployContract("Groth16VerifierAdapter", [
    groth16Addr,
  ]);
  await verifierAdapter.waitForDeployment();
  const verifierAddr = await verifierAdapter.getAddress();
  console.log("Groth16VerifierAdapter deployed to:   ", verifierAddr);

  const ethTree = await ethers.deployContract("MockIncrementalMerkleTree");
  await ethTree.waitForDeployment();
  const ethTreeAddr = await ethTree.getAddress();
  console.log("MockIncrementalMerkleTree (ETH):      ", ethTreeAddr);

  const usdtTree = await ethers.deployContract("MockIncrementalMerkleTree");
  await usdtTree.waitForDeployment();
  const usdtTreeAddr = await usdtTree.getAddress();
  console.log("MockIncrementalMerkleTree (USDT):     ", usdtTreeAddr);

  const pool = await ethers.deployContract("TelegramPrivacyPool", [
    verifierAddr,
    ethTreeAddr,
    usdtTreeAddr,
    usdtAddr,
    ZERO_ADDRESS,
    deployer.address,
  ]);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();

  console.log("TelegramPrivacyPool deployed to:      ", poolAddr);
  console.log("\nSummary:");
  console.log(
    JSON.stringify(
      {
        network: "sepolia",
        deployer: deployer.address,
        mockUSDT: usdtAddr,
        groth16Verifier: groth16Addr,
        groth16Adapter: verifierAddr,
        ethStateTree: ethTreeAddr,
        usdtStateTree: usdtTreeAddr,
        sanctionsOracle: ZERO_ADDRESS,
        pool: poolAddr,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
