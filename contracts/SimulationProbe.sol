// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title SimulationProbe
/// @notice Simulates transactions on RPCs that offer eth_call with state overrides but no eth_simulateV1 or
/// tracing (HyperEVM's public RPC). The eth_call sets this as the code of the account that would send the
/// transactions and calls run() on that account. run() makes each call from the account itself, so the target sees
/// the real sender as msg.sender (and tx.origin), and reads the given view calls before the first call and after
/// each one, so the caller can diff balances, allowances and NFT ownership. Logs can't be read inside the EVM; the
/// reads are what replaces them. This contract is never deployed.
contract SimulationProbe {
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    struct Read {
        address to;
        bytes data;
    }

    struct Outcome {
        bool ok;
        uint256 gasUsed;
        bytes ret;
    }

    /// @return outcomes one per call: success, gas used by the call itself, return or revert data (first 1,024 bytes)
    /// @return native the account's native balance before the first call and after each call
    /// @return snapshots each read's result (first 96 bytes; empty if it failed) at the same points
    function run(Call[] calldata calls, Read[] calldata reads)
        external
        returns (Outcome[] memory outcomes, uint256[] memory native, bytes[][] memory snapshots)
    {
        require(msg.sender == address(this), "probe: not the account");
        outcomes = new Outcome[](calls.length);
        native = new uint256[](calls.length + 1);
        snapshots = new bytes[][](calls.length + 1);
        native[0] = address(this).balance;
        snapshots[0] = _read(reads);
        for (uint256 i; i < calls.length; i++) {
            uint256 g = gasleft();
            (bool ok, bytes memory ret) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            uint256 used = g - gasleft();
            if (ret.length > 1024) assembly { mstore(ret, 1024) }
            outcomes[i] = Outcome(ok, used, ret);
            native[i + 1] = address(this).balance;
            snapshots[i + 1] = _read(reads);
        }
    }

    function _read(Read[] calldata reads) private view returns (bytes[] memory out) {
        out = new bytes[](reads.length);
        for (uint256 j; j < reads.length; j++) {
            // A gas cap per read, so one hostile "token" can't use up the simulation.
            (bool ok, bytes memory r) = reads[j].to.staticcall{gas: 100_000}(reads[j].data);
            if (!ok) continue;
            if (r.length > 96) assembly { mstore(r, 96) }
            out[j] = r;
        }
    }

    /// ERC-1271, answered as the account's own key would: only a signature by the account itself is valid. (Code at
    /// the account makes contracts such as Permit2 ask the account instead of using ecrecover.)
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        if (signature.length == 65) {
            r = bytes32(signature[0:32]);
            s = bytes32(signature[32:64]);
            v = uint8(signature[64]);
        } else if (signature.length == 64) {
            // EIP-2098 compact signature: the top bit of vs is the parity.
            r = bytes32(signature[0:32]);
            bytes32 vs = bytes32(signature[32:64]);
            s = vs & bytes32(0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff);
            v = uint8(uint256(vs) >> 255) + 27;
        } else {
            return 0xffffffff;
        }
        if (v < 27) v += 27;
        address signer = ecrecover(hash, v, r, s);
        return signer != address(0) && signer == address(this) ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    // An account without code accepts any NFT; with code, safe transfers ask it first. These say yes, as it would.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x150b7a02;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xf23a6e61;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return 0xbc197c81;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x150b7a02 || id == 0x4e2312e0;
    }

    // Anything else behaves like an account without code: it succeeds and returns nothing.
    fallback() external payable {}

    receive() external payable {}
}
