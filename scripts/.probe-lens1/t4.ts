import { encodeAbiParameters, encodeFunctionData, parseAbi, type Hex } from 'viem';
import { both, timed, timerOver, TIMER } from './h.ts';
const F = '0xb20f000000000000000000000000000000000000';
const abi = parseAbi(['function createB20(uint8 variant, bytes32 salt, bytes params, bytes[] initCalls) payable returns (address)']);
const salt = `0x${'51'.repeat(32)}` as Hex;
const assetParams = encodeAbiParameters([{ type: 'tuple', components: [{ name: 'version', type: 'uint8' }, { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }, { name: 'initialAdmin', type: 'address' }, { name: 'decimals', type: 'uint8' }] }], [{ version: 1, name: 'Probe', symbol: 'PRB', initialAdmin: '0x0000000000000000000000000000000000000000', decimals: 18 }]);
const cases: [string, Hex][] = [
  ['ok asset', encodeFunctionData({ abi, functionName: 'createB20', args: [0, salt, assetParams, []] })],
  ['variant 2', encodeFunctionData({ abi, functionName: 'createB20', args: [2, salt, assetParams, []] })],
  ['params 0x1234', encodeFunctionData({ abi, functionName: 'createB20', args: [0, salt, '0x1234', []] })],
  ['params empty', encodeFunctionData({ abi, functionName: 'createB20', args: [0, salt, '0x', []] })],
  ['params truncated', encodeFunctionData({ abi, functionName: 'createB20', args: [0, salt, assetParams.slice(0, 2 + 64 * 4) as Hex, []] })],
  ['params version word >255', encodeFunctionData({ abi, functionName: 'createB20', args: [0, salt, (assetParams.slice(0, 66) + 'ff' + assetParams.slice(68)) as Hex, []] })],
  ['stablecoin given asset params', encodeFunctionData({ abi, functionName: 'createB20', args: [1, salt, assetParams, []] })],
];
for (const [label, data] of cases) await both(label, [{ to: TIMER, data: timed(F, data) }], timerOver(), { untime: true });
