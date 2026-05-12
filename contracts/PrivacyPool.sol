// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControl}   from "@openzeppelin/contracts/access/AccessControl.sol";
import {Ownable}         from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable}        from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EnumerableSet}   from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IERC20}          from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20}       from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IVerifier {
    function verifyProof(
        bytes calldata proof,
        uint256[6] calldata publicInputs
    ) external view returns (bool);
}

interface IIncrementalMerkleTree {
    function insert(bytes32 leaf) external returns (uint32 leafIndex);
    function isKnownRoot(bytes32 root) external view returns (bool);
    function currentRoot() external view returns (bytes32);
}

interface ISanctionsList {
    function isSanctioned(address addr) external view returns (bool);
}

/// @notice Dual-asset privacy pool: native ETH and ERC20 USDT with separate Merkle trees.
contract TelegramPrivacyPool is AccessControl, Pausable, ReentrancyGuard, Ownable {
    using EnumerableSet for EnumerableSet.AddressSet;
    using SafeERC20 for IERC20;

    bytes32 public constant ASP_ROLE        = keccak256("ASP_ROLE");
    bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");
    bytes32 public constant PAUSER_ROLE     = keccak256("PAUSER_ROLE");

    uint256 public constant ETH_DENOMINATION = 0.01 ether;
    uint256 public constant PROTOCOL_WITHDRAW_FEE_ETH = 0.001 ether;
    uint256 public constant USDT_DENOMINATION = 100 * 1e6;
    /// @notice 0.1 USDT (6 decimals) — aligns with 0.1% competitive framing on 100 USDT notes.
    uint256 public constant PROTOCOL_WITHDRAW_FEE_USDT = 100_000;
    uint32  public constant ASP_ROOT_HISTORY = 64;

    IVerifier              public immutable verifier;
    IIncrementalMerkleTree public immutable ethStateTree;
    IIncrementalMerkleTree public immutable usdtStateTree;
    IERC20                 public immutable usdt;
    ISanctionsList         public immutable sanctionsOracle;

    mapping(bytes32 => bool) public ethCommitments;
    mapping(bytes32 => bool) public usdtCommitments;
    mapping(bytes32 => bool) public ethNullifierHashes;
    mapping(bytes32 => bool) public usdtNullifierHashes;

    bytes32[ASP_ROOT_HISTORY] public aspRoots;
    uint32 public aspRootIndex;
    mapping(bytes32 => bool) public knownAspRoot;

    EnumerableSet.AddressSet private _localSanctioned;

    uint256 public accumulatedProtocolFeesEth;
    uint256 public accumulatedProtocolFeesUsdt;

    event DepositEth(
        bytes32 indexed commitment,
        uint32 leafIndex,
        uint256 timestamp
    );
    event DepositUsdt(
        bytes32 indexed commitment,
        uint32 leafIndex,
        uint256 timestamp
    );
    event WithdrawalEth(
        address indexed to,
        bytes32 indexed nullifierHash,
        address indexed relayer,
        uint256 relayerFee,
        uint256 protocolFee
    );
    event WithdrawalUsdt(
        address indexed to,
        bytes32 indexed nullifierHash,
        address indexed relayer,
        uint256 relayerFee,
        uint256 protocolFee
    );
    event AspRootUpdated(bytes32 indexed root, uint32 index, address indexed asp);
    event SanctionedAddressAdded(address indexed account);
    event SanctionedAddressRemoved(address indexed account);
    event ProtocolFeesWithdrawn(address indexed to, uint256 amountEth, uint256 amountUsdt);

    error InvalidProof();
    error CommitmentAlreadyExists();
    error NullifierAlreadyUsed();
    error UnknownStateRoot();
    error UnknownAspRoot();
    error SenderSanctioned(address account);
    error RecipientSanctioned(address account);
    error RelayerSanctioned(address account);
    error WrongEthDepositAmount();
    error FeeExceedsDenomination();
    error EthTransferFailed();
    error ZeroAddress();
    error ZeroRoot();

    constructor(
        IVerifier              _verifier,
        IIncrementalMerkleTree _ethStateTree,
        IIncrementalMerkleTree _usdtStateTree,
        IERC20                 _usdt,
        ISanctionsList         _sanctionsOracle,
        address                admin
    ) Ownable(admin) {
        if (address(_verifier)      == address(0)) revert ZeroAddress();
        if (address(_ethStateTree)  == address(0)) revert ZeroAddress();
        if (address(_usdtStateTree) == address(0)) revert ZeroAddress();
        if (address(_usdt)          == address(0)) revert ZeroAddress();
        if (admin                   == address(0)) revert ZeroAddress();

        verifier        = _verifier;
        ethStateTree    = _ethStateTree;
        usdtStateTree   = _usdtStateTree;
        usdt            = _usdt;
        sanctionsOracle = _sanctionsOracle;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(COMPLIANCE_ROLE,    admin);
        _grantRole(PAUSER_ROLE,        admin);
    }

    function isSanctioned(address account) public view returns (bool) {
        if (account == address(0)) return false;
        if (_localSanctioned.contains(account)) return true;
        if (address(sanctionsOracle) == address(0)) return false;
        try sanctionsOracle.isSanctioned(account) returns (bool s) {
            return s;
        } catch {
            return true;
        }
    }

    function addSanctioned(address account) external onlyRole(COMPLIANCE_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        if (_localSanctioned.add(account)) {
            emit SanctionedAddressAdded(account);
        }
    }

    function removeSanctioned(address account) external onlyRole(COMPLIANCE_ROLE) {
        if (_localSanctioned.remove(account)) {
            emit SanctionedAddressRemoved(account);
        }
    }

    function localSanctionedLength() external view returns (uint256) {
        return _localSanctioned.length();
    }

    function localSanctionedAt(uint256 i) external view returns (address) {
        return _localSanctioned.at(i);
    }

    function publishAspRoot(bytes32 newRoot) external onlyRole(ASP_ROLE) {
        if (newRoot == bytes32(0)) revert ZeroRoot();

        uint32 next = (aspRootIndex + 1) % ASP_ROOT_HISTORY;

        bytes32 evicted = aspRoots[next];
        if (evicted != bytes32(0)) {
            knownAspRoot[evicted] = false;
        }

        aspRoots[next]        = newRoot;
        knownAspRoot[newRoot] = true;
        aspRootIndex          = next;

        emit AspRootUpdated(newRoot, next, msg.sender);
    }

    function isKnownAspRoot(bytes32 root) public view returns (bool) {
        return knownAspRoot[root];
    }

    function pause()   external onlyRole(PAUSER_ROLE) { _pause();   }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    function depositAmountRequired() external pure returns (uint256) {
        return ETH_DENOMINATION;
    }

    function usdtDepositAmountRequired() external pure returns (uint256) {
        return USDT_DENOMINATION;
    }

    function withdrawFees() external onlyOwner nonReentrant {
        uint256 e = accumulatedProtocolFeesEth;
        uint256 u = accumulatedProtocolFeesUsdt;
        if (e == 0 && u == 0) return;
        accumulatedProtocolFeesEth   = 0;
        accumulatedProtocolFeesUsdt  = 0;
        address payable o = payable(owner());
        if (e > 0) {
            (bool ok, ) = o.call{value: e}("");
            if (!ok) revert EthTransferFailed();
        }
        if (u > 0) {
            usdt.safeTransfer(o, u);
        }
        emit ProtocolFeesWithdrawn(o, e, u);
    }

    function deposit(bytes32 commitment)
        external
        payable
        whenNotPaused
        nonReentrant
    {
        if (msg.value != ETH_DENOMINATION) revert WrongEthDepositAmount();
        if (ethCommitments[commitment]) revert CommitmentAlreadyExists();
        if (isSanctioned(msg.sender))  revert SenderSanctioned(msg.sender);

        ethCommitments[commitment] = true;
        uint32 leafIndex = ethStateTree.insert(commitment);

        emit DepositEth(commitment, leafIndex, block.timestamp);
    }

    function depositUsdt(bytes32 commitment) external whenNotPaused nonReentrant {
        if (usdtCommitments[commitment]) revert CommitmentAlreadyExists();
        if (isSanctioned(msg.sender)) revert SenderSanctioned(msg.sender);

        usdt.safeTransferFrom(msg.sender, address(this), USDT_DENOMINATION);
        usdtCommitments[commitment] = true;
        uint32 leafIndex = usdtStateTree.insert(commitment);

        emit DepositUsdt(commitment, leafIndex, block.timestamp);
    }

    function withdraw(
        bytes  calldata   proof,
        bytes32           stateRoot,
        bytes32           aspRoot,
        bytes32           nullifierHash,
        address payable   recipient,
        address payable   relayer,
        uint256           fee
    ) external whenNotPaused nonReentrant {
        if (ethNullifierHashes[nullifierHash]) revert NullifierAlreadyUsed();
        uint256 proto = PROTOCOL_WITHDRAW_FEE_ETH;
        if (fee + proto > ETH_DENOMINATION) revert FeeExceedsDenomination();
        if (recipient == address(0)) revert ZeroAddress();
        if (!ethStateTree.isKnownRoot(stateRoot)) revert UnknownStateRoot();
        if (!isKnownAspRoot(aspRoot)) revert UnknownAspRoot();
        if (isSanctioned(recipient)) revert RecipientSanctioned(recipient);
        if (relayer != address(0) && isSanctioned(relayer)) {
            revert RelayerSanctioned(relayer);
        }

        uint256[6] memory publicInputs;
        publicInputs[0] = uint256(stateRoot);
        publicInputs[1] = uint256(aspRoot);
        publicInputs[2] = uint256(nullifierHash);
        publicInputs[3] = uint256(uint160(address(recipient)));
        publicInputs[4] = uint256(uint160(address(relayer)));
        publicInputs[5] = fee;

        if (!verifier.verifyProof(proof, publicInputs)) revert InvalidProof();

        ethNullifierHashes[nullifierHash] = true;
        unchecked {
            accumulatedProtocolFeesEth += proto;
        }

        uint256 toRecipient = ETH_DENOMINATION - fee - proto;
        if (fee > 0 && relayer != address(0)) {
            _safeTransferEth(relayer, fee);
        }
        _safeTransferEth(recipient, toRecipient);

        emit WithdrawalEth(recipient, nullifierHash, relayer, fee, proto);
    }

    function withdrawUsdt(
        bytes  calldata   proof,
        bytes32           stateRoot,
        bytes32           aspRoot,
        bytes32           nullifierHash,
        address           recipient,
        address           relayer,
        uint256           fee
    ) external whenNotPaused nonReentrant {
        if (usdtNullifierHashes[nullifierHash]) revert NullifierAlreadyUsed();
        uint256 proto = PROTOCOL_WITHDRAW_FEE_USDT;
        if (fee + proto > USDT_DENOMINATION) revert FeeExceedsDenomination();
        if (recipient == address(0)) revert ZeroAddress();
        if (!usdtStateTree.isKnownRoot(stateRoot)) revert UnknownStateRoot();
        if (!isKnownAspRoot(aspRoot)) revert UnknownAspRoot();
        if (isSanctioned(recipient)) revert RecipientSanctioned(recipient);
        if (relayer != address(0) && isSanctioned(relayer)) {
            revert RelayerSanctioned(relayer);
        }

        uint256[6] memory publicInputs;
        publicInputs[0] = uint256(stateRoot);
        publicInputs[1] = uint256(aspRoot);
        publicInputs[2] = uint256(nullifierHash);
        publicInputs[3] = uint256(uint160(recipient));
        publicInputs[4] = uint256(uint160(relayer));
        publicInputs[5] = fee;

        if (!verifier.verifyProof(proof, publicInputs)) revert InvalidProof();

        usdtNullifierHashes[nullifierHash] = true;
        unchecked {
            accumulatedProtocolFeesUsdt += proto;
        }

        uint256 toRecipient = USDT_DENOMINATION - fee - proto;
        if (fee > 0 && relayer != address(0)) {
            usdt.safeTransfer(relayer, fee);
        }
        usdt.safeTransfer(recipient, toRecipient);

        emit WithdrawalUsdt(recipient, nullifierHash, relayer, fee, proto);
    }

    function _safeTransferEth(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }

    receive()  external payable { revert("PrivacyPool: use deposit"); }
    fallback() external payable { revert("PrivacyPool: use deposit"); }
}
