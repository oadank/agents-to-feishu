/**
 * esbuild 打包：src/index.ts → dist/daemon.mjs（单文件，可独立部署）
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

await build({
  entryPoints: [path.join(root, 'src', 'index.ts')],
  bundle: true,
  outfile: path.join(root, 'dist', 'daemon.mjs'),
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  banner: {
    // Lark SDK 在 ESM 下需要 __dirname polyfill
    js: "import { createRequire as __cr } from 'module'; import { fileURLToPath as __f2p } from 'url'; const require = __cr(import.meta.url); const __filename = __f2p(import.meta.url); const __dirname = __filename.replace(/[/][^/]*$/, '');",
  },
  external: [],
  logLevel: 'info',
});

console.log('[build] dist/daemon.mjs 构建完成');
