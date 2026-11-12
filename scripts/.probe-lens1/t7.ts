import { local, node } from './h.ts';
const P = '0x8453000000000000000000000000000000000002', F = '0xb20f000000000000000000000000000000000000';
for (const [to, data] of [[P, '0x'], [P, '0xdeadbeef'], [P, '0x330f5637' + '00'.repeat(32)], [F, '0x']] as const) {
  const l = await local([{ to, data }], {}, true) as any[];
  const n = await node([{ to, data }]);
  console.log(to, data.slice(0, 10), 'local', l[0].status, l[0].gasUsed, JSON.stringify(l[0].trace, (_, v) => typeof v === 'bigint' ? v.toString() : v), 'node', JSON.stringify(n, (_, v) => typeof v === 'bigint' ? v.toString() : v));
}
