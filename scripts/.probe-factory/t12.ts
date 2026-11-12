import { encodeFunctionData } from 'viem';
import { onNode, locally, show, runData, factoryAbi, PROBE, FACTORY, blockNumber, type C } from './lib.ts';
const block = await blockNumber() - 2n;
const cs: C[] = [
  { to: FACTORY, data: '0x', gas: 100_000n, kind: 0 },
  { to: FACTORY, data: '0x12', gas: 100_000n, kind: 0 },
  { to: FACTORY, data: '0x62975e', gas: 100_000n, kind: 0 },
  { to: FACTORY, data: encodeFunctionData({ abi: factoryAbi, functionName: 'isB20', args: [PROBE] }).slice(0, 20) as `0x${string}`, gas: 100_000n, kind: 0 },
  { to: FACTORY, data: `0xfa6e4e8c${'ff'.repeat(32)}`, gas: 100_000n, kind: 0 },
  { to: FACTORY, data: `${encodeFunctionData({ abi: factoryAbi, functionName: 'isB20Initialized', args: [PROBE] }).slice(0, 10)}${'ff'.repeat(32)}` as `0x${string}`, gas: 100_000n, kind: 0 },
  { to: FACTORY, data: `${encodeFunctionData({ abi: factoryAbi, functionName: 'getB20Address', args: [0, PROBE, `0x${'00'.repeat(32)}`] }).slice(0, 10)}${'00'.repeat(31)}05${'00'.repeat(64)}` as `0x${string}`, gas: 100_000n, kind: 0 },
];
const txs = [{ to: PROBE, data: runData(cs), gas: 3_000_000n }];
show('factory odd calldata', await onNode(txs, block), await locally(txs, block));
