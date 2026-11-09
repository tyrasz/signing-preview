// Compiles the simulation code put in place of each EntryPoint's code (src/erc4337-sim.ts) and writes
// src/entrypoint-simulations.ts. Its sources aren't in this repository, nor are the compilers the EntryPoints were
// built with; fetch the published packages first and pass their folders:
//
//   npm pack @account-abstraction/contracts@0.6.0 @openzeppelin/contracts@4.9.6 solc@0.8.17   (EntryPoint v0.6)
//   npm pack @account-abstraction/contracts@0.7.0 @openzeppelin/contracts@5.0.2 solc@0.8.23   (EntryPoint v0.7)
//   npm pack @account-abstraction/contracts@0.8.0 @openzeppelin/contracts@5.1.0 solc@0.8.28   (EntryPoint v0.8)
//   npm pack @account-abstraction/contracts@0.9.0-rc.1                                        (EntryPoint v0.9: its simulation contract)
//   curl -o ep09.json 'https://sourcify.dev/server/v2/contract/1/0x433709009B8330FDa32311DF1C2AFA402eD8D009?fields=sources,compilation'
//   node scripts/build-entrypoint-simulations.ts <aa-0.6.0> <oz-4.9.6> <solc-0.8.17> <aa-0.7.0> <oz-5.0.2> <solc-0.8.23> <aa-0.8.0> <oz-5.1.0> <solc-0.8.28> <ep09.json> <aa-0.9.0-rc.1>
//
// (each folder being the unpacked package/). Each is compiled with the compiler and settings that reproduce its
// deployed EntryPoint byte for byte (checked against the code on Ethereum: EntryPoint.sol compiled this way is
// identical, immutables and metadata aside), so the simulated operation uses the gas the real one will.
// v0.9 was released after its last published package (0.9.0-rc.1, whose EntryPoint differs from the deployed one):
// its EntryPoint sources and settings are the deployed contract's own, verified on Sourcify (an exact match), and
// rc.1's EntryPointSimulations is compiled on top of them (its interface is unchanged).
//
// v0.7 and v0.8: eth-infinitism's EntryPointSimulations, which keeps the EntryPoint's storage and SenderCreator and
// whose simulateHandleOp returns its result. Its depositTo, which wastes a little gas on purpose (bundlers want
// simulation to cost no less than the chain), is plain here: an account paying its prefund pays what it will.
// v0.6 has no EntryPointSimulations: its own simulateHandleOp always reverts, which discards the operation's logs.
// It is compiled from EntryPoint.sol with two changes: simulateHandleOp returns its result (the account's and the
// paymaster's validation data whole, in v0.7's ExecutionResult order) instead of reverting, and the SenderCreator,
// an immutable the override can't set, is the deployed one as a constant. Storage is unchanged.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { getAddress } from 'viem';

const require = createRequire(import.meta.url);
const root = new URL('..', import.meta.url).pathname;
/** The deployed EntryPoints' settings: all via IR at 1,000,000 runs; v0.6 with 0.8.17's default EVM (london). */
const SETTINGS = {
  '0.6': { viaIR: true, optimizer: { enabled: true, runs: 1_000_000 } },
  '0.7': { viaIR: true, optimizer: { enabled: true, runs: 1_000_000 }, evmVersion: 'paris' },
  '0.8': { viaIR: true, optimizer: { enabled: true, runs: 1_000_000 }, evmVersion: 'cancun' },
} as const;

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

/** v0.6's EntryPoint.sol with simulateHandleOp returning instead of reverting (see the top of the file). */
const patchV06 = (source: string) => patch('EntryPoint v0.6', source, [
  ['SenderCreator private immutable senderCreator = new SenderCreator();', `SenderCreator private constant senderCreator = SenderCreator(${getAddress(V06_SENDER_CREATOR)});`],
  ['        revert ExecutionResult(opInfo.preOpGas, paid, data.validAfter, data.validUntil, targetSuccess, targetResult);',
    '        bytes memory result = abi.encode(opInfo.preOpGas, paid, validationData, paymasterValidationData, targetSuccess, targetResult);\n        assembly { return(add(result, 32), mload(result)) }'],
]);
/** EntryPointSimulations without its depositTo's deliberate gas waste. */
const plainDeposit = (source: string) => patch('EntryPointSimulations', source, [
  ['            uint256 x = 1;\n            while (x < 5) {\n                x++;\n            }\n', ''],
]);

