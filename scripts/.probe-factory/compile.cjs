const solc = require('solc'); const fs = require('fs');
const src = fs.readFileSync(__dirname + '/Probe.sol', 'utf8');
const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'Probe.sol': { content: src } }, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['evm.deployedBytecode.object'] } } } })));
if (out.errors?.some(e => e.severity === 'error')) { console.error(out.errors); process.exit(1); }
fs.writeFileSync(__dirname + '/probe-code.json', JSON.stringify({ code: '0x' + out.contracts['Probe.sol'].Probe.evm.deployedBytecode.object }));
console.log('ok', out.contracts['Probe.sol'].Probe.evm.deployedBytecode.object.length / 2);
