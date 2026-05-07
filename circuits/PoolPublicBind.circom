pragma circom 2.0.0;

/**
 * Minimal Groth16 binding circuit for six public signals matching
 * TelegramPrivacyPool.withdraw publicInputs layout:
 *   [stateRoot, aspRoot, nullifierHash, recipient, relayer, fee]
 *
 * Proves correct arithmetic wiring; replace with the full Privacy Pools
 * withdrawal circuit when ready.
 */
template PoolPublicBind() {
    signal input stateRoot;
    signal input aspRoot;
    signal input nullifierHash;
    signal input recipient;
    signal input relayer;
    signal input fee;

    signal ab;
    ab <== stateRoot * aspRoot;

    signal cd;
    cd <== nullifierHash * recipient;

    signal ef;
    ef <== relayer * fee;

    signal sum;
    sum <== ab + cd + ef;

    sum * 1 === sum;
}

component main {
    public [stateRoot, aspRoot, nullifierHash, recipient, relayer, fee]
} = PoolPublicBind();
