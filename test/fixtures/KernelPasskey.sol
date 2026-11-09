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
