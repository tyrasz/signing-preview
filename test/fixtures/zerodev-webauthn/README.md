# ZeroDev WebAuthn verification (test fixture)

`WebAuthn.sol`, `P256.sol` and `Base64URL.sol` are the sources of ZeroDev's WebAuthn validator for Kernel v3
(`0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69`), exactly as verified on Sourcify (Arbitrum One, solc 0.8.30), and
`openzeppelin-contracts/contracts/utils/Base64.sol` is the OpenZeppelin Contracts 5.4.0 file they import. All are
MIT-licensed, with their own headers.

`test/fixtures/KernelPasskey.sol` uses them in `KernelPasskey`, an account that validates its operations as the
validator does, so `test/erc4337-sim.test.ts` checks the passkey stand-in against ZeroDev's own checks.
