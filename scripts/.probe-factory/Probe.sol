// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Probe {
    // kind 0: call, 1: staticcall, 2: extcodesize, 3: extcodehash
    struct C { address to; bytes data; uint256 gas; uint8 kind; }
    function run(C[] calldata cs) public returns (bytes memory out) {
        for (uint i; i < cs.length; i++) {
            C calldata c = cs[i];
            bytes memory d = c.data;
            address to = c.to; uint256 gl = c.gas; uint8 k = c.kind;
            uint256 g0; uint256 g1; uint256 ok; uint256 s;
            if (k == 2) {
                assembly { g0 := gas() s := extcodesize(to) g1 := gas() }
                out = abi.encodePacked(out, abi.encode(true, g0 - g1, abi.encode(s)));
                continue;
            }
            if (k == 3) {
                assembly { g0 := gas() s := extcodehash(to) g1 := gas() }
                out = abi.encodePacked(out, abi.encode(true, g0 - g1, abi.encode(s)));
                continue;
            }
            if (k == 1) {
                assembly { g0 := gas() ok := staticcall(gl, to, add(d, 32), mload(d), 0, 0) g1 := gas() }
            } else {
                assembly { g0 := gas() ok := call(gl, to, 0, add(d, 32), mload(d), 0, 0) g1 := gas() }
            }
            bytes memory ret = new bytes(0);
            assembly { let n := returndatasize() ret := mload(0x40) mstore(ret, n) returndatacopy(add(ret, 32), 0, n) mstore(0x40, add(add(ret, 32), and(add(n, 31), not(31)))) }
            out = abi.encodePacked(out, abi.encode(ok == 1, g0 - g1, ret));
        }
    }
    function runThenRevert(C[] calldata cs) external { bytes memory out = run(cs); assembly { revert(add(out, 32), mload(out)) } }
}
