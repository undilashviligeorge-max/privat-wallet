import React, {
  useCallback,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  AbiCoder,
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  formatEther,
  formatUnits,
  getAddress,
  MaxUint256,
  keccak256,
  randomBytes,
  ZeroHash,
} from "ethers";
import { w3mProvider } from "@web3modal/ethereum";
import { WalletConnectConnector } from "@wagmi/core/connectors/walletConnect";
import { InjectedConnector } from "@wagmi/core/connectors/injected";
import {
  configureChains,
  connect,
  createConfig,
  disconnect,
  getAccount,
  getWalletClient,
  switchNetwork,
  watchAccount,
} from "@wagmi/core";
import { sepolia } from "@wagmi/core/chains";

/** CORS-stable Sepolia JSON-RPC for browser reads + wagmi `publicClient` (WalletConnect fallback path). */
const SEPOLIA_READ_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

/**
 * Groth16 artifacts served from `frontend/public/` as root-relative URLs (`/file.ext`).
 * Must match real files on disk after `vite build` / Vercel static deploy.
 */
const CIRCUIT_WASM_URL = "/circuit.wasm";
const CIRCUIT_ZKEY_URL = "/circuit_final.zkey";

/** How long to wait for the wallet to return a signer (Telegram / WalletConnect can stall). */
const SIGNER_TIMEOUT_MS = 180_000;

