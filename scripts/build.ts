// Browser bundles:
//   dist/interceptor.js     – dependency-free EIP-1193 wrapper (for dApps, extensions, wallets)
//   dist/signing-preview.js – the full previewer, for running locally inside a wallet/extension without the API
import { build } from 'esbuild';

const common = { bundle: true, format: 'esm', platform: 'browser', target: 'es2022', sourcemap: true, logLevel: 'info' } as const;
await build({ ...common, entryPoints: ['src/interceptor.ts'], outfile: 'dist/interceptor.js' });
await build({ ...common, entryPoints: ['src/index.ts'], outfile: 'dist/signing-preview.js', minify: true });
