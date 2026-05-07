#!/usr/bin/env node
/**
 * One-shot Groth16 artifacts → contracts/Groth16VerifierGenerated.sol
 * Prerequisites: npm run build:circuit, and pot12_final.ptau in project root
 * (create once with powers of tau; see README or run ptau commands).
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(root, "..");
const r1cs = path.join(projectRoot, "build/circuit/PoolPublicBind.r1cs");
const ptau = path.join(projectRoot, "pot12_final.ptau");
const z0 = path.join(projectRoot, "build/circuit/pool_0000.zkey");
const z1 = path.join(projectRoot, "build/circuit/pool_final.zkey");
const vk = path.join(projectRoot, "build/circuit/verification_key.json");
const solOut = path.join(projectRoot, "contracts/Groth16VerifierGenerated.sol");

function run(cmd) {
  execSync(cmd, { stdio: "inherit", cwd: projectRoot });
}

if (!fs.existsSync(r1cs)) {
  console.error("Missing R1CS. Run: npm run build:circuit");
  process.exit(1);
}
if (!fs.existsSync(ptau)) {
  console.error("Missing pot12_final.ptau in project root. Generate with snarkjs powersoftau flow (see scripts/README-ptau.txt).");
  process.exit(1);
}

run(`npx snarkjs g16s "${r1cs}" "${ptau}" "${z0}"`);
run(
  `npx snarkjs zkc "${z0}" "${z1}" -e="rebuild-${Date.now()}" -n="local"`
);
run(`npx snarkjs zkev "${z1}" "${vk}"`);
run(`npx snarkjs zkesv "${z1}" "${solOut}"`);
console.log("Groth16 verifier written to contracts/Groth16VerifierGenerated.sol");