function circuitArtifactAbsoluteUrls() {
  if (typeof window === "undefined") {
    return { wasmUrl: CIRCUIT_WASM_URL, zkeyUrl: CIRCUIT_ZKEY_URL };
  }
  const base = window.location.origin.replace(/\/$/, "");
  return {
    wasmUrl: `${base}${CIRCUIT_WASM_URL}`,
    zkeyUrl: `${base}${CIRCUIT_ZKEY_URL}`,
  };
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => {
      reject(
        new Error(
          `${label} — no response after ${Math.round(ms / 1000)}s. ` +
            "If you use WalletConnect or a Telegram in-app browser, approve the connection or open in an external browser."
        )
      );
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/**
 * Fetch wasm/zkey and load snarkjs (shared by deposit sanity check + withdraw proving).
 * @param {string} logTag e.g. "[deposit][snark]" or "[withdraw][zk]"
 */
/** Dev: avoid stale wasm during iteration; prod: HTTP cache for faster repeat proves. */
const ARTIFACT_FETCH_INIT = {
  cache: import.meta.env.DEV ? "no-store" : "default",
};

/** One-time warm cache: artifact bytes + snarkjs module (withdraw + deposit share). */
let groth16ArtifactCachePromise = null;

function getGroth16ArtifactsCached(logTag) {
  if (!groth16ArtifactCachePromise) {
    groth16ArtifactCachePromise = loadGroth16Artifacts(logTag);
  }
  return groth16ArtifactCachePromise;
}

async function loadGroth16Artifacts(logTag) {
  const { wasmUrl, zkeyUrl } = circuitArtifactAbsoluteUrls();

  console.log(`${logTag} Step 1/4: absolute URLs`, {
    wasmUrl,
    zkeyUrl,
    pathWasm: CIRCUIT_WASM_URL,
    pathZkey: CIRCUIT_ZKEY_URL,
  });

  let wasmRes;
  try {
    console.log(`${logTag} Step 2/4: fetching wasm…`);
    wasmRes = await fetch(wasmUrl, {
      method: "GET",
      ...ARTIFACT_FETCH_INIT,
      headers: { Accept: "application/wasm, application/octet-stream, */*" },
    });
  } catch (e) {
    console.error(`${logTag} WASM fetch network error:`, e);
    throw new Error(
      `[SNARK WASM FETCH FAILED — network/CORS]\nURL: ${wasmUrl}\n` +
        `${e?.message || e}\n\nCheck DevTools → Network for blocked requests.`
    );
  }

  if (!wasmRes.ok) {
    const bodyPreview = (await wasmRes.text().catch(() => "")).slice(0, 500);
    console.error(`${logTag} WASM HTTP error`, wasmRes.status, bodyPreview);
    throw new Error(
      `[SNARK WASM HTTP ${wasmRes.status}]\nURL: ${wasmUrl}\n` +
        `Body preview:\n${bodyPreview || "(empty)"}\n\nFile must exist under frontend/public/ and deploy with the app.`
    );
  }

  const wasmCt = wasmRes.headers.get("content-type") || "";
  console.log(`${logTag} Step 2/4 OK: wasm response`, {
    status: wasmRes.status,
    contentType: wasmCt,
  });

  let wasmBuffer;
  try {
    wasmBuffer = await wasmRes.arrayBuffer();
  } catch (e) {
    console.error(`${logTag} WASM arrayBuffer failed:`, e);
    throw new Error(
      `[SNARK WASM READ FAILED]\n${e?.message || e}\nURL was: ${wasmUrl}`
    );
  }

  const wasmBytes = new Uint8Array(wasmBuffer);
  console.log(`${logTag} wasm byte length =`, wasmBytes.byteLength);

  let zkeyRes;
  try {
    console.log(`${logTag} Step 3/4: fetching zkey…`);
    zkeyRes = await fetch(zkeyUrl, {
      method: "GET",
      ...ARTIFACT_FETCH_INIT,
      headers: { Accept: "application/octet-stream, */*" },
    });
  } catch (e) {
    console.error(`${logTag} ZKEY fetch network error:`, e);
    throw new Error(
      `[SNARK ZKEY FETCH FAILED — network/CORS]\nURL: ${zkeyUrl}\n${e?.message || e}`
    );
  }

  if (!zkeyRes.ok) {
    const preview = (await zkeyRes.text().catch(() => "")).slice(0, 500);
    console.error(`${logTag} ZKEY HTTP error`, zkeyRes.status, preview);
    throw new Error(
      `[SNARK ZKEY HTTP ${zkeyRes.status}]\nURL: ${zkeyUrl}\n` +
        `Body preview:\n${preview || "(empty)"}`
    );
  }

  const zkeyCt = zkeyRes.headers.get("content-type") || "";
  console.log(`${logTag} Step 3/4 OK: zkey response`, {
    status: zkeyRes.status,
    contentType: zkeyCt,
  });

  let zkeyBuffer;
  try {
    zkeyBuffer = await zkeyRes.arrayBuffer();
  } catch (e) {
    console.error(`${logTag} ZKEY arrayBuffer failed:`, e);
    throw new Error(`[SNARK ZKEY READ FAILED]\n${e?.message || e}`);
  }

  const zkeyBytes = new Uint8Array(zkeyBuffer);
  console.log(`${logTag} zkey byte length =`, zkeyBytes.byteLength);

  let snarkjs;
  try {
    console.log(`${logTag} Step 4/4: dynamic import('snarkjs')…`);
    snarkjs = await import("snarkjs");
    console.log(`${logTag} Step 4/4 OK: snarkjs loaded`);
  } catch (e) {
    console.error(`${logTag} snarkjs import failed:`, e);
    throw new Error(
      `[SNARKJS MODULE FAILED TO LOAD]\n${e?.message || e}\n${e?.stack || ""}`
    );
  }

  if (typeof snarkjs.groth16?.fullProve !== "function") {
    throw new Error(
      "[SNARKJS] groth16.fullProve is not a function — broken or incompatible snarkjs build."
    );
  }

  return { wasmBytes, zkeyBytes, snarkjs };
}

/**
 * Fetches proving artifacts and loads snarkjs so CORS/404/MIME issues surface as loud errors.
 * Deposit also runs a null-input groth16 sanity throw (expected).
 */
async function verifySnarkArtifactsStepByStep() {
  const { wasmBytes, zkeyBytes, snarkjs } = await getGroth16ArtifactsCached(
    "[deposit][snark]"
  );

  console.log(
    "[deposit][snark] Step 5/5: groth16.fullProve(null) sanity check (deposit does not use a witness)."
  );
  try {
    await withTimeout(
      snarkjs.groth16.fullProve(null, wasmBytes, zkeyBytes),
      15_000,
      "groth16.fullProve(null, …) sanity check"
    );
    console.warn(
      "[deposit][snark] fullProve resolved without error — unexpected for null inputs."
    );
  } catch (proveErr) {
    console.log(
      "[deposit][snark] fullProve caught (expected):",
      proveErr?.message || proveErr
    );
  }

  console.log(
    "[deposit][snark] Artifacts + snarkjs OK. If deposit still hangs after this log, the blocker is wallet/RPC — not wasm/zkey fetch."
  );

  return { wasmBytes, zkeyBytes, snarkjs };
}

/**
 * `PoolPublicBind.circom` witness: decimal strings for field elements, aligned with
 * `TelegramPrivacyPool.withdraw` publicInputs (roots/recipient/relayer/fee).
 */
function buildPoolPublicBindWitness({
  stateRootHex,
  aspRootHex,
  nullifierHashHex,
  recipientAddr,
  relayerAddr,
  feeStr,
}) {
  return {
    stateRoot: BigInt(stateRootHex).toString(),
    aspRoot: BigInt(aspRootHex).toString(),
    nullifierHash: BigInt(nullifierHashHex).toString(),
    recipient: BigInt(getAddress(recipientAddr)).toString(),
    relayer: BigInt(getAddress(relayerAddr)).toString(),
    fee: feeStr,
  };
}

function proofToJsonSafe(proof) {
  return JSON.parse(
    JSON.stringify(proof, (_, v) => (typeof v === "bigint" ? v.toString() : v))
  );
}

/**
 * `Groth16VerifierAdapter` expects `abi.encode(uint256[2] a, uint256[2][2] b, uint256[2] c)` — not
 * `groth16.exportSolidityCallData` text (that mixes in public inputs for a different Solidity API).
 * Coordinate swap on `pi_b` matches snarkjs `exportSolidityCallData` / generated verifier layout.
 */
function encodeGroth16ProofBytes(proof) {
  const pi_a = proof.pi_a ?? proof.piA;
  const pi_b = proof.pi_b ?? proof.piB;
  const pi_c = proof.pi_c ?? proof.piC;
  if (!pi_a || !pi_b || !pi_c) {
    throw new Error("Groth16 proof missing pi_a / pi_b / pi_c");
  }
  const a = [BigInt(pi_a[0]), BigInt(pi_a[1])];
  const b = [
    [BigInt(pi_b[0][1]), BigInt(pi_b[0][0])],
    [BigInt(pi_b[1][1]), BigInt(pi_b[1][0])],
  ];
  const c = [BigInt(pi_c[0]), BigInt(pi_c[1])];
  return AbiCoder.defaultAbiCoder().encode(
    ["uint256[2]", "uint256[2][2]", "uint256[2]"],
    [a, b, c]
  );
}

/**
 * Run Groth16 proving off the UI thread when possible (Telegram / mobile webviews often
 * throttle a long main-thread WASM task so it looks “stuck”).
 */
async function groth16FullProveWorkerOrMain(witness, wasmBytes, zkeyBytes, timeoutMs) {
  const labelWorker = "[withdraw][zk] groth16.fullProve (worker)";
  const labelMain = "[withdraw][zk] groth16.fullProve (main thread)";

  if (typeof Worker !== "undefined") {
    try {
      const { default: Groth16Worker } = await import(
        "./groth16Prover.worker.js?worker"
      );
      const wasmCopy = wasmBytes.slice();
      const zkeyCopy = zkeyBytes.slice();
      let wRef;
      const workerProve = new Promise((resolve, reject) => {
        const w = new Groth16Worker();
        wRef = w;
        w.onmessage = (e) => {
          try {
            w.terminate();
          } catch {
            /* ignore */
          }
          wRef = undefined;
          const { ok, proof, publicSignals, error } = e.data || {};
          if (ok) resolve({ proof, publicSignals });
          else reject(new Error(error || "Groth16 worker failed"));
        };
        w.onerror = (err) => {
          try {
            w.terminate();
          } catch {
            /* ignore */
          }
          wRef = undefined;
          reject(err?.error || err);
        };
        w.postMessage(
          {
            witness,
            wasmBuffer: wasmCopy.buffer,
            zkeyBuffer: zkeyCopy.buffer,
          },
          [wasmCopy.buffer, zkeyCopy.buffer]
        );
      });
      try {
        return await withTimeout(workerProve, timeoutMs, labelWorker);
      } catch (e) {
        try {
          wRef?.terminate();
        } catch {
          /* ignore */
        }
        throw e;
      }
    } catch (e) {
      console.warn(
        "[withdraw][zk] Worker proving unavailable, using main thread:",
        e?.message || e
      );
    }
  }

  const snarkjs = await import("snarkjs");
  return await withTimeout(
    snarkjs.groth16.fullProve(witness, wasmBytes, zkeyBytes),
    timeoutMs,
    labelMain
  );
}

async function generateWithdrawBindingProof(wasmBytes, zkeyBytes, witness) {
  console.log(
    "[withdraw][zk] groth16.fullProve starting (PoolPublicBind witness keys:",
    Object.keys(witness),
    ")"
  );
  const { proof, publicSignals } = await groth16FullProveWorkerOrMain(
    witness,
    wasmBytes,
    zkeyBytes,
    300_000
  );
  console.log(
    "[withdraw][zk] groth16.fullProve done; publicSignals count:",
    publicSignals?.length
  );
  const proofHex = encodeGroth16ProofBytes(proof);
  return {
    proofJson: proofToJsonSafe(proof),
    publicSignals,
    solidityCalldata: null,
    proofHex,
  };
}

function formatDepositFailure(step, e) {
  const short =
    e?.shortMessage || e?.reason || e?.message || String(e);
  const stack = e?.stack ? `\n\nStack:\n${e.stack}` : "";
  console.error(`[deposit] FAILED at step: ${step}`, e);
  return `Deposit failed — ${step}\n${short}${stack}`;
}

const sepoliaForApp = {
  ...sepolia,
  rpcUrls: {
    default: { http: [SEPOLIA_READ_RPC] },
    public: { http: [SEPOLIA_READ_RPC] },
  },
};

/* ------------------------------------------------------------------ *
 * Shield — runs as soon as this module executes (after its imports). *
 * ------------------------------------------------------------------ */
let hadRealEthereumBeforeShield = false;

if (typeof window !== "undefined") {
  window.global = window;
  hadRealEthereumBeforeShield = Boolean(window.ethereum);
  if (!window.ethereum) {
    window.ethereum = {
      isMetaMask: false,
      request: async () => ({}),
      __PRIVACY_POOL_ETH_STUB__: true,
    };
  } else {
    try {
      const eth = window.ethereum;
      if (
        eth.__PRIVACY_POOL_ETH_STUB__ !== true &&
        !Array.isArray(eth.providers)
      ) {
        const list = eth.providers == null ? [eth] : [eth];
        Object.defineProperty(eth, "providers", {
          value: list,
          configurable: true,
          enumerable: false,
          writable: true,
        });
      }
    } catch {
      /* ignore */
    }
  }
}

/** True only if a real `window.ethereum` existed before the shield stub (not the placeholder). */
const isMetaMaskInstalled = hadRealEthereumBeforeShield;

const POOL_ADDRESS = "0xdF91714EAC240b6c5AA652669f11Ef1776BbB2a9";

/** Sepolia MockUSDT (6 decimals); deployer receives initial supply. */
const MOCK_USDT_ADDRESS = "0xDe1090EbcDb237C5437b81BfCE6663959BED67c0";

/** Must stay in sync with `STATIC_COMPLIANCE_BLOCKLIST` / relayer blocklist. */
const COMPLIANCE_BLOCKED_ADDRESSES = new Set([
  getAddress("0x000000000000000000000000000000000000dEaD").toLowerCase(),
]);

const COMPLIANCE_BLOCKED_MESSAGE =
  "Address is blocked due to compliance policies.";

function isComplianceBlockedAddress(addr) {
  if (!addr) return false;
  try {
    return COMPLIANCE_BLOCKED_ADDRESSES.has(
      getAddress(String(addr)).toLowerCase()
    );
  } catch {
    return false;
  }
}

/** Production relayer on Railway (HTTPS). Never use ngrok here — override only with `VITE_RELAY_URL`. */
const DEFAULT_RELAYER_URL = "https://privat-wallet-production.up.railway.app";

/** Public HTTPS base URL for the relayer. No trailing slash. */
const RELAY_URL = String(
  (typeof import.meta !== "undefined" &&
    import.meta.env &&
    import.meta.env.VITE_RELAY_URL) ||
    DEFAULT_RELAYER_URL
)
  .trim()
  .replace(/\/+$/, "");

function buildRelayUrl(path) {
  const base = RELAY_URL.replace(/\/+$/, "");
  const cleanPath = String(path || "").replace(/^\/+/, "");
  return `${base}/${cleanPath}`;
}

/**
 * All browser → relayer traffic goes through here: consistent cache bust + actionable errors if TLS/DNS/CORS fails.
 */
async function relayFetch(path, init = {}) {
  const url = buildRelayUrl(path);
  const baseHeaders = {
    Accept: "application/json",
    "ngrok-skip-browser-warning": "true",
  };
  const merged = {
    cache: "no-store",
    ...init,
    headers: { ...baseHeaders, ...(init.headers || {}) },
  };
  try {
    return await fetch(url, merged);
  } catch (e) {
    const name = e?.name || "";
    const msg = e?.message || String(e);
    const net =
      name === "TypeError" ||
      /Failed to fetch|NetworkError|Load failed|ECONNREFUSED/i.test(msg);
    throw new Error(
      net
        ? `Cannot reach relayer at ${RELAY_URL} (${msg}). Set VITE_RELAY_URL in Vercel to your Railway service HTTPS URL.`
        : `Relayer fetch failed (${path}): ${msg}`
    );
  }
}

/** WalletConnect Cloud project id (required non-empty string for WalletConnect v2). */
const WC_PROJECT_ID = (() => {
  const id = String(
    (typeof import.meta !== "undefined" &&
      import.meta.env &&
      import.meta.env.VITE_WC_PROJECT_ID) ||
      "21fef48091f12692cad574a6f7753643"
  ).trim();
  if (!id) {
    throw new Error(
      "WalletConnect projectId is required (set VITE_WC_PROJECT_ID)"
    );
  }
  return id;
})();

const SEPOLIA_CHAIN_ID = 11155111;

function isInjectedEthereumStub() {
  return (
    typeof window !== "undefined" &&
    window.ethereum &&
    window.ethereum.__PRIVACY_POOL_ETH_STUB__ === true
  );
}

/** Minimal ABI for the slice of TelegramPrivacyPool the UI talks to. */
const POOL_ABI = [
  "function ETH_DENOMINATION() view returns (uint256)",
  "function PROTOCOL_WITHDRAW_FEE_ETH() view returns (uint256)",
  "function USDT_DENOMINATION() view returns (uint256)",
  "function PROTOCOL_WITHDRAW_FEE_USDT() view returns (uint256)",
  "function depositAmountRequired() view returns (uint256)",
  "function usdtDepositAmountRequired() view returns (uint256)",
  "function deposit(bytes32 commitment) payable",
  "function depositUsdt(bytes32 commitment)",
  "function usdt() view returns (address)",
  "function commitments(bytes32) view returns (bool)",
  "function ethStateTree() view returns (address)",
  "function usdtStateTree() view returns (address)",
  "function aspRootIndex() view returns (uint32)",
  "function aspRoots(uint256) view returns (bytes32)",
  "function isKnownAspRoot(bytes32 root) view returns (bool)",
  "event AspRootUpdated(bytes32 indexed root, uint32 index, address indexed asp)",
];

const MERKLE_TREE_ABI = [
  "function currentRoot() view returns (bytes32)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
];

/**
 * ZK public inputs must match relayer fee + fee wallet from the server (`FEE_PERCENTAGE`, `FEE_WALLET_ADDRESS`).
 */
async function fetchFeeConfig() {
  const jsonHeaders = { "Content-Type": "application/json" };

  let tryFee = await relayFetch("/fee-config", {
    method: "GET",
    headers: jsonHeaders,
  });
  if (tryFee.ok) {
    const d = await tryFee.json();
    if (
      d?.success &&
      typeof d.feeWallet === "string" &&
      typeof d.relayerFeeEth === "string" &&
      typeof d.relayerFeeUsdt === "string"
    ) {
      return d;
    }
  }

  let tryRelayer = await relayFetch("/relayer-address", {
    method: "GET",
    headers: jsonHeaders,
  });
  if (tryRelayer.ok) {
    const d = await tryRelayer.json();
    if (
      d?.success &&
      typeof d.feeWallet === "string" &&
      typeof d.relayerFeeEth === "string" &&
      typeof d.relayerFeeUsdt === "string"
    ) {
      return d;
    }
  }

  const ping = await relayFetch("/relay", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ action: "ping" }),
  });
  if (ping.ok) {
    const d = await ping.json();
    if (
      typeof d.feeWallet === "string" &&
      typeof d.relayerFeeEth === "string" &&
      typeof d.relayerFeeUsdt === "string"
    ) {
      return { success: true, ...d };
    }
  }

  throw new Error(
    "Relayer missing fee config (GET /fee-config, /relayer-address, or POST /relay with fee fields). Redeploy backend/relayer.js."
  );
}

