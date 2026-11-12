import { encodeFunctionData, parseAbi } from 'viem';
import { onNode, locally, show, runData, create, assetParams, stableParams, PROBE, FACTORY, blockNumber, type C } from './lib.ts';
const block = await blockNumber() - 2n;
const s = (b: string) => `0x${b.repeat(32)}` as `0x${string}`;
const mint = encodeFunctionData({ abi: parseAbi(['function mint(address,uint256)']), functionName: 'mint', args: [PROBE, 1000n] });
const A = '0x5555555555555555555555555555555555555555';
const cs: C[] = [];
let i = 0;
for (const [variant, params, init, base] of [[0, assetParams(), [], 131484n], [1, stableParams('n', 's', A), [mint], 0n]] as const) {
  if (!base) continue;
  for (const d of [-1n, 0n, 1n]) cs.push({ to: FACTORY, data: create(variant, s((0x30 + i++).toString(16)), params, [...init]), gas: base + d, kind: 0 });
}
const txs = [{ to: PROBE, data: runData(cs), gas: 3_000_000n }];
show('at the edge', await onNode(txs, block), await locally(txs, block));