function compile(solcDir: string, aa: string, oz: string, file: string, contract: string, settings: object, edit?: (s: string) => string): { code: string; version: string } {
  const solc = require(join(solcDir, 'index.js'));
  // Only the EntryPoint's own folders: the package's samples have dependencies of their own.
  const own = Object.fromEntries(['core', 'interfaces', 'utils'].flatMap(d => Object.entries(sources(join(aa, d), `${d}/`))));
  if (edit) own[file] = { content: edit(own[file].content) };
  const input = { language: 'Solidity', sources: { ...own, ...sources(oz, '@openzeppelin/contracts/') },
    settings: { ...settings, outputSelection: { [file]: { [contract]: ['evm.deployedBytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join('\n'));
  return { code: `0x${out.contracts[file][contract].evm.deployedBytecode.object}`, version: solc.version().split('+')[0] };
}

/** v0.9: the deployed EntryPoint's verified sources and settings (Sourcify), with rc.1's simulation contract. */
function compileV09(solcDir: string, sourcifyJson: string, aa: string): { code: string; version: string } {
  const solc = require(join(solcDir, 'index.js'));
  const verified = JSON.parse(readFileSync(sourcifyJson, 'utf8')) as { sources: Record<string, { content: string }>; compilation: { compilerVersion: string; compilerSettings: Record<string, unknown> } };
  if (!verified.compilation.compilerVersion.startsWith(solc.version().split('.Emscripten')[0])) throw new Error(`EntryPoint v0.9 was compiled with ${verified.compilation.compilerVersion}, not ${solc.version()}`);
  const file = 'contracts/core/EntryPointSimulations.sol';
  const sources = { ...Object.fromEntries(Object.entries(verified.sources).map(([k, v]) => [k, { content: v.content }])),
    [file]: { content: plainDeposit(readFileSync(join(aa, 'core/EntryPointSimulations.sol'), 'utf8')) },
    'contracts/interfaces/IEntryPointSimulations.sol': { content: readFileSync(join(aa, 'interfaces/IEntryPointSimulations.sol'), 'utf8') } };
  const { viaIR, optimizer, evmVersion } = verified.compilation.compilerSettings;
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: { viaIR, optimizer, evmVersion, outputSelection: { [file]: { EntryPointSimulations: ['evm.deployedBytecode.object'] } } } })));
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join('\n'));
  return { code: `0x${out.contracts[file].EntryPointSimulations.evm.deployedBytecode.object}`, version: solc.version().split('+')[0] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [aa06, oz49, solc17, aa07, oz50, solc23, aa08, oz51, solc28, ep09, aa09] = process.argv.slice(2);
  const v06 = compile(solc17, aa06, oz49, 'core/EntryPoint.sol', 'EntryPoint', SETTINGS['0.6'], patchV06);
  const v07 = compile(solc23, aa07, oz50, 'core/EntryPointSimulations.sol', 'EntryPointSimulations', SETTINGS['0.7'], plainDeposit);
  const v08 = compile(solc28, aa08, oz51, 'core/EntryPointSimulations.sol', 'EntryPointSimulations', SETTINGS['0.8'], plainDeposit);
  const v09 = compileV09(solc28, ep09, aa09);
  writeFileSync(`${root}src/entrypoint-simulations.ts`, `// Generated by scripts/build-entrypoint-simulations.ts. Do not edit.
//
// Runtime code put in place of an EntryPoint's code by a state override: it keeps the EntryPoint's storage
// (deposits, nonces) and SenderCreator, and its simulateHandleOp validates, executes and runs the paymaster's postOp
// in one call, returning (preOpGas, paid, accountValidationData, paymasterValidationData, targetSuccess,
// targetResult) instead of reverting. Each is compiled as its deployed EntryPoint was (via IR, 1,000,000 runs), so
// operations cost the gas they will.

/** EntryPoint v0.6 (0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789): @account-abstraction/contracts 0.6.0 core/EntryPoint.sol, patched, with @openzeppelin/contracts 4.9.6; solc ${v06.version}. */
export const ENTRY_POINT_SIMULATIONS_V06 = '${v06.code}';

/** EntryPoint v0.7 (0x0000000071727De22E5E9d8BAf0edAc6f37da032): 0.7.0 core/EntryPointSimulations.sol with 5.0.2; solc ${v07.version}, paris. */
export const ENTRY_POINT_SIMULATIONS_V07 = '${v07.code}';

/** EntryPoint v0.8 (0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108): 0.8.0 core/EntryPointSimulations.sol with 5.1.0; solc ${v08.version}, cancun. */
export const ENTRY_POINT_SIMULATIONS_V08 = '${v08.code}';

/** EntryPoint v0.9 (0x433709009B8330FDa32311DF1C2AFA402eD8D009): its verified sources (Sourcify) with 0.9.0-rc.1 core/EntryPointSimulations.sol; solc ${v09.version}, cancun. */
export const ENTRY_POINT_SIMULATIONS_V09 = '${v09.code}';
`);
  console.log(`src/entrypoint-simulations.ts: v0.6 ${(v06.code.length - 2) / 2} bytes (solc ${v06.version}), v0.7 ${(v07.code.length - 2) / 2} (${v07.version}), v0.8 ${(v08.code.length - 2) / 2} (${v08.version}), v0.9 ${(v09.code.length - 2) / 2} (${v09.version})`);
}