/**
 * Canonical decimal string for Circom uint256 fee + POST body (exact integer, no scientific notation).
 */
function normalizeRelayerFeeAtomic(raw) {
  const s = String(raw ?? "").trim();
  if (!s) throw new Error("Relayer returned an empty fee");
  try {
    const n = BigInt(/^0x/i.test(s) ? s : s);
    if (n < 0n) throw new Error("negative fee");
    return n.toString(10);
  } catch {
    throw new Error(`Relayer fee is not a valid integer: ${JSON.stringify(raw)}`);
  }
}

/** Always call immediately before building the witness so the proof binds to the latest server fee. */
async function fetchWithdrawFeeSnapshot(assetToken) {
  const cfg = await fetchFeeConfig();
  const feeWallet = getAddress(cfg.feeWallet);
  const tok = String(assetToken || "ETH").toUpperCase() === "USDT" ? "USDT" : "ETH";
  const raw = tok === "USDT" ? cfg.relayerFeeUsdt : cfg.relayerFeeEth;
  const feeAtomicStr = normalizeRelayerFeeAtomic(raw);
  return { feeWallet, feeAtomicStr, cfg, token: tok };
}

/**
 * Latest ASP root that is still marked known on-chain (prefer `AspRootUpdated` logs;
 * ring-buffer slot alone can be zero even after publishes in edge cases).
 */
async function fetchLatestKnownAspRoot(pool) {
  try {
    const filter = pool.filters.AspRootUpdated();
    const logs = await pool.queryFilter(filter);
    for (let i = logs.length - 1; i >= 0; i--) {
      const root = logs[i].args?.root;
      if (!root || root === ZeroHash) continue;
      if (await pool.isKnownAspRoot(root)) return root;
    }
  } catch (e) {
    console.warn("[withdraw][roots] AspRootUpdated query failed:", e?.message || e);
  }
  const idx = Number(await pool.aspRootIndex());
  const slotRoot = await pool.aspRoots(idx);
  if (slotRoot && slotRoot !== ZeroHash && (await pool.isKnownAspRoot(slotRoot))) {
    return slotRoot;
  }
  return ZeroHash;
}

/** Current Merkle root + a known ASP root (required for `withdraw`). */
async function fetchWithdrawRoots(assetToken) {
  const provider = new JsonRpcProvider(SEPOLIA_READ_RPC);
  const pool = new Contract(POOL_ADDRESS, POOL_ABI, provider);
  const treeAddr =
    assetToken === "ETH"
      ? await pool.ethStateTree()
      : await pool.usdtStateTree();
  const tree = new Contract(treeAddr, MERKLE_TREE_ABI, provider);
  const stateRoot = await tree.currentRoot();
  const aspRoot = await fetchLatestKnownAspRoot(pool);
  return { stateRoot, aspRoot };
}

/* ---------------------- wagmi (no @web3modal/react UI) ----------------------
 * We use WalletConnectConnector + optional InjectedConnector only.
 * @web3modal/ui was crashing Telegram webviews (`null.some`). Connection
 * UI is our lightweight WalletConnect URI overlay instead.
 */

let wagmiConfig = null;
/** @type {InstanceType<typeof WalletConnectConnector> | null} */
let walletConnectConnectorRef = null;
let web3InitError = null;
let web3Initialized = false;

function buildExplicitConnectors(chains) {
  walletConnectConnectorRef = new WalletConnectConnector({
    chains,
    options: {
      projectId: WC_PROJECT_ID,
      showQrModal: false,
    },
  });
  if (!isMetaMaskInstalled) {
    return [walletConnectConnectorRef];
  }
  return [
    walletConnectConnectorRef,
    new InjectedConnector({
      chains,
      options: { shimDisconnect: true },
    }),
  ];
}

function initWeb3Once() {
  if (web3Initialized) return;
  web3Initialized = true;
  try {
    const { chains, publicClient } = configureChains(
      [sepoliaForApp],
      [w3mProvider({ projectId: WC_PROJECT_ID })]
    );

    wagmiConfig = createConfig({
      autoConnect: isMetaMaskInstalled,
      connectors: buildExplicitConnectors(chains),
      publicClient,
    });
  } catch (e) {
    web3InitError = (e && (e.message || String(e))) || "Wallet init failed";
    // eslint-disable-next-line no-console
    console.error("[wagmi init]", e);
  }
}
initWeb3Once();

const ConnectFlowContext = createContext({
  runConnect: async () => {},
  connectBusy: false,
});

/**
 * @param {(updater: { open: boolean; uri: string } | ((prev: { open: boolean; uri: string }) => { open: boolean; uri: string })) => void} setWcOverlay
 */
