import * as snarkjs from "snarkjs";

function serializeBigints(obj) {
  return JSON.parse(
    JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v))
  );
}

self.onmessage = async (ev) => {
  const { witness, wasmBuffer, zkeyBuffer } = ev.data || {};
  try {
    const wasm = new Uint8Array(wasmBuffer);
    const zkey = new Uint8Array(zkeyBuffer);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      witness,
      wasm,
      zkey
    );
    self.postMessage({
      ok: true,
      proof: serializeBigints(proof),
      publicSignals: serializeBigints(publicSignals),
    });
  } catch (e) {
    self.postMessage({
      ok: false,
      error: e?.message || String(e),
    });
  }
};
