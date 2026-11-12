// Compiles the Solidity references the local EVM runs for Base's native token standard (B20) and writes
// src/b20-reference.ts:
//
//   npm run build:b20              (writes the file)
//   npm run build:b20 -- --check   (compiles, and fails if the committed file differs)
//   npm run build:b20 -- --update  (fetches base-std's main again into vendor/base-std, and says what changed)
//
// Base's node runs B20 tokens itself, in Rust: each token's code is the marker byte 0xef, so there is no EVM code to
// run. The Base Standard Library (github.com/base/base-std) ships a Solidity reference for each of them, which Base
// keeps behaving like the Rust precompiles and storing state in the same slots (its suite runs against both): the
// token variants (MockB20Asset, MockB20Stablecoin) and the registries a token asks on every transfer
// (MockPolicyRegistry, MockActivationRegistry). Compiled here, they run in the local EVM in place of the markers, on
// the chain's own storage (src/fork-simulator.ts: nativeStandIn). The factory's reference isn't among them: it
// creates tokens with test-only cheatcodes, so a creation is still refused.
//
// The sources are base/base-std's `main` as fetched on 2026-11-12 (raw.githubusercontent.com), kept in
// vendor/base-std with its licence (MIT) and checked against a sha256 over them (each path and content, in path
// order), so the build needs no network and gives the same output for good. `main`, not the latest tag (v1.1.0), is
// what Base runs: v1.1.0's token takes a transfer to the token's own address, which the chain refuses
// (InvalidReceiver), as `main`'s does. --update fetches `main` again (the branch moves: a change to what Base runs
// shows there first) and prints the new hash, to be checked against the chain before it replaces SOURCES_SHA256.
// The compiler is this repository's solc (package.json), so the output depends on nothing else.
//
// Checked against the live precompiles call by call (188 calls to a token, 372 to the registries), the references
// differ in a few ways, patched here (PATCHES) so that they do what the chain does:
//   - the token's bootstrap window: the reference lets the factory skip every role and policy check until a flag it
//     alone stores is set; the chain never stores that flag, so read from the chain's storage the window was open
//     for any call from the factory's address. Every token the local EVM meets is past it: closed.
//   - permit to spender 0 (after the signature checks): the chain refuses it (InvalidSpender), the reference didn't;
//   - MAX_SUPPLY_CAP() and the policy registry's ALWAYS_ALLOW_ID() and ALWAYS_BLOCK_ID() are the references' own:
//     the chain has no such functions;
//   - a call to no function of the token's: the chain reverts with the call's first four bytes (0x00000000 when it
//     has fewer), or with NonPayable() when value is sent, where the reference reverted empty;
//   - the activation registry's admin: the chain's (its configuration's), not the reference's placeholder.
// Three things the chain does to any call are done by the local EVM instead (src/fork-simulator.ts): value sent to a
// token or registry is refused with NonPayable(); a token or registry run as another contract's code (DELEGATECALL)
// with DelegateCallNotAllowed(); and calldata a function can't decode reverts with the call's selector, where the
// reference reverts empty (its only empty revert).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getAddress } from 'viem';

