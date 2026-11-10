// node scripts/replay-tx-summary.ts <dir>
//
// One Markdown table across the transaction replays of a run (.github/workflows/replay-tx.yml): <dir> holds a folder
// per job, named replay-tx-<chain>, each with the report.json that npm run accuracy --out wrote. A row per chain and
// simulator, then the transactions whose preview differed from what happened.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chainName } from '../src/chains.ts';

type Sim = {
  error?: string; outcome: boolean; tokens: number; tokenTotal: number; native: boolean; approvals: number; approvalTotal: number;
  gas: boolean; gasPercent?: number; differs?: string[]; status: string; revert?: string; tokenDiffs: unknown[];
};
type Row = { hash: string; selector: string; receipt: string; l1Fee?: { percent?: number } } & Record<string, unknown>;

const dir = process.argv[2];
if (!dir) throw new Error('usage: node scripts/replay-tx-summary.ts <dir>');
const SIMULATORS: [string, string][] = [['eth_simulateV1', ''], ['fork', ' (fork simulator)']];
const frac = (n: number, d: number) => (d ? `${n}/${d}` : '–');
const lines = ['| Chain | Transactions | Outcome matches | Token movements matched | Native change matched | Approvals matched | Gas exact | Gas within 1% | L1 fee estimate within 5% | Differing | Errors |', '|---|---|---|---|---|---|---|---|---|---|---|'];
const differing: string[] = [], gasNotes: string[] = [];
let total = 0, wrongTotal = 0;
for (const name of readdirSync(dir).sort()) {
  const m = /^replay-tx-(\d+)$/.exec(name);
  const file = join(dir, name, 'report.json');
  if (!m || !existsSync(file)) continue;
  const chain = chainName(Number(m[1]));
  const rows = JSON.parse(readFileSync(file, 'utf8')) as Row[];
  total += rows.length;
  const l1 = rows.map(r => r.l1Fee?.percent).filter((x): x is number => x !== undefined);
  for (const [sim, label] of SIMULATORS) {
    const all = rows.map(r => r[sim] as Sim | undefined).filter((x): x is Sim => !!x);
    if (!all.length) continue;
    const ok = all.filter(r => !r.error);
    const sum = (k: 'tokens' | 'tokenTotal' | 'approvals' | 'approvalTotal') => ok.reduce((s, r) => s + r[k], 0);
    const wrong = rows.filter(r => (r[sim] as Sim | undefined)?.differs?.length);
    wrongTotal += wrong.length;
    lines.push(`| ${chain}${label} | ${all.length} | ${frac(ok.filter(r => r.outcome).length, ok.length)} | ${frac(sum('tokens'), sum('tokenTotal'))} | ${frac(ok.filter(r => r.native).length, ok.length)} | ${frac(sum('approvals'), sum('approvalTotal'))} | ${frac(ok.filter(r => r.gas).length, ok.length)} | ${frac(ok.filter(r => r.gas || (r.gasPercent !== undefined && Math.abs(r.gasPercent) < 1)).length, ok.length)} | ${sim === 'eth_simulateV1' && l1.length ? frac(l1.filter(x => Math.abs(x) < 5).length, l1.length) : '–'} | ${wrong.length || ''} | ${all.length - ok.length || ''} |`);
    for (const r of wrong) {
      const s = r[sim] as Sim;
      differing.push(`- ${chain}${label}: \`${r.hash}\` (${r.selector}): ${s.differs!.map(d => d === 'outcome' ? `outcome ${s.status}${s.revert ? ` (${String(s.revert).slice(0, 80)})` : ''}, the receipt ${r.receipt}` : d === 'gas' ? `gas ${s.gasPercent}%` : d === 'tokens' ? `tokens ${JSON.stringify(s.tokenDiffs)}` : d).join('; ')}`);
    }
    for (const r of rows) {
      const s = r[sim] as Sim | undefined;
      if (s && !s.error && !s.gas && !s.differs?.includes('gas') && s.gasPercent !== undefined) gasNotes.push(`- ${chain}${label}: \`${r.hash}\` (${r.selector}): gas ${s.gasPercent > 0 ? '+' : ''}${s.gasPercent}%`);
    }
  }
}
console.log(`## Transaction replays: ${total} transactions${wrongTotal ? `, ${wrongTotal} differing from their receipts` : ', none differing from their receipts'}\n`);
console.log(lines.join('\n'));
if (differing.length) console.log(`\n### Previews that differed from what happened\n\n${differing.join('\n')}`);
if (gasNotes.length) console.log(`\n### Gas off by less than 10% (reported, not failed)\n\n${gasNotes.slice(0, 40).join('\n')}${gasNotes.length > 40 ? `\n- … and ${gasNotes.length - 40} more` : ''}`);
