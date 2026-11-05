// npm run check:package: pack the library, install the tarball into a fresh project, and use it the way others
// will: plain JavaScript, TypeScript against the published declarations, and the `signing-preview` command.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'signing-preview-consumer-'));
const run = (cmd: string, args: string[], cwd = dir) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
try {
  run('npm', ['pack', '--pack-destination', dir], root);
  const tarball = readdirSync(dir).find(f => f.endsWith('.tgz'))!;
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  run('npm', ['install', '--no-audit', '--no-fund', `./${tarball}`, 'typescript@5.9.3', '@types/node@22.20.5']);

  writeFileSync(join(dir, 'app.mjs'), `
import { previewRequest, StaticTokenRegistry } from 'signing-preview';
import { openApiDocument } from 'signing-preview/server';
const data = '0xa9059cbb' + '000000000000000000000000b0b0000000000000000000000000000000000002' + (500_000_000n).toString(16).padStart(64, '0');
const p = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: '0xa11ce00000000000000000000000000000000001', to: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', data, chainId: '0xa4b1' }] }, {}, { tokens: new StaticTokenRegistry() });
if (p.title !== 'Send 500 USDC') throw new Error('unexpected title: ' + p.title);
if (openApiDocument().openapi !== '3.1.0') throw new Error('openapi.json not packaged');
const { ForkSimulator } = await import('signing-preview/fork');
if (!new ForkSimulator({ 999: 'http://localhost:1' }).covers(999)) throw new Error('signing-preview/fork does not cover HyperEVM');
console.log('JavaScript consumer:', p.title);
`);
  console.log(run('node', ['app.mjs']).trim());

  writeFileSync(join(dir, 'app.ts'), `
import { previewRequest, StaticTokenRegistry, type Preview, type Dependencies } from 'signing-preview';
import { withSigningPreview, remotePreview } from 'signing-preview/interceptor';
import { createPreviewServer, liveDependencies } from 'signing-preview/server';
import { ForkSimulator, type ForkSimulatorOptions } from 'signing-preview/fork';
const deps: Dependencies = { tokens: new StaticTokenRegistry() };
const p: Preview = await previewRequest({ method: 'personal_sign', params: ['0x68656c6c6f', '0xa11ce00000000000000000000000000000000001'] }, {}, deps);
const attention: 'none' | 'info' | 'caution' | 'danger' = p.attention;
const forkOptions: ForkSimulatorOptions = { timeoutMs: 5000 };
void withSigningPreview; void remotePreview; void createPreviewServer; void liveDependencies; void attention; void new ForkSimulator({}, forkOptions);
`);
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, types: ['node'] }, include: ['app.ts'] }));
  run('npx', ['tsc', '-p', '.']);
  console.log('TypeScript consumer: type-checks against the published declarations');

  const port = String(20_000 + Math.floor(Math.random() * 20_000));
  const cli = spawn('npx', ['signing-preview'], { cwd: dir, env: { ...process.env, PORT: port }, stdio: 'ignore' });
  try {
    let ok = false;
    for (let i = 0; i < 100 && !ok; i++) {
      try { ok = (await fetch(`http://127.0.0.1:${port}/v1/health`)).ok; } catch { await new Promise(r => setTimeout(r, 200)); }
    }
    if (!ok) throw new Error('the signing-preview command did not start');
    for (const path of ['/', '/dist/interceptor.js', '/v1/openapi.json']) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    }
    console.log('signing-preview command: serves the API, the OpenAPI document and the demo');
  } finally {
    cli.kill();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
