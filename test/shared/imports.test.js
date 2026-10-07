/* Every src/lib module imports cleanly in both projects (under the build's
 * define + redirects), with no network on import. A module that can't be
 * imported can't be tested — this is the first thing to break if the harness
 * drifts from the builds. */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { mockFetch } from '../helpers/fetch.js';
import { freshImport } from '../helpers/modules.js';

const LIB = path.resolve(import.meta.dirname, '../../src/lib');
const modules = readdirSync(LIB).filter((f) => f.endsWith('.js')).sort();

describe('src/lib imports', () => {
  it('lists the 34 modules the lane covers', () => {
    expect(modules.length).toBe(34); // + me.svelte.js (ownership and quotas)
  });

  it.each(modules)('%s imports without side-effect requests', async (f) => {
    const net = mockFetch();
    const { m } = await freshImport({ modules: { m: 'src/lib/' + f } });
    expect(m).toBeTypeOf('object');
    expect(Object.keys(m).length).toBeGreaterThan(0);
    expect(net.calls.map((c) => c.url)).toEqual([]);
  });
});
