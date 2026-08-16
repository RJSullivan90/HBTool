//
// build.mjs — esbuild bundling for the three entry points.
//
// Main and preload are CommonJS: Electron's preload must be CJS unless you take
// on the .mjs/sandbox complications, and keeping both halves the same format
// removes a class of "works in dev, breaks when packaged" surprises.
// The renderer is a plain ES module, which the CSP allows as 'self'.
//

import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

const watch = process.argv.includes('--watch');

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, 'renderer'), { recursive: true });

// Electron 43 bundles Node 22 and Chromium 140. Targeting them lets esbuild
// leave modern syntax alone instead of down-levelling for a runtime that will
// never load this code. Bump these when the Electron major changes.
const NODE_TARGET = 'node22';
const CHROME_TARGET = 'chrome140';

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
};

await build({
  ...common,
  entryPoints: [join(root, 'src/main/main.ts')],
  outfile: join(dist, 'main.cjs'),
  platform: 'node',
  format: 'cjs',
  target: NODE_TARGET,
  // Electron and its updater are resolved at runtime from the app bundle, never
  // inlined.
  external: ['electron', 'electron-updater'],
});

await build({
  ...common,
  entryPoints: [join(root, 'src/main/preload.ts')],
  outfile: join(dist, 'preload.cjs'),
  platform: 'node',
  format: 'cjs',
  target: NODE_TARGET,
  external: ['electron'],
});

await build({
  ...common,
  entryPoints: [join(root, 'src/renderer/renderer.ts')],
  outfile: join(dist, 'renderer/renderer.js'),
  platform: 'browser',
  format: 'esm',
  target: CHROME_TARGET,
});

for (const file of ['index.html', 'styles.css']) {
  await cp(join(root, 'src/renderer', file), join(dist, 'renderer', file));
}

console.log(`Built into ${dist}${watch ? ' (watch not enabled in this script)' : ''}`);
