/** Bundle the web testbed with esbuild. `node web/build.ts [--watch]` */
import * as esbuild from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const buildOptions: esbuild.BuildOptions = {
  entryPoints: {
    sim: join(here, 'src/sim.ts'),
    tab: join(here, 'src/tab.ts'),
    viewer: join(here, 'src/viewer.ts'),
    sw: join(here, 'src/sw.ts'),
  },
  outdir: join(here, 'dist'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022', 'safari16'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

export async function build(watch = false) {
  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    return ctx;
  }
  await esbuild.build(buildOptions);
}

if (import.meta.url === `file://${process.argv[1]}`) await build(process.argv.includes('--watch'));
