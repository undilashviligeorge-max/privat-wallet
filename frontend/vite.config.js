import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true,
    }),
  ],
  define: {
    "process.env": {},
  },
  resolve: {
    alias: {
      "node:buffer": "buffer",
      "node:process": "process",
    },
  },
  build: {
    target: "es2020",
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          ethers: ["ethers"],
          web3modal: ["@web3modal/ethereum", "@web3modal/react"],
          wagmi: ["@wagmi/core", "viem"],
        },
      },
    },
  },
});
