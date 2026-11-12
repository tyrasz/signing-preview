import { encodeFunctionData, parseAbi } from 'viem';
import { onNode, locally, runData, create, assetParams, PROBE, FACTORY, blockNumber, type C } from './lib.ts';
const block = await blockNumber() - 2n;
const s = (b: string) => `0x${b.repeat(32)}` as `0x${string}`;
const LOG = '0x00000000000000000000000000000000000010aa';
const extra = { [LOG]: { code: '0x60aa5f5fa100' } };
const mint = encodeFunctionData({ abi: parseAbi(['function mint(address,uint256)']), functionName: 'mint', args: [PROBE, 1000n] });
const cs: C[] = [
  { to: LOG, data: '0x', gas: 50_000n, kind: 0 },
  { to: FACTORY, data: create(0, s('99'), assetParams('N', 'S', '0x2222222222222222222222222222222222222222'), [mint]), gas: 500_000n, kind: 0 },
  { to: LOG, data: '0x', gas: 50_000n, kind: 0 },
  { to: FACTORY, data: create(0, s('98'), assetParams(), [mint, '0xdeadbeef']), gas: 500_000n, kind: 0 },
  { to: LOG, data: '0x', gas: 50_000n, kind: 0 },
];
const txs = [{ to: PROBE, data: runData(cs), gas: 3_000_000n }];
const n = await onNode(txs, block, extra);
const [l] = await locally(txs, block, true, extra);
console.log('node logs', n[0].logs!.map(x => [x.address, x.topics[0].slice(0, 10)]));
console.log('local logs', l.logs!.map(x => [x.address, x.topics[0].slice(0, 10)]));
const strip = (c: any): any => ({ type: c.type, to: c.to, gasUsed: c.gasUsed, error: c.error, logs: c.logs?.map((x: any) => [x.index, x.address, x.topics[0].slice(0, 10)]), calls: c.calls?.map(strip) });
console.log(JSON.stringify(strip(l.trace), (k, v) => typeof v === 'bigint' ? v.toString() : v, 1));
console.log('gas', n[0].gasUsed, l.gasUsed);
