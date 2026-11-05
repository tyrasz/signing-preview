// The probe's bytecode is committed (src/probe-code.ts) so the library needs no compiler. This keeps it honest:
// the source, compiled with the pinned solc and settings, must give exactly the committed code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileProbe, probeModule } from '../scripts/build-probe.ts';
import { SIMULATION_PROBE_CODE } from '../src/probe-code.ts';

test('src/probe-code.ts is contracts/SimulationProbe.sol compiled with the pinned solc (npm run build:probe)', () => {
  const compiled = compileProbe();
  assert.equal(compiled.version.split('+')[0], JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).devDependencies.solc);
  assert.equal(SIMULATION_PROBE_CODE, compiled.runtime, 'run npm run build:probe');
  assert.equal(readFileSync(new URL('../src/probe-code.ts', import.meta.url), 'utf8'), probeModule(compiled));
});
