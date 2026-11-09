// Compiles the simulation code put in place of each EntryPoint's code (src/erc4337-sim.ts) and writes
// src/entrypoint-simulations.ts:
//
//   npm run build:entrypoints              (writes the file)
//   npm run build:entrypoints -- --check   (compiles, and fails if the committed file differs)
//
// Its sources aren't in this repository, nor are the compilers the EntryPoints were built with: the script fetches
// them, pinned. The packages come from the npm registry, each checked against its published sha512 integrity:
// @account-abstraction/contracts 0.6.0, 0.7.0, 0.8.0 and 0.9.0-rc.1, @openzeppelin/contracts 4.9.6, 5.0.2 and 5.1.0,
// and solc 0.8.17, 0.8.23 and 0.8.28 (its soljson.js, run directly). EntryPoint v0.9's verified sources come from
// Sourcify, checked against a hash of them. They are kept in a cache folder (--cache <dir>, by default one in the
// system's temporary directory) and fetched again only if missing or changed.
//
// Each is compiled with the compiler and settings that reproduce its deployed EntryPoint byte for byte (checked
// against the code on Ethereum: EntryPoint.sol compiled this way is identical, immutables and metadata aside), so
// the simulated operation uses the gas the real one will. v0.9 was released after its last published package
// (0.9.0-rc.1, whose EntryPoint differs from the deployed one): its EntryPoint sources and settings are the deployed
// contract's own, verified on Sourcify (an exact match), and rc.1's EntryPointSimulations is compiled on top of them
// (its interface is unchanged).
//
// v0.7 and v0.8: eth-infinitism's EntryPointSimulations, which keeps the EntryPoint's storage and SenderCreator and
// whose simulateHandleOp returns its result. Its depositTo, which wastes a little gas on purpose (bundlers want
// simulation to cost no less than the chain), is plain here: an account paying its prefund pays what it will. Its
// simulation-only check that the paymaster has code skips a zero paymaster, which the EntryPoint takes as none
// (all versions; that check runs outside the operation's gas).
// v0.6 has no EntryPointSimulations: its own simulateHandleOp always reverts, which discards the operation's logs.
// It is compiled from EntryPoint.sol with two changes of its own: simulateHandleOp returns its result (the account's
// and the paymaster's validation data whole, in v0.7's ExecutionResult order) instead of reverting, and the
// SenderCreator, an immutable the override can't set, is the deployed one as a constant (and, as above, a zero
// paymaster is none). Storage is unchanged.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { getAddress } from 'viem';

const root = new URL('..', import.meta.url).pathname;
/** The deployed EntryPoints' settings: all via IR at 1,000,000 runs; v0.6 with 0.8.17's default EVM (london). */
const SETTINGS = {
  '0.6': { viaIR: true, optimizer: { enabled: true, runs: 1_000_000 } },
  '0.7': { viaIR: true, optimizer: { enabled: true, runs: 1_000_000 }, evmVersion: 'paris' },
  '0.8': { viaIR: true, optimizer: { enabled: true, runs: 1_000_000 }, evmVersion: 'cancun' },
} as const;