async function runWalletConnectWithOverlay(setWcOverlay) {
  const wc = walletConnectConnectorRef;
  if (!wc || !wagmiConfig) throw new Error("WalletConnect is not ready");

  setWcOverlay({ open: true, uri: "" });
  const handler = (msg) => {
    if (msg?.type === "display_uri") {
      setWcOverlay({ open: true, uri: String(msg.data || "") });
    }
  };
  wc.on("message", handler);
  try {
    await connect({ connector: wc });
  } finally {
    wc.off?.("message", handler);
    setWcOverlay({ open: false, uri: "" });
  }
}

async function openConnectFlow(setWcOverlay) {
  if (!wagmiConfig) return;
  const injected = wagmiConfig.connectors.find((c) => c.id === "injected");
  if (injected) {
    try {
      await connect({ connector: injected });
      return;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[connect injected]", e);
    }
  }
  await runWalletConnectWithOverlay(setWcOverlay);
}

/* ---------------------- Stable account store ------------------------
 * useSyncExternalStore must receive a stable `subscribe` function and
 * a snapshot getter that returns the SAME object reference until the
 * underlying state actually changes. `wagmi/core`'s `getAccount()`
 * returns a fresh object on every call, which would loop React forever
 * (Error #185 "Maximum update depth exceeded").
 */

const DISCONNECTED_SNAPSHOT = Object.freeze({
  address: undefined,
  isConnected: false,
});

let accountSnapshot = DISCONNECTED_SNAPSHOT;
const accountListeners = new Set();
let accountWatchStarted = false;

function refreshAccountSnapshot() {
  let next;
  try {
    const a = getAccount();
    next = {
      address: a?.address,
      isConnected: Boolean(a?.isConnected),
    };
  } catch {
    next = DISCONNECTED_SNAPSHOT;
  }
  // Only swap the reference if something the UI cares about changed.
  if (
    next.address !== accountSnapshot.address ||
    next.isConnected !== accountSnapshot.isConnected
  ) {
    accountSnapshot = next;
    accountListeners.forEach((cb) => {
      try {
        cb();
      } catch {
        /* listener errors must not crash the watcher */
      }
    });
  }
}

function ensureAccountWatcher() {
  if (accountWatchStarted) return;
  accountWatchStarted = true;
  try {
    watchAccount(() => refreshAccountSnapshot());
    refreshAccountSnapshot();
  } catch {
    /* wagmi init failed — leave the disconnected snapshot in place */
  }
}

function subscribeAccount(cb) {
  ensureAccountWatcher();
  accountListeners.add(cb);
  return () => accountListeners.delete(cb);
}

function getAccountSnapshot() {
  return accountSnapshot;
}

/* ----------------------------- Helpers ------------------------------ */

const relayHeaders = {
  "Content-Type": "application/json",
  "ngrok-skip-browser-warning": "true",
};

function hintRelayerRpcPaymentError(msg) {
  const s = typeof msg === "string" ? msg : String(msg || "");
  if (/InvalidProof\(\)/i.test(s) || /\bInvalidProof\b/i.test(s)) {
    return (
      `${s} The relayer and RPC are healthy, but the generated zk proof does not match the deployed verifier. ` +
      `This staging build uses a placeholder circuit; on-chain withdraw requires a proof generated from the exact circuit/verifier pair deployed in the pool.`
    );
  }
  if (!/402|Payment Required/i.test(s)) return s;
  return (
    `${s} If this came from the relayer, its Ethereum RPC rejected the request (common: Tatum free tier). ` +
    `Set SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com in the relayer .env and restart, or use a paid RPC.`
  );
}

async function postRelay(body = {}) {
  const res = await relayFetch("/relay", {
    method: "POST",
    headers: relayHeaders,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const hint =
      res.status === 402
        ? " (ngrok or relay returned 402 — check tunnel billing or relayer RPC / Tatum plan.)"
        : "";
    throw new Error(`Relay HTTP ${res.status}${hint}`);
  }
  return res.json();
}

/** 32 random bytes as a 0x-prefixed hex string. */
function randomCommitment() {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return (
    "0x" +
    Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")
  );
}

function shortAddr(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

async function copyToClipboard(text) {
  const s = String(text ?? "");
  if (!s) return;
  try {
    await navigator.clipboard.writeText(s);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = s;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand("copy");
    } finally {
      document.body.removeChild(ta);
    }
  }
}

/** EIP-1193 (injected or WalletConnect) for `wallet_watchAsset`. */
async function getWalletEip1193Provider() {
  if (
    typeof window !== "undefined" &&
    window.ethereum &&
    !isInjectedEthereumStub()
  ) {
    return window.ethereum;
  }
  const connector = getAccount()?.connector;
  if (connector?.getProvider) {
    try {
      const raw = await connector.getProvider();
      if (raw?.request) return raw;
    } catch {
      /* ignore */
    }
  }
  if (
    typeof window !== "undefined" &&
    window.ethereum &&
    !isInjectedEthereumStub()
  ) {
    return window.ethereum;
  }
  return null;
}

/** EIP-747 — add ERC-20 to wallet token list (MetaMask, etc.). */
async function watchAssetErc20(eip1193, tokenAddress, symbol, decimals) {
  const checksum = getAddress(tokenAddress);
  const payload = {
    type: "ERC20",
    options: {
      address: checksum,
      symbol,
      decimals,
    },
  };
  try {
    await eip1193.request({
      method: "wallet_watchAsset",
      params: payload,
    });
  } catch {
    await eip1193.request({
      method: "wallet_watchAsset",
      params: [payload],
    });
  }
}

/* ------------------------------ Theme ------------------------------- */

const theme = {
  bg: "#0b0d12",
  panel: "#11141b",
  border: "#1f2430",
  text: "#e8ecf3",
  subtle: "#9aa3b2",
  accent: "#6b8afd",
  accentHover: "#7d99ff",
  danger: "#ff6b6b",
  success: "#2dd4bf",
};

const styles = {
  page: {
    minHeight: "100vh",
    background:
      `radial-gradient(1200px 600px at 20% -10%, rgba(107,138,253,0.18), transparent 60%),` +
      `radial-gradient(900px 500px at 110% 10%, rgba(45,212,191,0.10), transparent 60%),` +
      theme.bg,
    color: theme.text,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif',
    padding: "20px 16px 40px",
    boxSizing: "border-box",
  },
  topBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    maxWidth: 460,
    margin: "0 auto 16px",
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    fontSize: 14,
    color: theme.subtle,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    background: theme.success,
    boxShadow: "0 0 12px rgba(45,212,191,0.6)",
  },
  card: {
    maxWidth: 460,
    margin: "0 auto",
    background: theme.panel,
    border: `1px solid ${theme.border}`,
    borderRadius: 18,
    padding: 22,
    boxShadow:
      "0 8px 30px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.03)",
  },
  title: {
    fontSize: 22,
    fontWeight: 600,
    margin: "0 0 4px",
    letterSpacing: 0.2,
  },
  subtitle: {
    margin: "0 0 18px",
    fontSize: 13,
    color: theme.subtle,
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: 12,
    color: theme.subtle,
    padding: "8px 0",
    borderBottom: `1px dashed ${theme.border}`,
  },
  rowValue: { color: theme.text, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
  buttonRow: { display: "flex", gap: 10, marginTop: 18 },
  primary: {
    flex: 1,
    appearance: "none",
    border: "none",
    borderRadius: 12,
    padding: "12px 14px",
    fontSize: 14,
    fontWeight: 600,
    color: "#0b0d12",
    background: theme.accent,
    cursor: "pointer",
    transition: "transform 80ms ease, background 120ms ease",
  },
  secondary: {
    flex: 1,
    appearance: "none",
    border: `1px solid ${theme.border}`,
    background: "transparent",
    color: theme.text,
    borderRadius: 12,
    padding: "12px 14px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  connect: {
    appearance: "none",
    border: "none",
    borderRadius: 999,
    padding: "8px 14px",
    fontSize: 13,
    fontWeight: 600,
    color: "#0b0d12",
    background: theme.accent,
    cursor: "pointer",
  },
  pill: {
    padding: "6px 10px",
    border: `1px solid ${theme.border}`,
    borderRadius: 999,
    fontSize: 12,
    color: theme.subtle,
    background: theme.panel,
  },
  status: (kind) => ({
    fontSize: 13,
    padding: "10px 12px",
    borderRadius: 10,
    background:
      kind === "error"
        ? "rgba(255,107,107,0.10)"
        : kind === "success"
        ? "rgba(45,212,191,0.10)"
        : "rgba(107,138,253,0.10)",
    border:
      `1px solid ` +
      (kind === "error"
        ? "rgba(255,107,107,0.30)"
        : kind === "success"
        ? "rgba(45,212,191,0.30)"
        : "rgba(107,138,253,0.30)"),
    color:
      kind === "error"
        ? theme.danger
        : kind === "success"
        ? theme.success
        : theme.text,
    marginTop: 14,
  }),
  footer: {
    maxWidth: 460,
    margin: "16px auto 0",
    fontSize: 11,
    color: theme.subtle,
    textAlign: "center",
    lineHeight: 1.6,
  },
  segmentLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: theme.subtle,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: 8,
    marginTop: 4,
  },
  segmentRow: {
    display: "flex",
    gap: 8,
    marginBottom: 14,
  },
  ghostBtn: {
    width: "100%",
    marginTop: 12,
    padding: "10px 14px",
    fontSize: 13,
    fontWeight: 500,
    color: theme.subtle,
    background: "transparent",
    border: `1px dashed ${theme.border}`,
    borderRadius: 12,
    cursor: "pointer",
  },
  copyBtn: {
    appearance: "none",
    flexShrink: 0,
    padding: "4px 10px",
    fontSize: 11,
    fontWeight: 600,
    color: theme.subtle,
    background: "rgba(0,0,0,0.35)",
    border: `1px solid ${theme.border}`,
    borderRadius: 8,
    cursor: "pointer",
  },
  burnerPanel: {
    marginTop: 14,
    padding: "14px 14px",
    borderRadius: 12,
    border: `1px solid ${theme.border}`,
    background: "rgba(0,0,0,0.22)",
  },
  burnerFieldLabel: {
    fontSize: 10,
    fontWeight: 600,
    color: theme.subtle,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    marginBottom: 6,
  },
  burnerMono: {
    display: "block",
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 11,
    lineHeight: 1.45,
    wordBreak: "break-all",
    color: theme.text,
    userSelect: "all",
  },
};

