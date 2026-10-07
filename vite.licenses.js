import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* Build only: emit LICENSES.txt next to the bundle — this project's LICENSE plus
 * the license text of every third-party module that actually made it into the
 * output (rendered code > 0, so tree-shaken packages drop out). npm packages are
 * found by their node_modules path and their own LICENSE file; the vendored
 * libpgs brings src/vendor/libpgs.LICENSE. Shared by vite.config.js (TV) and
 * phone/vite.config.js, so neither build can ship without the notices. */

const repo = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = [
  [path.join(repo, 'src/vendor/libpgs.js'), 'libpgs (src/vendor/libpgs.js)', path.join(repo, 'src/vendor/libpgs.LICENSE')]
];
const LICENSE_NAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'LICENCE'];

function pkgSection(dir) {
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const file = LICENSE_NAMES.map((n) => path.join(dir, n)).find(existsSync);
  if (!file) throw new Error(`licenses: no license file in ${dir}`);
  return [`${pkg.name} ${pkg.version} (${pkg.license})`, readFileSync(file, 'utf8')];
}

export const licenses = {
  name: 'licenses',
  apply: 'build',
  generateBundle(_, bundle) {
    const pkgDirs = new Set();
    const vendored = new Set();
    for (const out of Object.values(bundle)) {
      if (out.type !== 'chunk') continue;
      for (const [id, m] of Object.entries(out.modules)) {
        if (!m.renderedLength) continue;
        const file = id.replace(/^\0/, '').split('?')[0];
        const nm = file.match(/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//);
        if (nm) pkgDirs.add(nm[1]);
        for (const v of VENDOR) if (file === v[0]) vendored.add(v);
      }
    }
    const sections = [['VibeReel', readFileSync(path.join(repo, 'LICENSE'), 'utf8')]];
    for (const [, name, lic] of vendored) sections.push([name, readFileSync(lic, 'utf8')]);
    for (const dir of [...pkgDirs].sort()) sections.push(pkgSection(dir));
    const rule = '='.repeat(72);
    this.emitFile({
      type: 'asset',
      fileName: 'LICENSES.txt',
      source: sections.map(([name, text]) => `${rule}\n${name}\n${rule}\n\n${text.trim()}\n`).join('\n')
    });
  }
};