/** The npm packages compiled from (and the compilers), with the registry's sha512 integrity for each. */
const PACKAGES = {
  aa06: ['@account-abstraction/contracts', '0.6.0', 'sha512-8ooRJuR7XzohMDM4MV34I12Ci2bmxfE9+cixakRL7lA4BAwJKQ3ahvd8FbJa9kiwkUPCUNtj+/zxDQWYYalLMQ=='],
  aa07: ['@account-abstraction/contracts', '0.7.0', 'sha512-Bt/66ilu3u8I9+vFZ9fTd+cWs55fdb9J5YKfrhsrFafH1drkzwuCSL/xEot1GGyXXNJLQuXbMRztQPyelNbY1A=='],
  aa08: ['@account-abstraction/contracts', '0.8.0', 'sha512-8krPx/gpnoT+5xAroagVCbeA7FbUigMZWXFKKPm+oghyr29Dksssdx5sI7xGv9212i4JPaDDUGFk58dpuwVgHA=='],
  aa09: ['@account-abstraction/contracts', '0.9.0-rc.1', 'sha512-NEii5cuCEJaQ0ZUPAh6JtP/yuozLX4k9BJVu7ytX0QAjc4cT038H0fN0lAO129ou/Uwabj5xY9X+z06ChM3p7A=='],
  oz49: ['@openzeppelin/contracts', '4.9.6', 'sha512-xSmezSupL+y9VkHZJGDoCBpmnB2ogM13ccaYDWqJTfS3dbuHkgjuwDFUmaFauBCboQMGB/S5UqUl2y54X99BmA=='],
  oz50: ['@openzeppelin/contracts', '5.0.2', 'sha512-ytPc6eLGcHHnapAZ9S+5qsdomhjo6QBHTDRRBFfTxXIpsicMhVPouPgmUPebZZZGX7vt9USA+Z+0M0dSVtSUEA=='],
  oz51: ['@openzeppelin/contracts', '5.1.0', 'sha512-p1ULhl7BXzjjbha5aqst+QMLY+4/LCWADXOCsmLHRM77AqiPjnd9vvUN9sosUfhL9JGKpZ0TjEGxgvnizmWGSA=='],
  solc17: ['solc', '0.8.17', 'sha512-Dtidk2XtTTmkB3IKdyeg6wLYopJnBVxdoykN8oP8VY3PQjN16BScYoUJTXFm2OP7P0hXNAqWiJNmmfuELtLf8g=='],
  solc23: ['solc', '0.8.23', 'sha512-uqe69kFWfJc3cKdxj+Eg9CdW1CP3PLZDPeyJStQVWL8Q9jjjKD0VuRAKBFR8mrWiq5A7gJqERxJFYJsklrVsfA=='],
  solc28: ['solc', '0.8.28', 'sha512-AFCiJ+b4RosyyNhnfdVH4ZR1+TxiL91iluPjw0EJslIu4LXGM9NYqi2z5y8TqochC4tcH9QsHfwWhOIC9jPDKA=='],
} as const;
/** EntryPoint v0.9's verified sources on Sourcify, and a sha256 over them (each path and content, in path order). */
const EP09_SOURCIFY = 'https://sourcify.dev/server/v2/contract/1/0x433709009B8330FDa32311DF1C2AFA402eD8D009?fields=sources,compilation';
const EP09_SOURCES_SHA256 = '7760bb06e73593056c95af78dee2a8da463efc1e26d7aa625f66c47e5ffcf52b';

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The package unpacked in the cache (its package/ folder), fetched from the npm registry if it isn't there yet. */
async function npmPackage(cache: string, [name, version, integrity]: readonly [string, string, string]): Promise<string> {
  const dir = join(cache, `${name.replace('/', '+')}@${version}`);
  const tarball = `${dir}.tgz`;
  const intact = (b: Buffer) => `sha512-${createHash('sha512').update(b).digest('base64')}` === integrity;
  if (existsSync(join(dir, 'package', 'package.json')) && existsSync(tarball) && intact(readFileSync(tarball))) return join(dir, 'package');
  const bytes = await download(`https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`);
  if (!intact(bytes)) throw new Error(`${name}@${version}: the tarball doesn't match its pinned integrity`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(tarball, bytes);
  execFileSync('tar', ['-xzf', tarball, '-C', dir]);
  return join(dir, 'package');
}

type Verified = { sources: Record<string, { content: string }>; compilation: { compilerVersion: string; compilerSettings: Record<string, unknown> } };
/** EntryPoint v0.9's verified sources and settings, checked against the pinned hash. */
async function sourcify(cache: string): Promise<Verified> {
  const file = join(cache, 'entrypoint-v0.9-sourcify.json');
  const check = (v: Verified) => {
    const h = createHash('sha256');
    for (const k of Object.keys(v.sources).sort()) h.update(`${k}\0${v.sources[k].content}\0`);
    return h.digest('hex') === EP09_SOURCES_SHA256;
  };
  if (existsSync(file)) { const v = JSON.parse(readFileSync(file, 'utf8')) as Verified; if (check(v)) return v; }
  const v = JSON.parse((await download(EP09_SOURCIFY)).toString('utf8')) as Verified;
  if (!check(v)) throw new Error("EntryPoint v0.9's sources from Sourcify don't match their pinned hash");
  writeFileSync(file, JSON.stringify(v));
  return v;
}

/** A compiler from the solc package's soljson.js, without the package's own JavaScript (or its dependencies). */
function solcFrom(dir: string): { compile(input: string): string; version(): string } {
  const soljson = createRequire(import.meta.url)(join(dir, 'soljson.js'));
  const compile = soljson.cwrap('solidity_compile', 'string', ['string', 'number', 'number']);
  return { compile: (input: string) => compile(input, 0, 0), version: soljson.cwrap('solidity_version', 'string', []) };
}

function sources(dir: string, prefix: string): Record<string, { content: string }> {
  const out: Record<string, { content: string }> = {};
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f.endsWith('.sol')) out[`${prefix}${relative(dir, p)}`] = { content: readFileSync(p, 'utf8') }; } };
  walk(dir);
  return out;
}

