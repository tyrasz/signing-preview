import { encodeFunctionData } from 'viem';
import { onNode, locally, show, runData, create, assetParams, factoryAbi, PROBE, FACTORY, blockNumber, type C } from './lib.ts';
const block = await blockNumber() - 2n;
const s = (b: string) => `0x${b.repeat(32)}` as `0x${string}`;
const DEL = '0x00000000000000000000000000000000000de1e9';
const delegator = `0x365f5f375f5f365f73${FACTORY.slice(2)}5af43d5f5f3e6029573d5ffd5b3d5ff3`;
const extra = { [DEL]: { code: delegator } };
const cs: C[] = [
  { to: DEL, data: create(0, s('f5'), assetParams()), gas: 500_000n, kind: 0 },
  { to: DEL, data: encodeFunctionData({ abi: factoryAbi, functionName: 'isB20', args: [PROBE] }), gas: 500_000n, kind: 0 },
  { to: FACTORY, data: create(0, s('f7'), assetParams()), gas: 500_000n, kind: 1 },
  { to: FACTORY, data: encodeFunctionData({ abi: factoryAbi, functionName: 'isB20', args: [PROBE] }), gas: 500_000n, kind: 1 },
];
const txs = [{ to: PROBE, data: runData(cs), gas: 3_000_000n }];
show('delegatecall/static via probe', await onNode(txs, block, extra), await locally(txs, block, false, extra));
