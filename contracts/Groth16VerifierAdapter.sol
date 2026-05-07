// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IVerifier} from "./PrivacyPool.sol";
import {Groth16Verifier} from "./Groth16VerifierGenerated.sol";

/// @dev Adapts snarkjs-exported `Groth16Verifier.verifyProof(A,B,C,pubSignals)` to
///      `PrivacyPool`'s `IVerifier.verifyProof(bytes, uint256[6])` layout.
///      Off-chain: `abi.encode([pA0,pA1], [[pB00,pB01],[pB10,pB11]], [pC0,pC1])`.
contract Groth16VerifierAdapter is IVerifier {
    Groth16Verifier public immutable groth16;

    constructor(Groth16Verifier _groth16) {
        groth16 = _groth16;
    }

    function verifyProof(
        bytes calldata proof,
        uint256[6] calldata publicInputs
    ) external view override returns (bool) {
        (uint[2] memory a, uint[2][2] memory b, uint[2] memory c) = abi.decode(
            proof,
            (uint[2], uint[2][2], uint[2])
        );
        return groth16.verifyProof(a, b, c, publicInputs);
    }
}