const V06_SENDER_CREATOR = '0x7fc98430eaedbb6070b35b39d798725049088348';

/** Replaces each `from` (which must occur exactly once) with its `to`. */
function patch(what: string, source: string, swaps: [string, string][]): string {
  for (const [from, to] of swaps) {
    if (source.split(from).length !== 2) throw new Error(`${what}: expected exactly one ${JSON.stringify(from.trim().slice(0, 60))}`);
    source = source.replace(from, to);
  }
  return source;
}

/**
 * The simulation-only check that the paymaster has code, which also refused a zero paymaster: the EntryPoint takes
 * one (paymasterAndData naming address 0) as no paymaster, and such operations are included on-chain.
 */
const ZERO_PAYMASTER: [string, string] = ['            if (paymaster.code.length == 0) {', '            if (paymaster != address(0) && paymaster.code.length == 0) {'];
/** v0.6's EntryPoint.sol with simulateHandleOp returning instead of reverting (see the top of the file). */
const patchV06 = (source: string) => patch('EntryPoint v0.6', source, [
  ZERO_PAYMASTER,
  ['SenderCreator private immutable senderCreator = new SenderCreator();', `SenderCreator private constant senderCreator = SenderCreator(${getAddress(V06_SENDER_CREATOR)});`],
  ['        revert ExecutionResult(opInfo.preOpGas, paid, data.validAfter, data.validUntil, targetSuccess, targetResult);',
    '        bytes memory result = abi.encode(opInfo.preOpGas, paid, validationData, paymasterValidationData, targetSuccess, targetResult);\n        assembly { return(add(result, 32), mload(result)) }'],
]);
/** EntryPointSimulations without its depositTo's deliberate gas waste, and taking a zero paymaster as none. */
const plainDeposit = (source: string) => patch('EntryPointSimulations', source, [
  ['            uint256 x = 1;\n            while (x < 5) {\n                x++;\n            }\n', ''],
  ZERO_PAYMASTER,
]);

type Built = { code: string; version: string; immutables: Record<string, number[]>; slots: Record<string, string> };
/** The names solc gives the immutables it leaves zeroed in runtime code (by AST id), and their byte offsets. */
function built(out: { errors?: { severity: string; formattedMessage: string }[]; sources: Record<string, { ast: unknown }>; contracts: Record<string, Record<string, { storageLayout?: { storage: { label: string; slot: string; offset: number }[] }; evm: { deployedBytecode: { object: string; immutableReferences?: Record<string, { start: number; length: number }[]> } } }>> }, file: string, contract: string, version: string): Built {
  const errors = (out.errors ?? []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
  const names = new Map<number, string>();
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const node = n as { nodeType?: string; mutability?: string; id?: number; name?: string };
    if (node.nodeType === 'VariableDeclaration' && node.mutability === 'immutable' && node.id !== undefined) names.set(node.id, node.name!);
    for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
  };
  for (const src of Object.values(out.sources)) walk(src.ast);
  const bytecode = out.contracts[file][contract].evm.deployedBytecode;
  const immutables: Record<string, number[]> = {};
  for (const [id, refs] of Object.entries(bytecode.immutableReferences ?? {})) {
    const name = names.get(Number(id));
    if (!name) throw new Error(`${contract}: immutable ${id} has no name`);
    if (refs.some(r => r.length !== 32)) throw new Error(`${contract}: ${name} isn't a 32-byte immutable`);
    immutables[name] = refs.map(r => r.start);
  }
  // The storage EntryPointSimulations sets for itself when a simulation starts (initSenderCreator): its
  // SenderCreator and EIP-712 domain separator, which a plain handleOps (an earlier bundle in a replayed block)
  // reads too. Each takes a slot of its own.
  const slots: Record<string, string> = {};
  for (const v of out.contracts[file][contract].storageLayout?.storage ?? []) {
    if (v.label !== '_senderCreator' && v.label !== '__domainSeparatorV4') continue;
    if (v.offset !== 0) throw new Error(`${contract}: ${v.label} shares a slot`);
    slots[v.label] = `0x${BigInt(v.slot).toString(16).padStart(64, '0')}`;
  }
  return { code: `0x${bytecode.object}`, version, immutables, slots };
}

