import { network } from "hardhat";

const DEFAULT_MOCK_USDT = "0x0E6De97eC3dD98D1e0605B527110c5C19d85d29e";
const MINT_UNITS = 10_000n * 10n ** 6n; // 10,000 USDT with 6 decimals

async function main() {
  const { ethers } = await network.connect();
  const [signer] = await ethers.getSigners();

  const recipientRaw = process.env.TO_ADDRESS?.trim();
  const recipient = recipientRaw
    ? ethers.getAddress(recipientRaw)
    : await signer.getAddress();
  const tokenAddress = ethers.getAddress(
    process.env.MOCK_USDT_ADDRESS?.trim() || DEFAULT_MOCK_USDT
  );

  const token = new ethers.Contract(
    tokenAddress,
    [
      "function mint(address to, uint256 amount) external",
      "function balanceOf(address account) view returns (uint256)",
      "function decimals() view returns (uint8)",
      "function symbol() view returns (string)",
    ],
    signer
  );

  const symbol = await token.symbol();
  const decimals = Number(await token.decimals());
  const before = await token.balanceOf(recipient);

  console.log("Network: sepolia");
  console.log("Signer:", await signer.getAddress());
  console.log("Token :", tokenAddress, `(${symbol}, ${decimals} decimals)`);
  console.log("To    :", recipient);
  console.log("Before:", ethers.formatUnits(before, decimals), symbol);

  const tx = await token.mint(recipient, MINT_UNITS);
  console.log("Mint tx submitted:", tx.hash);
  const receipt = await tx.wait();

  const after = await token.balanceOf(recipient);
  console.log("Mint confirmed in block:", receipt.blockNumber);
  console.log("After :", ethers.formatUnits(after, decimals), symbol);
  console.log("Delta :", ethers.formatUnits(after - before, decimals), symbol);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
