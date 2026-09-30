import { build } from 'esbuild';
import { rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Bundle each Lambda handler into a SELF-CONTAINED CommonJS file in build/.
 *
 * Why bundling is required here: this is a pnpm workspace, so node_modules is a
 * tree of symlinks and the local `@racer/shared` package is linked, not copied.
 * `aws cloudformation package` just zips the directory, which loses symlinked
 * transitive deps — the deployed function then fails at import time with
 * "Cannot find module '@smithy/core'". Bundling inlines everything (AWS SDK
 * included) so the upload needs no node_modules at all.
 *
 * Output is CommonJS and build/ deliberately has no package.json, so Node treats
 * the .js files as CJS. Handlers are therefore `<name>.handler` at build root.
 */
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(pkgRoot, 'build');

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [
    path.join(pkgRoot, 'src/matchmaking.ts'),
    path.join(pkgRoot, 'src/profile.ts'),
  ],
  outdir: outDir,
  bundle: true,
  platform: 'node',
  target: 'node20',
  // ESM output (.mjs) so Lambda's Node 20 runtime loads it natively and we avoid
  // CJS interop issues with the bundled exports.
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  // Some bundled AWS SDK internals are CJS and call require(); provide it.
  banner: {
    js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
  },
  // Bundle the AWS SDK too: the runtime-provided copy is only a convenience,
  // and pinning our own version avoids surprise breakage.
  external: [],
  minify: false,
  sourcemap: false,
  logLevel: 'info',
});

console.log(`[api] bundled handlers into ${outDir}`);