const root = new URL('..', import.meta.url).pathname;
const BASE = 'https://raw.githubusercontent.com/base/base-std/main/';
/** The files compiled (the references, their storage libraries, and the interfaces and libraries they import). */
const FILES = [
  'src/StdPrecompiles.sol',
  'src/interfaces/IActivationRegistry.sol', 'src/interfaces/IB20.sol', 'src/interfaces/IB20Asset.sol', 'src/interfaces/IB20Factory.sol',
  'src/interfaces/IB20Stablecoin.sol', 'src/interfaces/IERC165.sol', 'src/interfaces/IERC8056.sol', 'src/interfaces/IPolicyRegistry.sol',
  'src/lib/B20Constants.sol', 'src/lib/B20FactoryLib.sol',
  'test/lib/mocks/ActivationRegistryFeatureList.sol', 'test/lib/mocks/MockActivationRegistry.sol', 'test/lib/mocks/MockActivationRegistryStorage.sol',
  'test/lib/mocks/MockB20.sol', 'test/lib/mocks/MockB20Asset.sol', 'test/lib/mocks/MockB20Stablecoin.sol', 'test/lib/mocks/MockB20Storage.sol',
  'test/lib/mocks/MockPolicyRegistry.sol', 'test/lib/mocks/MockPolicyRegistryStorage.sol',
] as const;
const SOURCES_SHA256 = '5dca0a63ed0227de56168e0d92b5a8fe180bc488f1e98e903400179534bf1589';
/** The contracts written out, by the name the generated file gives each one's runtime code. */
const OUTPUTS = {
  B20_ASSET_CODE: ['test/lib/mocks/MockB20Asset.sol', 'MockB20Asset'],
  B20_STABLECOIN_CODE: ['test/lib/mocks/MockB20Stablecoin.sol', 'MockB20Stablecoin'],
  POLICY_REGISTRY_CODE: ['test/lib/mocks/MockPolicyRegistry.sol', 'MockPolicyRegistry'],
  ACTIVATION_REGISTRY_CODE: ['test/lib/mocks/MockActivationRegistry.sol', 'MockActivationRegistry'],
} as const;
/** Base's activation registry admin (its admin() on the chain: the chain configuration's, the registry storing none). */
const ACTIVATION_ADMIN = getAddress('0xce3a3bee7e72e2a24079f3c0cb3b97740ed425a9');
/** The changes made to the sources before compiling (see the top of the file): each must occur exactly once. */
const PATCHES: Record<string, [string, string][]> = {
  'test/lib/mocks/MockB20.sol': [
    ['        return msg.sender == FACTORY && !MockB20Storage.layout().initialized;\n', '        return false;\n'],
    ['            revert InvalidSigner(recovered, owner);\n        }\n', '            revert InvalidSigner(recovered, owner);\n        }\n        if (spender == address(0)) revert InvalidSpender(spender);\n'],
    ['    uint256 public constant MAX_SUPPLY_CAP = B20Constants.MAX_SUPPLY_CAP;', '    uint256 internal constant MAX_SUPPLY_CAP = B20Constants.MAX_SUPPLY_CAP;'],
    ['    function _isPrivileged() internal view returns (bool) {', `    fallback() external payable {
        assembly {
            if callvalue() { mstore(0, shl(224, 0x6fb1b0e9)) revert(0, 4) }
            mstore(0, 0)
            if gt(calldatasize(), 3) { mstore(0, calldataload(0)) }
            revert(0, 4)
        }
    }

    function _isPrivileged() internal view returns (bool) {`],
  ],
  'test/lib/mocks/MockPolicyRegistry.sol': [
    ['    uint64 public constant ALWAYS_ALLOW_ID = PolicyRegistryConstants.ALWAYS_ALLOW_ID;', '    uint64 internal constant ALWAYS_ALLOW_ID = PolicyRegistryConstants.ALWAYS_ALLOW_ID;'],
    ['    uint64 public constant ALWAYS_BLOCK_ID = PolicyRegistryConstants.ALWAYS_BLOCK_ID;', '    uint64 internal constant ALWAYS_BLOCK_ID = PolicyRegistryConstants.ALWAYS_BLOCK_ID;'],
  ],
  'test/lib/mocks/MockActivationRegistry.sol': [
    ['    address internal constant ADMIN = 0xCB00000000000000000000000000000000000000;', `    address internal constant ADMIN = ${ACTIVATION_ADMIN};`],
  ],
};
const patched = (file: string, source: string) => {
  for (const [from, to] of PATCHES[file] ?? []) {
    if (source.split(from).length !== 2) throw new Error(`${file}: expected exactly one ${JSON.stringify(from.trim().slice(0, 70))}`);
    source = source.replace(from, to);
  }
  return source;
};
// Cancun's opcodes run on every chain this repository supports; the optimizer keeps the references' gas near what a
// compiled token's would be (the Rust precompile's own isn't reproduced: see src/fork-simulator.ts).
const SETTINGS = { viaIR: true, optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', remappings: ['base-std/=src/', 'base-std-test/=test/'] };

const args = process.argv.slice(2);
const vendor = join(root, 'vendor', 'base-std');

const hashOf = (files: Record<string, string>) => {
  const h = createHash('sha256');
  for (const k of Object.keys(files).sort()) h.update(`${k}\0${files[k]}\0`);
  return h.digest('hex');
};

const read = () => Object.fromEntries(FILES.map(f => [f, readFileSync(join(vendor, f), 'utf8')]));
if (args.includes('--update')) {
  const before = existsSync(join(vendor, FILES[0])) ? read() : {};
  for (const f of FILES) {
    const res = await fetch(BASE + f);
    if (!res.ok) throw new Error(`${BASE}${f}: HTTP ${res.status}`);
    mkdirSync(dirname(join(vendor, f)), { recursive: true });
    writeFileSync(join(vendor, f), await res.text());
  }
  const after = read(), changed = FILES.filter(f => before[f] !== after[f]);
  console.log(changed.length ? `changed: ${changed.join(', ')}\nsources sha256 ${hashOf(after)}: check them against the chain, then pin it as SOURCES_SHA256` : 'base-std main is unchanged.');
  process.exit(0);
}
const files = read();
if (hashOf(files) !== SOURCES_SHA256) throw new Error(`vendor/base-std doesn't match its pinned hash (${hashOf(files)}): pin it as SOURCES_SHA256 only once it is checked against the chain`);
const solc = createRequire(import.meta.url)('solc') as { compile(input: string): string; version(): string };
const input = { language: 'Solidity', sources: Object.fromEntries(Object.entries(files).map(([k, content]) => [k, { content: patched(k, content) }])), settings: { ...SETTINGS, outputSelection: { '*': { '*': ['evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } } } };
const out = JSON.parse(solc.compile(JSON.stringify(input))) as { errors?: { severity: string; formattedMessage: string }[]; contracts: Record<string, Record<string, { evm: { deployedBytecode: { object: string; immutableReferences?: Record<string, unknown> } } }>> };
const errors = (out.errors ?? []).filter(e => e.severity === 'error');
if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
const codes = Object.entries(OUTPUTS).map(([name, [file, contract]]) => {
  const c = out.contracts[file]?.[contract]?.evm.deployedBytecode;
  if (!c?.object) throw new Error(`${contract}: no runtime code`);
  // Run as they are, at an address that never ran a constructor: nothing may be set at deployment.
  if (Object.keys(c.immutableReferences ?? {}).length) throw new Error(`${contract} has immutables, which no constructor would set here`);
  return [name, `0x${c.object}`] as const;
});

const text = `// Generated by scripts/build-b20.ts (npm run build:b20): do not edit.
//
// Runtime code compiled from the Base Standard Library's Solidity references for Base's B20 tokens and the
// registries they call (base/base-std \`main\`, sources sha256 ${SOURCES_SHA256}, patched as the build script
// says; solc ${solc.version()}, via IR, 200 runs, cancun). The local EVM runs them in place of the chain's own Rust
// precompiles: see nativeStandIn in src/fork-simulator.ts.

/** Where the code came from. */
export const B20_REFERENCE = { source: 'base/base-std main', sourcesSha256: '${SOURCES_SHA256}', solc: '${solc.version()}' } as const;
${codes.map(([name, code]) => `\nexport const ${name} = '${code}';`).join('')}
`;
const target = join(root, 'src', 'b20-reference.ts');
if (args.includes('--check')) {
  if (!existsSync(target) || readFileSync(target, 'utf8') !== text) { console.error('src/b20-reference.ts differs from what its sources compile to: run npm run build:b20'); process.exit(1); }
  console.log('src/b20-reference.ts is what its sources compile to.');
} else {
  writeFileSync(target, text);
  console.log(`wrote src/b20-reference.ts (${codes.map(([n, c]) => `${n} ${(c.length - 2) / 2} bytes`).join(', ')})`);
}
