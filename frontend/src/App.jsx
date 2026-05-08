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
import { BrowserProvider, Contract, JsonRpcProvider, formatEther, formatUnits, MaxUint256 } from "ethers";
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
 * Groth16 artifacts copied to `frontend/public/` — root-relative URLs on Vercel/Vite (`/circuit.wasm`, `/circuit.zkey`).
 */
const CIRCUIT_WASM_URL = "/circuit.wasm";
const CIRCUIT_ZKEY_URL = "/circuit.zkey";

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

const POOL_ADDRESS = "0x84025852E750693826bC12596F1E917343CFdbAE";

/** Sepolia MockUSDT (6 decimals); deployer receives initial supply. */
const MOCK_USDT_ADDRESS = "0x41DA8EaeC31F04bf29f1c30F046DD9A1Eef1218A";

/** Public HTTPS base URL for the relayer (Ngrok tunnel to localhost:3000). No trailing slash. */
const RELAY_URL = String(
  (typeof import.meta !== "undefined" &&
    import.meta.env &&
    import.meta.env.VITE_RELAY_URL) ||
    "https://dodge-reflex-hangnail.ngrok-free.dev"
).trim();

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
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
];

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

const ConnectFlowContext = createContext(() => Promise.resolve());

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

async function postRelay(body = {}) {
  const res = await fetch(`${RELAY_URL}/relay`, {
    method: "POST",
    headers: relayHeaders,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Relay HTTP ${res.status}`);
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
  const runConnect = useContext(ConnectFlowContext);
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
      <button style={styles.connect} onClick={handleOpen}>
        Connect Wallet
      </button>
    );
  }
  return (
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
  );
}

function PoolCard() {
  const runConnect = useContext(ConnectFlowContext);
  const { address, isConnected } = useWagmiAccount();
  const [status, setStatus] = useState({ kind: "info", text: "Ready" });
  const [busy, setBusy] = useState(false);
  const [burnerBusy, setBurnerBusy] = useState(false);
  const [burnerWallet, setBurnerWallet] = useState(null);
  const [token, setToken] = useState("ETH");
  const [withdrawSpeed, setWithdrawSpeed] = useState("instant");
  const [ethDenom, setEthDenom] = useState("0.01");
  const [ethWithdrawFee, setEthWithdrawFee] = useState("0.001");
  const [usdtDenom, setUsdtDenom] = useState("100");
  const [usdtWithdrawFee, setUsdtWithdrawFee] = useState("1");
  const [relayUp, setRelayUp] = useState(null);
  const lastCommitment = useRef(null);

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await postRelay({});
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

  async function ensureSepoliaSigner() {
    if (!wagmiConfig) throw new Error("Wallet not configured");

    try {
      await switchNetwork({ chainId: SEPOLIA_CHAIN_ID });
    } catch {
      /* already on Sepolia or pending */
    }

    const walletClient =
      (await getWalletClient({ chainId: SEPOLIA_CHAIN_ID }).catch(() =>
        getWalletClient()
      )) || null;

    if (walletClient) {
      const eip1193 = {
        request: (args) =>
          walletClient.request({
            method: args.method,
            params: args.params ?? [],
          }),
      };
      const provider = new BrowserProvider(eip1193);
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== SEPOLIA_CHAIN_ID) {
        throw new Error("Please switch your wallet to Sepolia.");
      }
      return provider.getSigner();
    }

    if (
      typeof window !== "undefined" &&
      window.ethereum &&
      !isInjectedEthereumStub()
    ) {
      const provider = new BrowserProvider(window.ethereum);
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== SEPOLIA_CHAIN_ID) {
        try {
          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x" + SEPOLIA_CHAIN_ID.toString(16) }],
          });
        } catch {
          throw new Error("Please switch your wallet to Sepolia.");
        }
      }
      return provider.getSigner();
    }

    throw new Error("No wallet provider available");
  }

  async function handleDeposit() {
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
    setBusy(true);
    setStatus({ kind: "info", text: "Generating commitment…" });
    try {
      const commitment = randomCommitment();
      lastCommitment.current = commitment;

      const signer = await ensureSepoliaSigner();
      const pool = new Contract(POOL_ADDRESS, POOL_ABI, signer);

      if (token === "ETH") {
        setStatus({ kind: "info", text: "Awaiting wallet (ETH deposit)…" });
        const value = await pool.depositAmountRequired();
        const tx = await pool.deposit(commitment, { value });
        setStatus({
          kind: "info",
          text: `Submitted: ${tx.hash.slice(0, 10)}… (waiting for confirmation)`,
        });
        const receipt = await tx.wait();
        setStatus({
          kind: "success",
          text: `ETH deposit confirmed in block ${receipt.blockNumber}.`,
        });
      } else {
        const amount = await pool.usdtDepositAmountRequired();
        const usdt = new Contract(MOCK_USDT_ADDRESS, ERC20_ABI, signer);
        const allowance = await usdt.allowance(address, POOL_ADDRESS);
        if (allowance < amount) {
          setStatus({ kind: "info", text: "Approving Mock USDT…" });
          const txA = await usdt.approve(POOL_ADDRESS, MaxUint256);
          await txA.wait();
        }
        setStatus({ kind: "info", text: "Awaiting wallet (USDT deposit)…" });
        const txD = await pool.depositUsdt(commitment);
        setStatus({
          kind: "info",
          text: `Submitted: ${txD.hash.slice(0, 10)}… (waiting for confirmation)`,
        });
        const receipt = await txD.wait();
        setStatus({
          kind: "success",
          text: `USDT deposit confirmed in block ${receipt.blockNumber}.`,
        });
      }
    } catch (e) {
      const msg = e?.shortMessage || e?.reason || e?.message || String(e);
      setStatus({ kind: "error", text: `Deposit failed: ${msg}` });
    } finally {
      setBusy(false);
    }
  }

  async function handleWithdraw() {
    if (!isConnected) {
      try {
        await runConnect();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[connect]", e);
      }
      return;
    }
    setBusy(true);
    setStatus({ kind: "info", text: "Requesting relayer-paid withdrawal…" });
    try {
      const r = await postRelay({
        action: "withdraw",
        recipient: address,
        commitment: lastCommitment.current ?? null,
        token,
        withdrawSpeed,
      });
      setStatus({
        kind: r?.success ? "success" : "error",
        text: r?.message || "Relayer responded.",
      });
    } catch (e) {
      setStatus({ kind: "error", text: `Relay error: ${e.message}` });
    } finally {
      setBusy(false);
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
      const res = await fetch(`${RELAY_URL}/generate-burner`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "ngrok-skip-browser-warning": "true",
        },
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
      <div style={styles.row}>
        <span>Pool</span>
        <span style={styles.rowValue}>{shortAddr(POOL_ADDRESS)}</span>
      </div>
      <div style={styles.row}>
        <span>USDT (mock)</span>
        <span style={styles.rowValue}>{shortAddr(MOCK_USDT_ADDRESS)}</span>
      </div>

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
          style={styles.primary}
          onClick={handleDeposit}
          disabled={busy}
        >
          {isConnected ? `Deposit ${depositLabel}` : "Connect & Deposit"}
        </button>
        <button
          style={styles.secondary}
          onClick={handleWithdraw}
          disabled={busy}
        >
          Withdraw
        </button>
      </div>

      <button
        type="button"
        style={styles.ghostBtn}
        onClick={handleGenerateBurner}
        disabled={busy || burnerBusy}
      >
        {burnerBusy ? "Generating…" : "Generate Burner Wallet"}
      </button>

      {burnerWallet ? (
        <div style={styles.burnerPanel}>
          <div style={styles.burnerFieldLabel}>Address</div>
          <span style={{ ...styles.burnerMono, marginBottom: 12 }}>
            {burnerWallet.address}
          </span>
          <div style={{ ...styles.burnerFieldLabel, marginTop: 14 }}>
            Private key (copy once, store offline — never commit)
          </div>
          <span style={styles.burnerMono}>{burnerWallet.privateKey}</span>
        </div>
      ) : null}

      <div style={styles.status(status.kind)}>{status.text}</div>
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
  const runConnect = useCallback(
    () => openConnectFlow(setWcOverlay),
    []
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
    <ConnectFlowContext.Provider value={runConnect}>
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
