import { keccak256, encodeAbiParameters } from 'viem';
import { onNode, locally, show, runData, create, assetParams, stableParams, PROBE, FACTORY, blockNumber, URL_, type C } from './lib.ts';
const block = await blockNumber() - 2n;
const s = (b: string) => `0x${b.repeat(32)}` as `0x${string}`;
const REG = '0x8453000000000000000000000000000000000001';
const slot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], ['0xcdcc772fe4cbdb1029f822861176d09e646db96723d4c1e82ddfdeb8163ef54c', 0x43ee1bbe25e988521cccd8b2c8fbd38c8287ebff8e074e825a70dfd3885cce00n]));
const r = await (await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getStorageAt', params: [REG, slot, 'latest'] }) })).json();
console.log('asset feature slot', slot, r.result);
const extra = { [REG]: { stateDiff: { [slot]: `0x${'00'.repeat(32)}` } } };
const cs: C[] = [
  { to: FACTORY, data: create(0, s('61'), assetParams()), gas: 500_000n, kind: 0 },
  { to: FACTORY, data: create(0, s('62'), assetParams('n', 's', undefined, 18, 2)), gas: 500_000n, kind: 0 },
  { to: FACTORY, data: create(0, s('63'), '0x1234'), gas: 500_000n, kind: 0 },
  { to: FACTORY, data: create(1, s('64'), stableParams()), gas: 500_000n, kind: 0 },
];
const txs = [{ to: PROBE, data: runData(cs), gas: 3_000_000n }];
show('asset feature off', await onNode(txs, block, extra), await locally(txs, block, false, extra));
