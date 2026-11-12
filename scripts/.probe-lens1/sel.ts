import { toFunctionSelector } from 'viem';
for (const s of ['isAuthorized(uint64,address)', 'policyExists(uint64)', 'isActivated(bytes32)', 'checkActivated(bytes32)', 'getB20Address(uint8,address,bytes32)', 'isB20(address)', 'isB20Initialized(address)', 'createB20(uint8,bytes32,bytes,bytes[])', 'policyAdmin(uint64)'])
  console.log(s, toFunctionSelector(s));
