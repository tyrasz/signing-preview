// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

// Compiled on its own, via IR as ZeroDev's validator is (its WebAuthn.sol needs it), for test/erc4337-sim.test.ts.
import {WebAuthn} from "zerodev/WebAuthn.sol";

struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }
/// ZeroDev Kernel v3.1 with ZeroDev's WebAuthn validator as its root validator, in one contract: it names that
/// validator as rootValidator() does, and validates operations as the validator does (its own WebAuthn.sol: the
/// assertion decoded from the signature, the challenge at clientDataJSON[23], user verification required). Tests
/// put its code at Kernel v3.1's address, behind Proxy1967.
contract KernelPasskey {
    address constant WEBAUTHN_VALIDATOR = 0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69;
    address public entryPoint;
    uint256 public x;
    uint256 public y;
    function init(address ep, uint256 px, uint256 py) external { require(entryPoint == address(0), "initialized"); entryPoint = ep; x = px; y = py; }
    function rootValidator() external pure returns (bytes21) { return bytes21(abi.encodePacked(bytes1(0x01), WEBAUTHN_VALIDATOR)); }
    function validateUserOp(PackedUserOperation calldata op, bytes32 hash, uint256 missing) external returns (uint256) {
        require(msg.sender == entryPoint, "entrypoint");
        if (missing > 0) { (bool paid, ) = payable(msg.sender).call{value: missing}(""); paid; }
        (bytes memory authenticatorData, string memory clientDataJSON, uint256 responseTypeLocation, uint256 r, uint256 s, bool usePrecompiled) =
            abi.decode(op.signature, (bytes, string, uint256, uint256, uint256, bool));
        return WebAuthn.verifySignature(abi.encodePacked(hash), authenticatorData, true, clientDataJSON, 23, responseTypeLocation, r, s, x, y, usePrecompiled) ? 0 : 1;
    }
    function execute(address to, uint256 value, bytes calldata data) external {
        require(msg.sender == entryPoint, "entrypoint");
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    }
    receive() external payable {}
}
/// An ERC-1967 proxy: its implementation in the standard slot, every call delegated to it.
contract Proxy1967 {
    constructor(address impl) { assembly { sstore(0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc, impl) } }
    fallback() external payable {
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), sload(0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc), 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }
}

