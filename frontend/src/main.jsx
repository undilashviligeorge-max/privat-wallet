// Polyfill Node-style globals BEFORE any other import. Some Web3 deps
// (WalletConnect / readable-stream) reference `global`, `Buffer`, or
// `process` and crash with a blank screen otherwise.
if (typeof window !== "undefined") {
  window.global = window;
}
import { Buffer } from "buffer";
import process from "process";
if (typeof window !== "undefined") {
  if (!window.Buffer) window.Buffer = Buffer;
  if (!window.process) window.process = process;
}

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import TelegramMixerApp from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <TelegramMixerApp />
  </StrictMode>
);
