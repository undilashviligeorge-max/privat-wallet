import { network } from "hardhat";

/**
 * Deploy a second TelegramPrivacyPool for the "large" anonymity set:
 *   1 ETH  +  1000 USDT  (dual-asset, separate Merkle trees)
 * Protocol fees (consistent ratios with standard pool):
 *   ETH:  0.1 ETH  (= 10% of 1 ETH note, same ratio as 0.01/0.1)
 *   USDT: 1 USDT   (= 0.1% of 1000 mock USDT)
 *
 * Prerequisites: MockUSDT already deployed. Set in env:
 *   MOCK_USDT_ADDRESS=0x...
 *
 * Reuses Groth16 verifier stack from env when set (saves gas / keeps one verifying key):
 *   GROTH16_VERIFIER=0x...        (optional)
 *   GROTH16_VERIFIER_ADAPTER=0x... (optional)
 * If unset, deploys new Groth16Verifier + Groth16VerifierAdapter like scripts/deploy.js.
 *
 * Run (when ready): npx hardhat run scripts/deploy-large-pools.js --network sepolia
 */

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

async function main() {
  const { ethers } = await network.connect();
  const [deployer] = await ethers.getSigners();
  const useMockVerifier = String(process.env.USE_MOCK_VERIFIER || "")
    .trim()
    .toLowerCase() === "1";

  const mockUsdtEnv = process.env.MOCK_USDT_ADDRESS?.trim();
  if (!mockUsdtEnv || !ethers.isAddress(mockUsdtEnv)) {
    throw new Error("Set MOCK_USDT_ADDRESS to the shared MockUSDT contract.");
  }
  const usdtAddr = ethers.getAddress(mockUsdtEnv);

  console.log("Deployer:", deployer.address);
  console.log("Reusing MockUSDT:", usdtAddr);

  let groth16Addr = null;
  let verifierAddr;

  const adapterEnv = process.env.GROTH16_VERIFIER_ADAPTER?.trim();
  const groth16Env = process.env.GROTH16_VERIFIER?.trim();

  if (adapterEnv && ethers.isAddress(adapterEnv)) {
    verifierAddr = ethers.getAddress(adapterEnv);
    console.log("Reusing Groth16VerifierAdapter:", verifierAddr);
  } else if (useMockVerifier) {
    const mockVerifier = await ethers.deployContract("MockVerifier");
    await mockVerifier.waitForDeployment();
    verifierAddr = await mockVerifier.getAddress();
    console.log("MockVerifier deployed to:             ", verifierAddr);
  } else if (groth16Env && ethers.isAddress(groth16Env)) {
    const g = groth16Env;
    const verifierAdapter = await ethers.deployContract("Groth16VerifierAdapter", [g]);
    await verifierAdapter.waitForDeployment();
    verifierAddr = await verifierAdapter.getAddress();
    console.log("Groth16Verifier (existing):          ", g);
    console.log("Groth16VerifierAdapter deployed to:   ", verifierAddr);
  } else {
    const groth16 = await ethers.deployContract("Groth16Verifier");
    await groth16.waitForDeployment();
    groth16Addr = await groth16.getAddress();
    console.log("Groth16Verifier deployed to:          ", groth16Addr);
    const verifierAdapter = await ethers.deployContract("Groth16VerifierAdapter", [
      groth16Addr,
    ]);
    await verifierAdapter.waitForDeployment();
    verifierAddr = await verifierAdapter.getAddress();
    console.log("Groth16VerifierAdapter deployed to:   ", verifierAddr);
  }

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
    ethers.parseEther("1"),
    ethers.parseEther("0.1"),
    1000n * 1_000_000n,
    1_000_000n,
  ]);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();
  console.log("TelegramPrivacyPool (LARGE) deployed:", poolAddr);

  const ASP_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ASP_ROLE"));
  await (await pool.grantRole(ASP_ROLE, deployer.address)).wait();
  const aspBootstrapRoot = ethers.keccak256(
    ethers.toUtf8Bytes("telegram-privacy-pool-asp-bootstrap-large-v1")
  );
  await (await pool.publishAspRoot(aspBootstrapRoot)).wait();
  console.log("ASP bootstrap root:", aspBootstrapRoot);

  console.log(
    "\nSummary:",
    JSON.stringify(
      {
        network: "sepolia",
        largePool: poolAddr,
        ethStateTree: ethTreeAddr,
        usdtStateTree: usdtTreeAddr,
        mockUSDT: usdtAddr,
        verifier: verifierAddr,
        denoms: {
          eth: "1",
          protocolEth: "0.1",
          usdt: "1000",
          protocolUsdtAtomic: "1000000",
        },
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