/* ----------------------------- UI bits ------------------------------ */

function CopyTextButton({ textToCopy, label = "Copy", disabled = false }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await copyToClipboard(textToCopy);
          setDone(true);
          setTimeout(() => setDone(false), 1800);
        } catch {
          /* ignore */
        }
      }}
      style={{
        ...styles.copyBtn,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
      title="Copy full value"
    >
      {done ? "Copied" : label}
    </button>
  );
}

function TruncatedAddrRow({ label, address }) {
  const full = getAddress(address);
  return (
    <div style={styles.row}>
      <span>{label}</span>
      <span
        style={{
          ...styles.rowValue,
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 8,
          flexWrap: "wrap",
          textAlign: "right",
        }}
      >
        <span title={full}>{shortAddr(full)}</span>
        <CopyTextButton textToCopy={full} />
      </span>
    </div>
  );
}

/**
 * React subscription to wagmi's account state without pulling in the full
 * `wagmi` React package. Both `subscribe` and `getSnapshot` are stable
 * module-level references, so React doesn't re-subscribe / re-read on
 * every render (which previously caused React Error #185).
 */
function useWagmiAccount() {
  return useSyncExternalStore(
    subscribeAccount,
    getAccountSnapshot,
    getAccountSnapshot
  );
}

function ConnectButton() {
  const { runConnect, connectBusy } = useContext(ConnectFlowContext);
  const { address, isConnected } = useWagmiAccount();
  const handleOpen = useCallback(async () => {
    try {
      await runConnect();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[connect]", e);
    }
  }, [runConnect]);
  const handleDisconnect = useCallback(() => {
    try {
      disconnect();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[disconnect]", e);
    }
  }, []);

  if (!isConnected) {
    return (
      <button
        style={{
          ...styles.connect,
          opacity: connectBusy ? 0.7 : 1,
          cursor: connectBusy ? "not-allowed" : "pointer",
        }}
        onClick={handleOpen}
        disabled={connectBusy}
      >
        {connectBusy ? "Connecting…" : "Connect Wallet"}
      </button>
    );
  }
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        justifyContent: "flex-end",
      }}
    >
      <CopyTextButton textToCopy={address} />
      <button
        style={{
          ...styles.connect,
          background: "transparent",
          color: theme.text,
          border: `1px solid ${theme.border}`,
        }}
        onClick={handleDisconnect}
        title={address}
      >
        {shortAddr(address)} · Disconnect
      </button>
    </div>
  );
}