function compile(solcDir: string, aa: string, oz: string, file: string, contract: string, settings: object, edit?: (s: string) => string): Built {
  const solc = solcFrom(solcDir);
  // Only the EntryPoint's own folders: the package's samples have dependencies of their own.
  const own = Object.fromEntries(['core', 'interfaces', 'utils'].flatMap(d => Object.entries(sources(join(aa, d), `${d}/`))));
  if (edit) own[file] = { content: edit(own[file].content) };
  const input = { language: 'Solidity', sources: { ...own, ...sources(oz, '@openzeppelin/contracts/') },
    settings: { ...settings, outputSelection: { '*': { '': ['ast'] }, [file]: { [contract]: ['evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences', 'storageLayout'] } } } };
  return built(JSON.parse(solc.compile(JSON.stringify(input))), file, contract, solc.version().split('+')[0]);
}

/** v0.9: the deployed EntryPoint's verified sources and settings (Sourcify), with rc.1's simulation contract. */
function compileV09(solcDir: string, verified: Verified, aa: string): Built {
  const solc = solcFrom(solcDir);
  if (!verified.compilation.compilerVersion.startsWith(solc.version().split('.Emscripten')[0])) throw new Error(`EntryPoint v0.9 was compiled with ${verified.compilation.compilerVersion}, not ${solc.version()}`);
  const file = 'contracts/core/EntryPointSimulations.sol';
  const sources = { ...Object.fromEntries(Object.entries(verified.sources).map(([k, v]) => [k, { content: v.content }])),
    [file]: { content: plainDeposit(readFileSync(join(aa, 'core/EntryPointSimulations.sol'), 'utf8')) },
    'contracts/interfaces/IEntryPointSimulations.sol': { content: readFileSync(join(aa, 'interfaces/IEntryPointSimulations.sol'), 'utf8') } };
  const { viaIR, optimizer, evmVersion } = verified.compilation.compilerSettings;
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: { viaIR, optimizer, evmVersion, outputSelection: { '*': { '': ['ast'] }, [file]: { EntryPointSimulations: ['evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences', 'storageLayout'] } } } })));
  return built(out, file, 'EntryPointSimulations', solc.version().split('+')[0]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--cache');
  const cache = at >= 0 ? args[at + 1] : join(tmpdir(), 'signing-preview-entrypoint-sources');
  mkdirSync(cache, { recursive: true });
  const [aa06, aa07, aa08, aa09, oz49, oz50, oz51, solc17, solc23, solc28] = await Promise.all(
    (['aa06', 'aa07', 'aa08', 'aa09', 'oz49', 'oz50', 'oz51', 'solc17', 'solc23', 'solc28'] as const).map(k => npmPackage(cache, PACKAGES[k])));
  const ep09 = await sourcify(cache);
  const v06 = compile(solc17, aa06, oz49, 'core/EntryPoint.sol', 'EntryPoint', SETTINGS['0.6'], patchV06);
  const v07 = compile(solc23, aa07, oz50, 'core/EntryPointSimulations.sol', 'EntryPointSimulations', SETTINGS['0.7'], plainDeposit);
  const v08 = compile(solc28, aa08, oz51, 'core/EntryPointSimulations.sol', 'EntryPointSimulations', SETTINGS['0.8'], plainDeposit);
  const v09 = compileV09(solc28, ep09, aa09);
  const generated = `// Generated by scripts/build-entrypoint-simulations.ts. Do not edit.
//
// Runtime code put in place of an EntryPoint's code by a state override: it keeps the EntryPoint's storage
// (deposits, nonces) and SenderCreator, and its simulateHandleOp validates, executes and runs the paymaster's postOp
// in one call, returning (preOpGas, paid, accountValidationData, paymasterValidationData, targetSuccess,
// targetResult) instead of reverting. Each is compiled as its deployed EntryPoint was (via IR, 1,000,000 runs), so
// operations cost the gas they will.
//
// Runtime code has its immutables zeroed (a constructor sets them, and a code override runs none): each
// *_IMMUTABLES gives the byte offsets of each one's 32-byte word, which src/erc4337-sim.ts fills as the EntryPoint's
// own constructor did. EntryPointSimulations keeps what it can't take from immutables in storage of its own, set when
// a simulation starts: *_SLOTS gives those slots (its SenderCreator, and for v0.8 on its EIP-712 domain separator,
// which operations are hashed with), which src/erc4337-sim.ts sets for every call in the simulated block, so a plain
// handleOps before the simulation (an earlier bundle) runs as the EntryPoint does.

/** EntryPoint v0.6 (0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789): @account-abstraction/contracts 0.6.0 core/EntryPoint.sol, patched, with @openzeppelin/contracts 4.9.6; solc ${v06.version}. */
export const ENTRY_POINT_SIMULATIONS_V06 = '${v06.code}';
export const ENTRY_POINT_SIMULATIONS_V06_IMMUTABLES: Record<string, number[]> = ${JSON.stringify(v06.immutables)};
export const ENTRY_POINT_SIMULATIONS_V06_SLOTS: Record<string, string> = ${JSON.stringify(v06.slots)};

/** EntryPoint v0.7 (0x0000000071727De22E5E9d8BAf0edAc6f37da032): 0.7.0 core/EntryPointSimulations.sol with 5.0.2; solc ${v07.version}, paris. */
export const ENTRY_POINT_SIMULATIONS_V07 = '${v07.code}';
export const ENTRY_POINT_SIMULATIONS_V07_IMMUTABLES: Record<string, number[]> = ${JSON.stringify(v07.immutables)};
export const ENTRY_POINT_SIMULATIONS_V07_SLOTS: Record<string, string> = ${JSON.stringify(v07.slots)};

/** EntryPoint v0.8 (0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108): 0.8.0 core/EntryPointSimulations.sol with 5.1.0; solc ${v08.version}, cancun. */
export const ENTRY_POINT_SIMULATIONS_V08 = '${v08.code}';
export const ENTRY_POINT_SIMULATIONS_V08_IMMUTABLES: Record<string, number[]> = ${JSON.stringify(v08.immutables)};
export const ENTRY_POINT_SIMULATIONS_V08_SLOTS: Record<string, string> = ${JSON.stringify(v08.slots)};

/** EntryPoint v0.9 (0x433709009B8330FDa32311DF1C2AFA402eD8D009): its verified sources (Sourcify) with 0.9.0-rc.1 core/EntryPointSimulations.sol; solc ${v09.version}, cancun. */
export const ENTRY_POINT_SIMULATIONS_V09 = '${v09.code}';
export const ENTRY_POINT_SIMULATIONS_V09_IMMUTABLES: Record<string, number[]> = ${JSON.stringify(v09.immutables)};
export const ENTRY_POINT_SIMULATIONS_V09_SLOTS: Record<string, string> = ${JSON.stringify(v09.slots)};
`;
  const target = `${root}src/entrypoint-simulations.ts`;
  if (args.includes('--check')) {
    if (readFileSync(target, 'utf8') !== generated) { console.error('src/entrypoint-simulations.ts differs from what its sources compile to'); process.exit(1); }
    console.log('src/entrypoint-simulations.ts is what its sources compile to');
  } else writeFileSync(target, generated);
  console.log(`src/entrypoint-simulations.ts: v0.6 ${(v06.code.length - 2) / 2} bytes (solc ${v06.version}), v0.7 ${(v07.code.length - 2) / 2} (${v07.version}), v0.8 ${(v08.code.length - 2) / 2} (${v08.version}), v0.9 ${(v09.code.length - 2) / 2} (${v09.version})`);
}
