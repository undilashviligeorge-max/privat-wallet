// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/* ────────────────────────────────────────────────────────────────────────── *
 *  TESTNET-ONLY mock implementations.                                        *
 *                                                                            *
 *  These exist solely to satisfy TelegramPrivacyPool's constructor on        *
 *  Sepolia while the real Verifier (snarkjs Groth16) and incremental         *
 *  Merkle tree (Tornado MerkleTreeWithHistory / Semaphore                    *
 *  IncrementalBinaryTree) are still being prepared.                          *
 *                                                                            *
 *  DO NOT DEPLOY THESE TO MAINNET. The MockVerifier accepts every            *
 *  proof; the MockIncrementalMerkleTree does not actually compute            *
 *  Merkle roots. Both are placeholders.                                      *
 * ────────────────────────────────────────────────────────────────────────── */

import {IVerifier, IIncrementalMerkleTree} from "./PrivacyPool.sol";

/// @notice Always-pass verifier. Replace with a snarkjs-generated
///         `Verifier.sol` before any production use.
contract MockVerifier is IVerifier {
    function verifyProof(
        bytes calldata /*proof*/,
        uint256[6] calldata /*publicInputs*/
    ) external pure override returns (bool) {
        return true;
    }
}

/// @notice Append-only counter that pretends to be an incremental Merkle
///         tree. `currentRoot` is just `keccak(nextIndex)` and any root
///         is "known". Replace with Tornado MerkleTreeWithHistory or
///         Semaphore IncrementalBinaryTree before any production use.
contract MockIncrementalMerkleTree is IIncrementalMerkleTree {
    uint32 public nextIndex;

    function insert(bytes32 /*leaf*/) external override returns (uint32) {
        uint32 idx = nextIndex;
        nextIndex = idx + 1;
        return idx;
    }

    function isKnownRoot(bytes32 /*root*/) external pure override returns (bool) {
        return true;
    }

    function currentRoot() external view override returns (bytes32) {
        return keccak256(abi.encodePacked(nextIndex));
    }
}
