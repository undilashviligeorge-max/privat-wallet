import { network } from "hardhat";

const DEFAULT_MOCK_USDT = "0xDe1090EbcDb237C5437b81BfCE6663959BED67c0";
/** Whole USDT units (6 decimals applied). Override: MINT_USDT=10000000 */
const MINT_USDT_WHOLE = (() => {
  const raw = process.env.MINT_USDT?.trim();
  if (raw) {
    try {
      return BigInt(raw);
    } catch {
      throw new Error(`Invalid MINT_USDT: ${raw}`);
    }
  }
  return 10_000n;
})();
const MINT_UNITS = MINT_USDT_WHOLE * 10n ** 6n;

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