/// OKX Wallet's smart account as it behaves on-chain (its source isn't published; src/erc4337-sim.ts, okxStubs):
/// keys kept by hash, each with a type (1 an Ethereum key, 2 a passkey) and settings (bit 200: admin) under its
/// storage root; a signature of the key's hash, validUntil and the key's proof over
/// keccak256(abi.encode(operation hash, validUntil, implementation)); a signature it doesn't accept answered with
/// 1 << 96; and executeUserOp reading the key's hash back from the signature, a non-admin key refused calls to the
/// account itself. Tests put its code at OKX's implementation address, behind Proxy1967.
contract OkxLike {
    struct Call { address to; uint256 value; bytes data; }
    struct WebAuthnAuth { bytes authenticatorData; string clientDataJSON; uint256 challengeIndex; uint256 typeIndex; uint256 r; uint256 s; }
    error NonAdminSelfCall();
    uint256 constant ROOT = 0x653ff6dcbda533c3c7d8ffb646da3e510d0de40f237170c4da3f874472aecb00;
    address constant IMPLEMENTATION = 0x36d3CBD83961868398d056EfBf50f5CE15528c0D;
    uint256 constant REFUSED = 1 << 96;
    address public entryPoint;
    bytes32[] keys;
    function init(address ep, bytes32[] calldata hashes, uint256[] calldata types, uint256[] calldata settings) external {
        require(entryPoint == address(0), "initialized");
        entryPoint = ep;
        for (uint256 i = 0; i < hashes.length; i++) _add(hashes[i], types[i], settings[i]);
    }
    struct Owner { bytes32 keyHash; address keyType; }
    /// As the factory calls it: each key an admin, with no expiry or hook.
    function initialize(Owner[] calldata owners) external {
        require(entryPoint == address(0), "initialized");
        entryPoint = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
        for (uint256 i = 0; i < owners.length; i++) _add(owners[i].keyHash, uint160(owners[i].keyType), 1 << 200);
    }
    function _slot(bytes32 key, uint256 n) private pure returns (bytes32) { return keccak256(abi.encode(key, ROOT + n)); }
    function _read(bytes32 key, uint256 n) private view returns (uint256 v) { bytes32 s = _slot(key, n); assembly { v := sload(s) } }
    function _add(bytes32 key, uint256 keyType, uint256 settings) private {
        bytes32 t = _slot(key, 1); bytes32 s = _slot(key, 2);
        assembly { sstore(t, keyType) sstore(s, settings) }
        keys.push(key);
    }
    function getOwnerKeys() external view returns (bytes32[] memory) { return keys; }
    function addOwner(bytes32 key, address keyType, uint256 settings) external { require(msg.sender == address(this), "self"); _add(key, uint160(keyType), settings); }
    function validateUserOp(PackedUserOperation calldata op, bytes32 hash, uint256 missing) external returns (uint256) {
        require(msg.sender == entryPoint, "entrypoint");
        if (missing > 0) { (bool paid, ) = payable(msg.sender).call{value: missing}(""); paid; }
        bytes calldata sig = op.signature;
        if (sig.length < 102) return REFUSED;
        bytes32 key = bytes32(sig[0:32]);
        uint256 until = uint48(bytes6(sig[32:38]));
        uint256 keyType = _read(key, 1);
        bytes32 digest = keccak256(abi.encode(hash, until, IMPLEMENTATION));
        if (keyType == 1) {
            if (sig.length != 103) return REFUSED;
            address signer = ecrecover(digest, uint8(sig[102]), bytes32(sig[38:70]), bytes32(sig[70:102]));
            if (keccak256(abi.encodePacked(signer)) != key) return REFUSED;
        } else if (keyType == 2) {
            if (keccak256(sig[38:102]) != key) return REFUSED;
            (WebAuthnAuth memory auth, bytes32[] memory proof) = abi.decode(sig[102:], (WebAuthnAuth, bytes32[]));
            for (uint256 i = 0; i < proof.length; i++) digest = digest < proof[i] ? keccak256(abi.encode(digest, proof[i])) : keccak256(abi.encode(proof[i], digest));
            if (!WebAuthn.verifySignature(abi.encodePacked(digest), auth.authenticatorData, true, auth.clientDataJSON, auth.challengeIndex, auth.typeIndex, auth.r, auth.s, uint256(bytes32(sig[38:70])), uint256(bytes32(sig[70:102])), true)) return REFUSED;
        } else return REFUSED;
        return until << 160;
    }
    function executeUserOp(PackedUserOperation calldata op, bytes32) external {
        require(msg.sender == entryPoint, "entrypoint");
        bool admin = _read(bytes32(op.signature[0:32]), 2) & (1 << 200) != 0;
        Call[] memory calls = abi.decode(op.callData[4:], (Call[]));
        for (uint256 i = 0; i < calls.length; i++) {
            if (calls[i].to == address(this) && !admin) revert NonAdminSelfCall();
            (bool ok, bytes memory ret) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
        }
    }
    receive() external payable {}
}

/// The proxy OKX's factory deploys: an ERC-1967 proxy of its implementation.
contract OkxProxy {
    constructor() { assembly { sstore(0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc, 0x36d3CBD83961868398d056EfBf50f5CE15528c0D) } }
    fallback() external payable {
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), sload(0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc), 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }
}
/// OKX's account factory, as its createAccount behaves: the account's address follows from its first keys and the
/// salt, and the account's initialize((bytes32,address)[]) registers them. Tests put its code at the factory's address.
contract OkxLikeFactory {
    function createAccount(OkxLike.Owner[] calldata owners, uint256 salt) external returns (address account) {
        account = address(new OkxProxy{salt: keccak256(abi.encode(owners, salt))}());
        OkxLike(payable(account)).initialize(owners);
    }
    function getAddress(OkxLike.Owner[] calldata owners, uint256 salt) external view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), keccak256(abi.encode(owners, salt)), keccak256(type(OkxProxy).creationCode))))));
    }
}
/// The EntryPoint's SenderCreator: it calls the factory an operation's initCode names with the rest of it.
contract SenderCreatorLike {
    function createSender(bytes calldata initCode) external returns (address sender) {
        (bool ok, bytes memory ret) = address(bytes20(initCode[0:20])).call(initCode[20:]);
        sender = ok && ret.length == 32 ? abi.decode(ret, (address)) : address(0);
    }
}
