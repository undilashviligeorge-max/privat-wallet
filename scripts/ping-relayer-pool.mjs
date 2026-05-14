#!/usr/bin/env node
/**
 * Temporary: print pool + mock USDT the live relayer reports (Railway / local).
 * Usage: RELAY_URL=https://... node scripts/ping-relayer-pool.mjs
 */
const DEFAULT_RELAY =
  process.env.RELAY_URL?.trim() ||
  process.env.VITE_RELAY_URL?.trim() ||
  "https://privat-wallet-production.up.railway.app";

const base = String(DEFAULT_RELAY).replace(/\/+$/, "");

async function main() {
  const url = `${base}/relay`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "ngrok-skip-browser-warning": "true",
    },
    body: JSON.stringify({}),
  });
  const text = await res.text();
  let j = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  console.log("RELAY_URL:", base);
  console.log("HTTP:", res.status, res.ok);
  if (j && typeof j === "object") {
    console.log("poolAddresses:", j.poolAddresses ?? "(missing)");
    console.log("feesByDenom keys:", j.feesByDenom ? Object.keys(j.feesByDenom) : "(missing)");
    console.log("MOCK_USDT_ADDRESS:", j.mockUsdt ?? "(missing)");
  } else {
    console.log("Body:", text?.slice(0, 500));
  }
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exitCode = 1;
});
