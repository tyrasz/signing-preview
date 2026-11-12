import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const solc = createRequire(import.meta.url)('solc') as { compile(input: string): string };
const src = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Timer {
  // kind 0 call, 1 staticcall, 2 delegatecall, 3 callcode(asm), 4 extcode reads
  fallback(bytes calldata input) external payable returns (bytes memory) {
    (address to, uint256 value, uint256 gasGiven, uint8 kind, bytes memory data) = abi.decode(input, (address, uint256, uint256, uint8, bytes));
    uint256 g0; bool ok; bytes memory ret; uint256 used;
    if (kind == 4) {
      uint256 size; bytes32 h;
      g0 = gasleft();
      assembly { size := extcodesize(to) }
      used = g0 - gasleft();
      g0 = gasleft();
      assembly { h := extcodehash(to) }
      uint256 used2 = g0 - gasleft();
      return abi.encode(size, h, used, used2, to.code);
    }
    g0 = gasleft();
    if (kind == 0) (ok, ret) = to.call{value: value, gas: gasGiven}(data);
    else if (kind == 1) (ok, ret) = to.staticcall{gas: gasGiven}(data);
    else if (kind == 2) (ok, ret) = to.delegatecall{gas: gasGiven}(data);
    else if (kind == 3) {
      assembly {
        ok := callcode(gasGiven, to, value, add(data, 32), mload(data), 0, 0)
        let n := returndatasize()
        ret := mload(0x40)
        mstore(ret, n)
        returndatacopy(add(ret, 32), 0, n)
        mstore(0x40, add(add(ret, 32), and(add(n, 31), not(31))))
      }
    }
    used = g0 - gasleft();
    return abi.encode(ok, used, ret);
  }
}`;
const input = { language: 'Solidity', sources: { 'T.sol': { content: src } }, settings: { optimizer: { enabled: false }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['evm.deployedBytecode.object'] } } } };
const out = JSON.parse(solc.compile(JSON.stringify(input)));
if (out.errors?.some((e: any) => e.severity === 'error')) { console.error(out.errors); process.exit(1); }
writeFileSync(new URL('./timer.hex', import.meta.url), '0x' + out.contracts['T.sol'].Timer.evm.deployedBytecode.object);
console.log('ok');
