// node scripts/replay-summary.ts <dir>
//
// One Markdown table across the UserOperation replays of a run (.github/workflows/replay-4337.yml): <dir> holds a
// folder per job, named replay-<chain>-v<entrypoint>, each with the report.json that npm run accuracy:4337 --out
// wrote. A row per chain and EntryPoint version, then the operations whose preview differed from what happened.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chainName } from '../src/chains.ts';

type Row = {
  hash: string; kind: string; outcome: boolean; whole: boolean; standIn?: string; notSimulated?: boolean; prefix?: string;
  bundle?: { size: number; index: number }; gas?: { percent: number }; timeBumped?: boolean; tokens?: string; callsOnlyBecause?: string; tokenDiffs?: unknown;
  /** What the harness found the preview got wrong (see scripts/accuracy-4337.ts): 'outcome', 'gas', 'tokens'. */
  differs?: string[];
  /** An outcome the preview got wrong while warning it might (see scripts/accuracy-4337.ts). */
  warned?: string;
};

const dir = process.argv[2];
if (!dir) throw new Error('usage: node scripts/replay-summary.ts <dir>');
const CHAINS = new Proxy({} as Record<string, string>, { get: (_, id: string) => chainName(Number(id)) });
const pct = (n: number, d: number) => (d ? `${n}/${d}` : '–');
const lines = ['| Chain | EntryPoint | Operations | Outcome matches | Ran whole | Stand-in validated | Gas within 0.5% | Gas within 0.05% | Token movements matched | Differing | Skipped |', '|---|---|---|---|---|---|---|---|---|---|---|'];
const differing: string[] = [], fallbacks: string[] = [], warned: string[] = [];
const skips = new Map<string, number>();
let total = 0, wrongTotal = 0;
for (const name of readdirSync(dir).sort()) {
  const m = /^replay-(\d+)-v([\d.]+)$/.exec(name);
  const file = join(dir, name, 'report.json');
  if (!m || !existsSync(file)) continue;
  const rows = JSON.parse(readFileSync(file, 'utf8')) as Row[];
  // Why operations weren't replayed (report.skipped.json, beside the report), if it's there.
  const skippedFile = join(dir, name, 'report.skipped.json');
  const skipped = existsSync(skippedFile) ? JSON.parse(readFileSync(skippedFile, 'utf8')) as Record<string, number> : {};
  const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
  for (const [why, n] of Object.entries(skipped)) skips.set(why, (skips.get(why) ?? 0) + n);
  const judged = (r: Row) => r.whole && !r.prefix;
  // Gas is judged for operations alone in their bundle (see scripts/accuracy-4337.ts).
  // Not one run a second after its block (BNB Chain): what writes once a second costs more there.
  // Nor one whose account rejected the stand-in (its signature check didn't run).
  const gas = rows.filter(r => r.gas && !r.bundle && !r.timeBumped && r.standIn !== 'rejected' && judged(r));
  const tokens = rows.filter(r => r.tokens);
  const wrong = rows.filter(r => r.differs?.length);
  total += rows.length; wrongTotal += wrong.length;
  lines.push(`| ${CHAINS[m[1]] ?? m[1]} | v${m[2]} | ${rows.length} | ${pct(rows.filter(r => r.outcome).length, rows.length)} | ${pct(rows.filter(r => r.whole).length, rows.length)} | ${pct(rows.filter(r => r.standIn === 'validated').length, rows.filter(r => r.whole).length)} | ${pct(gas.filter(r => Math.abs(r.gas!.percent) < 0.5).length, gas.length)} | ${pct(gas.filter(r => Math.abs(r.gas!.percent) < 0.05).length, gas.length)} | ${pct(tokens.filter(r => r.tokens !== 'other').length, tokens.length)} | ${wrong.length || ''} | ${skippedTotal || ''} |`);
  for (const r of wrong) differing.push(`- ${CHAINS[m[1]] ?? m[1]} v${m[2]}: \`${r.hash}\`${r.bundle ? ` (operation ${r.bundle.index + 1} of ${r.bundle.size})` : ''}: ${r.differs!.map(d => d === 'outcome' ? 'outcome differs' : d === 'gas' ? `gas ${r.gas?.percent}%` : `tokens ${JSON.stringify(r.tokenDiffs)}`).join('; ')}`);
  for (const r of rows.filter(x => x.warned)) warned.push(`- ${CHAINS[m[1]] ?? m[1]} v${m[2]}: \`${r.hash}\`${r.warned !== 'outcome' ? `: ${r.warned}` : ''}`);
  for (const r of rows.filter(x => !x.whole && !x.notSimulated)) fallbacks.push(`- ${CHAINS[m[1]] ?? m[1]} v${m[2]}: \`${r.hash}\`: ${(r.callsOnlyBecause ?? '').slice(0, 160)}`);
}
console.log(`## UserOperation replays: ${total} operations${wrongTotal ? `, ${wrongTotal} differing from their receipts` : ', none differing from their receipts'}\n`);
console.log(lines.join('\n'));
if (differing.length) console.log(`\n### Previews that differed from what happened\n\n${differing.join('\n')}`);
if (warned.length) console.log(`\n### Outcomes that differed, reported not failed (an account reading its stand-in signature while running its calls, unless another reason is given)\n\n${warned.join('\n')}`);
if (skips.size) console.log(`\n### Not replayed\n\n${[...skips].sort((a, b) => b[1] - a[1]).map(([why, n]) => `- ${n}: ${why}`).join('\n')}`);
if (fallbacks.length) console.log(`\n### Operations whose calls were simulated alone (a signature shape the stand-in doesn't take, or a paymaster refusing)\n\n${fallbacks.slice(0, 40).join('\n')}${fallbacks.length > 40 ? `\n- … and ${fallbacks.length - 40} more` : ''}`);
