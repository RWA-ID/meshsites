/** Node-only helpers (filesystem). Import from '@meshsites/protocol/node'. */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { SiteFile } from './car.ts';

const IGNORED = new Set(['.DS_Store', 'Thumbs.db']);

/** Read a directory into SiteFiles, sorted by path. Dotfiles are skipped. */
export async function readSiteDir(dir: string): Promise<{ files: SiteFile[]; skipped: string[] }> {
  const files: SiteFile[] = [];
  const skipped: string[] = [];
  async function walk(d: string) {
    for (const ent of await readdir(d, { withFileTypes: true })) {
      const full = join(d, ent.name);
      const rel = relative(dir, full).split(sep).join('/');
      if (ent.name.startsWith('.') || IGNORED.has(ent.name)) {
        skipped.push(rel);
        continue;
      }
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile()) files.push({ path: rel, content: new Uint8Array(await readFile(full)) });
      else skipped.push(rel);
    }
  }
  await walk(dir);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, skipped };
}