function PoolCard() {
  const { runConnect, connectBusy } = useContext(ConnectFlowContext);
  const { address, isConnected } = useWagmiAccount();
  const [status, setStatus] = useState({ kind: "info", text: "Ready" });
  const [depositBusy, setDepositBusy] = useState(false);
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const [burnerBusy, setBurnerBusy] = useState(false);
  const [burnerWallet, setBurnerWallet] = useState(null);
  const [token, setToken] = useState("ETH");
  const [withdrawSpeed, setWithdrawSpeed] = useState("instant");
  const [ethDenom, setEthDenom] = useState("0.01");
  const [ethWithdrawFee, setEthWithdrawFee] = useState("0.001");
  const [usdtDenom, setUsdtDenom] = useState("100");
  const [usdtWithdrawFee, setUsdtWithdrawFee] = useState("0.1");
  const [relayUp, setRelayUp] = useState(null);
  const [showAddUsdtAfterWithdraw, setShowAddUsdtAfterWithdraw] = useState(false);
  const [addTokenBusy, setAddTokenBusy] = useState(false);
  const lastCommitment = useRef(null);

  const walletComplianceBlocked =
    Boolean(address) && isComplianceBlockedAddress(address);

  const seg = useCallback((active) => {
    return {
      flex: 1,
      minWidth: 64,
      padding: "10px 8px",
      borderRadius: 10,
      border: `1px solid ${active ? theme.accent : theme.border}`,
      background: active ? "rgba(107,138,253,0.22)" : "rgba(0,0,0,0.15)",
      color: active ? theme.text : theme.subtle,
      fontWeight: 600,
      fontSize: 12,
      cursor: "pointer",
    };
  }, []);

  const handleAddMockUsdtToWallet = useCallback(async () => {
    setAddTokenBusy(true);
    try {
      const eth = await getWalletEip1193Provider();
      if (!eth?.request) {
        throw new Error(
          "No wallet provider. Connect MetaMask (or a wallet that supports token import) on Sepolia."
        );
      }
      await watchAssetErc20(eth, MOCK_USDT_ADDRESS, "USDT", 6);
      setStatus((prev) => ({
        kind: "success",
        text:
          prev.kind === "success" && prev.text
            ? `${prev.text} Mock USDT token added to your wallet.`
            : "Mock USDT token added to your wallet.",
      }));
    } catch (e) {
      setStatus({
        kind: "error",
        text: `Add token failed: ${e?.message || e}`,
      });
    } finally {
      setAddTokenBusy(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await relayFetch("/relay", {
          method: "POST",
          headers: relayHeaders,
          body: JSON.stringify({}),
        });
        if (!res.ok) throw new Error(`Relay HTTP ${res.status}`);
        const r = await res.json();
        if (!cancelled) setRelayUp(r?.success === true);
      } catch {
        if (!cancelled) setRelayUp(false);
      }

      try {
        const provider = new JsonRpcProvider(SEPOLIA_READ_RPC);
        const pool = new Contract(POOL_ADDRESS, POOL_ABI, provider);
        const [eD, eP, uD, uP] = await Promise.all([
          pool.ETH_DENOMINATION(),
          pool.PROTOCOL_WITHDRAW_FEE_ETH(),
          pool.USDT_DENOMINATION(),
          pool.PROTOCOL_WITHDRAW_FEE_USDT(),
        ]);
        if (cancelled) return;
        setEthDenom(formatEther(eD));
        setEthWithdrawFee(formatEther(eP));
        setUsdtDenom(formatUnits(uD, 6));
        setUsdtWithdrawFee(formatUnits(uP, 6));
      } catch {
        /* RPC hiccup */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void getGroth16ArtifactsCached("[preload]")
      .then(() => console.log("[preload] Groth16 wasm/zkey + snarkjs warmed"))
      .catch((e) =>
        console.warn("[preload] Groth16 warm skipped:", e?.message || e)
      );
  }, []);

  async function ensureSepoliaSigner() {
    if (!wagmiConfig) throw new Error("Wallet not configured");

    /**
     * `getWalletClient()` from wagmi/viem can hang indefinitely (no popup) for WalletConnect
     * and some injected setups — it was tried FIRST here before, blocking Deposit for 180s.
     * Prefer EIP-1193 via `connector.getProvider()` or real `window.ethereum` so MetaMask / WC
     * actually receives `eth_sendTransaction` / chain switch.
     */
    async function requestSwitchToSepolia(eip1193) {
      if (!eip1193?.request) return;
      const chainIdHex = "0x" + SEPOLIA_CHAIN_ID.toString(16);
      try {
        await withTimeout(
          eip1193.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: chainIdHex }],
          }),
          60_000,
          "wallet_switchEthereumChain(Sepolia)"
        );
      } catch (e) {
        const code = e?.code;
        if (code === 4902 || code === -32603) {
          await withTimeout(
            eip1193.request({
              method: "wallet_addEthereumChain",
              params: [
                {
                  chainId: chainIdHex,
                  chainName: "Sepolia",
                  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
                  rpcUrls: [SEPOLIA_READ_RPC],
                  blockExplorerUrls: ["https://sepolia.etherscan.io"],
                },
              ],
            }),
            60_000,
            "wallet_addEthereumChain(Sepolia)"
          );
        } else {
          throw new Error("Please switch your wallet to Sepolia.");
        }
      }
    }

    await withTimeout(
      switchNetwork({ chainId: SEPOLIA_CHAIN_ID }).catch(() => {}),
      25_000,
      "wagmi switchNetwork(Sepolia)"
    ).catch(() => {
      console.warn(
        "[ensureSepoliaSigner] switchNetwork timed out; trying direct EIP-1193 switch"
      );
    });

    const connector = getAccount()?.connector;
    const connectorId = connector ? String(connector.id) : "";
    /** WalletConnect must use the session provider; extension wallets hang on `getProvider()` in some builds. */
    const useWalletConnectProvider = connectorId === "walletConnect";

    async function signerFromEip1193(eip1193, label) {
      console.log("[ensureSepoliaSigner]", label);
      let provider = new BrowserProvider(eip1193);
      let net = await withTimeout(
        provider.getNetwork(),
        20_000,
        `${label}: provider.getNetwork()`
      );
      if (Number(net.chainId) !== SEPOLIA_CHAIN_ID) {
        await requestSwitchToSepolia(eip1193);
        provider = new BrowserProvider(eip1193);
        net = await withTimeout(
          provider.getNetwork(),
          20_000,
          `${label}: getNetwork after switch`
        );
        if (Number(net.chainId) !== SEPOLIA_CHAIN_ID) {
          throw new Error("Please switch your wallet to Sepolia.");
        }
      }
      return provider.getSigner();
    }

    if (
      !useWalletConnectProvider &&
      typeof window !== "undefined" &&
      window.ethereum &&
      !isInjectedEthereumStub()
    ) {
      try {
        return await signerFromEip1193(
          window.ethereum,
          "using window.ethereum (MetaMask / injected — before connector.getProvider)"
        );
      } catch (e) {
        console.warn("[ensureSepoliaSigner] window.ethereum path failed", e);
      }
    }

    if (connector && typeof connector.getProvider === "function") {
      let raw = null;
      try {
        console.log(
          "[ensureSepoliaSigner] connector.getProvider()",
          connectorId || "(no id)"
        );
        raw = await withTimeout(
          connector.getProvider(),
          15_000,
          "connector.getProvider()"
        );
      } catch (e) {
        console.warn(
          "[ensureSepoliaSigner] connector.getProvider timed out or threw",
          e?.message || e
        );
      }
      if (raw) {
        return await signerFromEip1193(raw, "using connector EIP-1193 provider");
      }
    }

    if (
      typeof window !== "undefined" &&
      window.ethereum &&
      !isInjectedEthereumStub()
    ) {
      return await signerFromEip1193(
        window.ethereum,
        "fallback window.ethereum after connector failures"
      );
    }

    let walletClient = null;
    try {
      console.log("[ensureSepoliaSigner] trying getWalletClient (last resort)");
      walletClient = await withTimeout(
        getWalletClient({ chainId: SEPOLIA_CHAIN_ID }).catch(() =>
          getWalletClient()
        ),
        15_000,
        "getWalletClient()"
      );
    } catch (e) {
      console.warn("[ensureSepoliaSigner] getWalletClient timed out", e?.message || e);
    }

    if (walletClient) {
      const eip1193 = {
        request: (args) =>
          walletClient.request({
            method: args.method,
            params: args.params ?? [],
          }),
      };
      return await signerFromEip1193(eip1193, "via wagmi getWalletClient bridge");
    }

    throw new Error("No wallet provider available");
  }

  async function handleDeposit() {
    if (walletComplianceBlocked) {
      setStatus({ kind: "error", text: COMPLIANCE_BLOCKED_MESSAGE });
      return;
    }
    if (!isConnected) {
      try {
        await runConnect();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[connect]", e);
      }
      return;
    }
    if (!address) return;

    setDepositBusy(true);
    setShowAddUsdtAfterWithdraw(false);
    const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    console.log(`[deposit] === start run ${runId} ===`);

    try {
      console.log("[deposit] Step A: status → Generating commitment");
      setStatus({ kind: "info", text: "Generating commitment…" });

      let commitment;
      try {
        commitment = randomCommitment();
        lastCommitment.current = commitment;
        console.log("[deposit] Step B: commitment bytes32 =", commitment);
      } catch (e) {
        throw new Error(formatDepositFailure("randomCommitment / crypto.getRandomValues", e));
      }

      console.log("[deposit] Step C: verifying SNARK artifacts + snarkjs (fetch + optional diagnostic prove)");
      setStatus({
        kind: "info",
        text: "Checking ZK files (wasm/zkey) and SnarkJS…",
      });
      try {
        await verifySnarkArtifactsStepByStep();
      } catch (e) {
        throw new Error(
          formatDepositFailure("verifySnarkArtifactsStepByStep (404/CORS/snarkjs)", e)
        );
      }

      console.log("[deposit] Step D: obtaining wallet signer (timeout may apply)");
      setStatus({
        kind: "info",
        text: "Connecting wallet — approve in MetaMask or WalletConnect…",
      });
      let signer;
      try {
        signer = await withTimeout(
          ensureSepoliaSigner(),
          SIGNER_TIMEOUT_MS,
          "ensureSepoliaSigner()"
        );
        const fromAddr = await signer.getAddress();
        console.log("[deposit] Step E: signer OK", fromAddr);
      } catch (e) {
        throw new Error(
          formatDepositFailure(
            "ensureSepoliaSigner (wallet chain / WalletConnect)",
            e
          )
        );
      }

      let pool;
      try {
        pool = new Contract(POOL_ADDRESS, POOL_ABI, signer);
        console.log("[deposit] Step F: contract instance for pool", POOL_ADDRESS);
      } catch (e) {
        throw new Error(formatDepositFailure("Contract(POOL_ADDRESS)", e));
      }

      if (token === "ETH") {
        setStatus({ kind: "info", text: "Reading required ETH deposit from pool…" });
        let value;
        try {
          value = await pool.depositAmountRequired();
          console.log("[deposit] Step G: depositAmountRequired =", value.toString());
        } catch (e) {
          throw new Error(formatDepositFailure("pool.depositAmountRequired()", e));
        }

        setStatus({ kind: "info", text: "Awaiting wallet (ETH deposit)…" });
        let tx;
        try {
          tx = await pool.deposit(commitment, { value });
          console.log("[deposit] Step H: deposit tx submitted", tx.hash);
        } catch (e) {
          throw new Error(formatDepositFailure("pool.deposit(commitment)", e));
        }

        setStatus({
          kind: "info",
          text: `Submitted: ${tx.hash.slice(0, 10)}… (waiting for confirmation)`,
        });
        let receipt;
        try {
          receipt = await tx.wait();
          console.log("[deposit] Step I: confirmed block", receipt.blockNumber);
        } catch (e) {
          throw new Error(formatDepositFailure("tx.wait() ETH deposit", e));
        }

        setStatus({
          kind: "success",
          text: `ETH deposit confirmed in block ${receipt.blockNumber}.`,
        });
      } else {
        setStatus({ kind: "info", text: "Reading required USDT deposit from pool…" });
        let amount;
        try {
          amount = await pool.usdtDepositAmountRequired();
          console.log("[deposit] Step G: usdtDepositAmountRequired =", amount.toString());
        } catch (e) {
          throw new Error(
            formatDepositFailure("pool.usdtDepositAmountRequired()", e)
          );
        }

        const usdt = new Contract(MOCK_USDT_ADDRESS, ERC20_ABI, signer);
        let allowance;
        try {
          allowance = await usdt.allowance(address, POOL_ADDRESS);
          console.log("[deposit] allowance vs required", allowance.toString(), amount.toString());
        } catch (e) {
          throw new Error(formatDepositFailure("usdt.allowance", e));
        }

        if (allowance < amount) {
          setStatus({ kind: "info", text: "Approving Mock USDT…" });
          try {
            const txA = await usdt.approve(POOL_ADDRESS, MaxUint256);
            console.log("[deposit] approve tx", txA.hash);
            await txA.wait();
          } catch (e) {
            throw new Error(formatDepositFailure("usdt.approve", e));
          }
        }

        setStatus({ kind: "info", text: "Awaiting wallet (USDT deposit)…" });
        let txD;
        try {
          txD = await pool.depositUsdt(commitment);
          console.log("[deposit] depositUsdt tx", txD.hash);
        } catch (e) {
          throw new Error(formatDepositFailure("pool.depositUsdt", e));
        }

        setStatus({
          kind: "info",
          text: `Submitted: ${txD.hash.slice(0, 10)}… (waiting for confirmation)`,
        });
        let receipt;
        try {
          receipt = await txD.wait();
        } catch (e) {
          throw new Error(formatDepositFailure("tx.wait() USDT deposit", e));
        }

        setStatus({
          kind: "success",
          text: `USDT deposit confirmed in block ${receipt.blockNumber}.`,
        });
      }

      console.log(`[deposit] === success run ${runId} ===`);
    } catch (e) {
      const msg =
        typeof e?.message === "string" && e.message.startsWith("Deposit failed")
          ? e.message
          : formatDepositFailure("unknown", e);
      console.error(`[deposit] === FAILED run ${runId} ===`, e);
      setStatus({ kind: "error", text: msg });
    } finally {
      setDepositBusy(false);
    }
  }

  async function handleWithdraw() {
    const wid = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    console.log("[withdraw] click → handleWithdraw()", wid, {
      isConnected,
      address: address || null,
      depositBusy,
      withdrawBusy,
      token,
      withdrawSpeed,
      commitment: lastCommitment.current,
    });

    if (!isConnected) {
      console.log("[withdraw] not connected — opening wallet connect flow");
      try {
        await runConnect();
      } catch (e) {
        console.error("[withdraw] connect error", e);
      }
      return;
    }
    if (!address) {
      console.warn("[withdraw] abort: no address");
      setStatus({ kind: "error", text: "No wallet address for withdrawal." });
      return;
    }
    if (walletComplianceBlocked) {
      setStatus({ kind: "error", text: COMPLIANCE_BLOCKED_MESSAGE });
      return;
    }
    const withdrawRecipient = burnerWallet?.address || address;
    if (isComplianceBlockedAddress(withdrawRecipient)) {
      setStatus({ kind: "error", text: COMPLIANCE_BLOCKED_MESSAGE });
      return;
    }

    setWithdrawBusy(true);
    setShowAddUsdtAfterWithdraw(false);
    setStatus({
      kind: "info",
      text: "Withdraw: loading artifacts and chain data…",
    });

    try {
      console.log("[withdraw] Step 1: loading artifacts + roots");
      const [{ wasmBytes, zkeyBytes }, roots] = await Promise.all([
        getGroth16ArtifactsCached("[withdraw][zk]"),
        fetchWithdrawRoots(token),
      ]);

      const { stateRoot, aspRoot } = roots;
      if (aspRoot === ZeroHash || BigInt(aspRoot) === 0n) {
        throw new Error(
          "This pool has no ASP Merkle root on-chain yet (no publishAspRoot). " +
            "Run once from repo root: npx hardhat run scripts/bootstrap-asp-root.js --network sepolia " +
            "(uses PRIVATE_KEY pool admin in TelegramMixer/.env), then retry Withdraw."
        );
      }

      // Fee wallet + atomic fee are loaded inside buildProofAndRelay (fresh GET /fee-config each attempt).
      const nullifierHash = keccak256(randomBytes(32));

      async function buildProofAndRelay() {
        const { feeWallet, feeAtomicStr } = await fetchWithdrawFeeSnapshot(token);

        const witness = buildPoolPublicBindWitness({
          stateRootHex: stateRoot,
          aspRootHex: aspRoot,
          nullifierHashHex: nullifierHash,
          recipientAddr: withdrawRecipient,
          relayerAddr: feeWallet,
          feeStr: feeAtomicStr,
        });

        setStatus({
          kind: "info",
          text: `Withdraw: proving for ${shortAddr(
            withdrawRecipient
          )} (fee ${feeAtomicStr} atomic)…`,
        });
        console.log("[withdraw] witness bind", {
          feeAtomicStr,
          feeWallet,
          token,
        });

        const zkBundle = await generateWithdrawBindingProof(
          wasmBytes,
          zkeyBytes,
          witness
        );
        console.log(
          "[withdraw] groth16 OK; proofHex length:",
          zkBundle.proofHex?.length
        );

        const relayBody = {
          action: "withdraw",
          sender: address,
          recipient: withdrawRecipient,
          commitment: lastCommitment.current ?? null,
          token,
          withdrawSpeed,
          fee: feeAtomicStr,
          proof: zkBundle.proofHex,
          publicSignals: JSON.parse(
            JSON.stringify(zkBundle.publicSignals, (_, v) =>
              typeof v === "bigint" ? v.toString() : v
            )
          ),
          stateRoot,
          aspRoot,
          nullifierHash,
        };

        setStatus({ kind: "info", text: "Withdraw: calling relayer…" });
        console.log("[withdraw] POST /relay", buildRelayUrl("/relay"), {
          ...relayBody,
          proof: `(hex ${relayBody.proof.length} chars)`,
        });

        return postRelay(relayBody);
      }

      const maxAttempts = 3;
      let r = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        r = await buildProofAndRelay();
        if (r?.success) break;

        const msg = String(r?.message || "");
        const feeDrift =
          /Relayer fee mismatch/i.test(msg) && attempt < maxAttempts;

        if (feeDrift) {
          console.warn("[withdraw] fee drift vs server; refetch + reprove", {
            attempt,
            msg,
            expectedRelayerFee: r?.expectedRelayerFee,
          });
          setStatus({
            kind: "info",
            text: `Relayer fee moved during proving; retry ${attempt + 1}/${maxAttempts}…`,
          });
          continue;
        }
        break;
      }

      console.log("[withdraw] Step 4 relayer JSON:", r);
      setStatus({
        kind: r?.success ? "success" : "error",
        text: hintRelayerRpcPaymentError(r?.message || "Relayer responded."),
      });
      setShowAddUsdtAfterWithdraw(Boolean(r?.success && token === "USDT"));
    } catch (e) {
      console.error("[withdraw] FAILED", wid, e);
      setShowAddUsdtAfterWithdraw(false);
      setStatus({
        kind: "error",
        text: `Withdraw failed: ${hintRelayerRpcPaymentError(e?.message || e)}`,
      });
    } finally {
      setWithdrawBusy(false);
      console.log("[withdraw] done", wid);
    }
  }

  async function handleGenerateBurner() {
    setBurnerWallet(null);
    setBurnerBusy(true);
    setStatus({
      kind: "info",
      text: "Requesting burner wallet from relayer…",
    });
    try {
      const res = await relayFetch("/generate-burner", {
        method: "POST",
        headers: relayHeaders,
        body: JSON.stringify({ nonce: Date.now() }),
      });
      if (!res.ok) {
        throw new Error(`Relay HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!data.address || !data.privateKey) {
        throw new Error("Relayer returned an invalid burner payload");
      }
      setBurnerWallet({
        address: String(data.address),
        privateKey: String(data.privateKey),
      });
      setStatus({
        kind: "success",
        text: "Burner wallet generated.",
      });
    } catch (e) {
      const msg = e?.message || String(e);
      setStatus({ kind: "error", text: `Burner: ${msg}` });
    } finally {
      setBurnerBusy(false);
    }
  }

  const depositLabel =
    token === "ETH"
      ? `${ethDenom} ETH`
      : `${usdtDenom} USDT`;

  return (
    <div style={styles.card}>
      <h2 style={styles.title}>TelegramPrivacyPool</h2>
      <p style={styles.subtitle}>
        Fixed-denomination privacy pools on Sepolia with on-chain compliance
        hooks.
      </p>

      <div style={styles.segmentLabel}>Asset</div>
      <div style={styles.segmentRow}>
        <button type="button" style={seg(token === "ETH")} onClick={() => setToken("ETH")}>
          ETH
        </button>
        <button type="button" style={seg(token === "USDT")} onClick={() => setToken("USDT")}>
          USDT
        </button>
      </div>

      <p
        style={{
          margin: "0 0 14px",
          fontSize: 13,
          color: theme.accent,
          fontWeight: 600,
          lineHeight: 1.4,
        }}
      >
        Protocol withdraw fee: {ethWithdrawFee} ETH · {usdtWithdrawFee} USDT (per withdrawal, not on deposit)
      </p>

      <div style={styles.row}>
        <span>Network</span>
        <span style={styles.rowValue}>Sepolia</span>
      </div>
      <TruncatedAddrRow label="Pool" address={POOL_ADDRESS} />
      <TruncatedAddrRow label="USDT (mock)" address={MOCK_USDT_ADDRESS} />

      {walletComplianceBlocked ? (
        <p
          role="alert"
          style={{
            margin: "0 0 14px",
            padding: "12px 14px",
            borderRadius: 10,
            border: "1px solid rgba(220, 38, 38, 0.55)",
            background: "rgba(220, 38, 38, 0.12)",
            color: "#f87171",
            fontSize: 14,
            fontWeight: 600,
            lineHeight: 1.45,
          }}
        >
          {COMPLIANCE_BLOCKED_MESSAGE}
        </p>
      ) : null}

      {token === "ETH" ? (
        <>
          <div style={styles.row}>
            <span>Denomination</span>
            <span style={styles.rowValue}>{ethDenom} ETH</span>
          </div>
          <div style={styles.row}>
            <span>Deposit total</span>
            <span style={styles.rowValue}>{ethDenom} ETH</span>
          </div>
        </>
      ) : (
        <>
          <div style={styles.row}>
            <span>Denomination</span>
            <span style={styles.rowValue}>{usdtDenom} USDT</span>
          </div>
          <div style={styles.row}>
            <span>Deposit total</span>
            <span style={styles.rowValue}>{usdtDenom} USDT</span>
          </div>
        </>
      )}

      <div style={styles.row}>
        <span>Relayer</span>
        <span style={styles.rowValue}>
          {relayUp == null ? "checking…" : relayUp ? "online" : "offline"}
        </span>
      </div>

      <div style={{ ...styles.segmentLabel, marginTop: 14 }}>
        Withdrawal speed
      </div>
      <div style={styles.segmentRow}>
        <button
          type="button"
          style={seg(withdrawSpeed === "instant")}
          onClick={() => setWithdrawSpeed("instant")}
        >
          Instant
        </button>
        <button
          type="button"
          style={seg(withdrawSpeed === "12h")}
          onClick={() => setWithdrawSpeed("12h")}
        >
          12 Hours
        </button>
        <button
          type="button"
          style={seg(withdrawSpeed === "24h")}
          onClick={() => setWithdrawSpeed("24h")}
        >
          24 Hours
        </button>
      </div>

      <div style={styles.buttonRow}>
        <button
          type="button"
          style={styles.primary}
          onClick={handleDeposit}
          disabled={
            depositBusy ||
            withdrawBusy ||
            connectBusy ||
            walletComplianceBlocked
          }
        >
          {connectBusy
            ? "Connecting Wallet…"
            : isConnected
            ? `Deposit ${depositLabel}`
            : "Connect & Deposit"}
        </button>
        <button
          type="button"
          style={styles.secondary}
          onClick={() => {
            console.log("[withdraw] button onClick fired");
            void handleWithdraw();
          }}
          disabled={
            withdrawBusy ||
            depositBusy ||
            connectBusy ||
            walletComplianceBlocked
          }
        >
          {connectBusy ? "Connecting Wallet…" : "Withdraw"}
        </button>
      </div>

      <button
        type="button"
        style={styles.ghostBtn}
        onClick={handleGenerateBurner}
        disabled={depositBusy || withdrawBusy || burnerBusy || connectBusy}
      >
        {burnerBusy ? "Generating…" : "Generate Burner Wallet"}
      </button>

      {burnerWallet ? (
        <div style={styles.burnerPanel}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              marginBottom: 6,
            }}
          >
            <div style={styles.burnerFieldLabel}>Address</div>
            <CopyTextButton textToCopy={burnerWallet.address} />
          </div>
          <span style={{ ...styles.burnerMono, marginBottom: 12 }}>
            {burnerWallet.address}
          </span>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              marginTop: 14,
              marginBottom: 6,
            }}
          >
            <div style={styles.burnerFieldLabel}>
              Private key (copy once, store offline — never commit)
            </div>
            <CopyTextButton textToCopy={burnerWallet.privateKey} />
          </div>
          <span style={styles.burnerMono}>{burnerWallet.privateKey}</span>
        </div>
      ) : null}

      <div
        style={{
          marginTop: 14,
          display: "flex",
          flexWrap: "wrap",
          alignItems: "stretch",
          gap: 10,
        }}
      >
        <div
          style={{
            ...styles.status(status.kind),
            marginTop: 0,
            flex: "1 1 220px",
            minWidth: 0,
          }}
        >
          {status.text}
        </div>
        {status.kind === "success" && showAddUsdtAfterWithdraw ? (
          <button
            type="button"
            style={{
              ...styles.secondary,
              alignSelf: "center",
              flex: "0 0 auto",
              whiteSpace: "nowrap",
            }}
            onClick={() => void handleAddMockUsdtToWallet()}
            disabled={addTokenBusy || connectBusy}
          >
            {addTokenBusy ? "Adding…" : "Add USDT to Wallet"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function WalletConnectOverlay({ open, uri, onCancel }) {
  if (!open) return null;
  const mmLink =
    uri && uri.length > 0
      ? `https://metamask.app.link/wc?uri=${encodeURIComponent(uri)}`
      : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 99999,
        background: "rgba(6,8,12,0.92)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          maxWidth: 400,
          width: "100%",
          background: theme.panel,
          border: `1px solid ${theme.border}`,
          borderRadius: 16,
          padding: 22,
          color: theme.text,
        }}
      >
        <h3 style={{ margin: "0 0 8px", fontSize: 17 }}>WalletConnect</h3>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: theme.subtle }}>
          Approve the connection in your wallet app. On mobile you can open
          MetaMask directly below.
        </p>
        {mmLink ? (
          <a
            href={mmLink}
            style={{
              display: "block",
              textAlign: "center",
              marginBottom: 12,
              padding: "12px 14px",
              borderRadius: 12,
              background: theme.accent,
              color: "#0b0d12",
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            Open in MetaMask
          </a>
        ) : (
          <p style={{ fontSize: 13, color: theme.subtle }}>Preparing link…</p>
        )}
        {uri ? (
          <textarea
            readOnly
            value={uri}
            style={{
              width: "100%",
              minHeight: 72,
              marginTop: 8,
              fontSize: 11,
              fontFamily: "ui-monospace, monospace",
              background: theme.bg,
              color: theme.subtle,
              border: `1px solid ${theme.border}`,
              borderRadius: 8,
              padding: 8,
              boxSizing: "border-box",
            }}
          />
        ) : null}
        <button
          type="button"
          onClick={onCancel}
          style={{
            marginTop: 14,
            width: "100%",
            ...styles.secondary,
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/* --------------------------- Main wrapper --------------------------- */

export default function TelegramMixerApp() {
  const [wcOverlay, setWcOverlay] = useState({ open: false, uri: "" });
  const [connectBusy, setConnectBusy] = useState(false);
  const runConnect = useCallback(
    async () => {
      if (connectBusy) return;
      setConnectBusy(true);
      try {
        await openConnectFlow(setWcOverlay);
      } finally {
        setConnectBusy(false);
      }
    },
    [connectBusy]
  );
  // Hooks must run in the same order every render — declare them first,
  // then branch on init state.
  const heading = useMemo(
    () => (
      <div style={styles.topBar}>
        <div style={styles.brand}>
          <span style={styles.dot} />
          <span>Privacy Pool · Sepolia</span>
        </div>
        <ConnectButton />
      </div>
    ),
    []
  );

  if (web3InitError) {
    return (
      <div style={styles.page}>
        <div style={styles.topBar}>
          <div style={styles.brand}>
            <span style={{ ...styles.dot, background: theme.subtle }} />
            <span>Privacy Pool · setup</span>
          </div>
        </div>
        <div style={styles.card}>
          <h2 style={styles.title}>Could not initialize wallets</h2>
          <p style={styles.subtitle}>
            The chain connector failed to start. You can still reload or try an
            external browser.
          </p>
          <div style={{ fontSize: 13, color: theme.subtle, marginTop: 14 }}>
            {web3InitError}
          </div>
        </div>
      </div>
    );
  }

  return (
    <ConnectFlowContext.Provider value={{ runConnect, connectBusy }}>
      <>
        <div style={styles.page}>
          {heading}
          <PoolCard />
          <div style={styles.footer}>
            Connect a Sepolia wallet to deposit. Withdrawals are routed through
            the relayer for privacy.
            <br />
            Pool: <span style={{ color: theme.text }}>{POOL_ADDRESS}</span>
          </div>
        </div>
        <WalletConnectOverlay
          open={wcOverlay.open}
          uri={wcOverlay.uri}
          onCancel={async () => {
            try {
              await disconnect();
            } catch {
              /* ignore */
            }
            setWcOverlay({ open: false, uri: "" });
          }}
        />
      </>
    </ConnectFlowContext.Provider>
  );
}
