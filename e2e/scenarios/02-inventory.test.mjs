/* E2E-04: the static route inventory. Every Jellyfin / reel-api request path
 * the apps' source can build (e2e/scripts/route-inventory.mjs reads src/ and
 * phone/src as text) must (a) exist in Jellyfin 12.1's OpenAPI (+ EXTRA_ROUTES)
 * or reel-api's own OpenAPI, and (b) be implemented by the fake — so a code
 * path no scenario reaches yet still can't call a removed route or one the
 * fixture would 404. No browser. */
import { test, assert } from '../lib/runner.mjs';
import { inventory, matchTemplates } from '../scripts/route-inventory.mjs';
import { EXTRA_ROUTES } from '../server/spec.mjs';
import { WARM_HINT } from '../scripts/reelapi-spec.mjs';

const METHODS = ['get', 'post', 'put', 'delete', 'head', 'patch'];
const fromDoc = (doc) => Object.entries(doc.paths).flatMap(([tpl, ops]) => METHODS.filter((m) => ops[m]).map((m) => ({ method: m.toUpperCase(), tpl })));
const fromRouter = (router) => router.templates().map((t) => {
  const [method, tpl] = t.split(' ');
  return { method, tpl };
});

test('inventory: every request path in src/ and phone/src is in the spec and implemented by the fake', { app: 'none', fast: true }, async (t) => {
  const { srv } = t;
  const inv = inventory();
  const jf = inv.filter((r) => r.kind === 'jf');
  const ml = inv.filter((r) => r.kind === 'ml');
  t.log(`inventory: ${jf.length} Jellyfin + ${ml.length} reel-api request shapes`);
  console.log(`    inventory: ${jf.length} Jellyfin + ${ml.length} reel-api request shapes`);
  // the extractor itself must keep working: these are known to be in the source
  for (const must of ['/Users/AuthenticateByName', '/Items/{}/PlaybackInfo', '/Sessions/Playing/Stopped', '/UserPlayedItems/{}', '/Videos/{}/Trickplay/{}/{}.jpg', '/MediaSegments/{}'])
    assert(jf.some((r) => r.shape === must), 'extractor lost ' + must);
  for (const must of ['/api/activity', '/api/metadata/{}/{}', '/api/segments/{}/{}/{}', '/api/downloads/{}/probe'])
    assert(ml.some((r) => r.shape === must), 'extractor lost ' + must);
  assert(jf.length >= 25 && ml.length >= 15, `inventory suspiciously small (${jf.length} + ${ml.length})`);

  const problems = [];
  const where = (r) => `${r.method || '*'} ${r.shape}  (${r.sites.slice(0, 2).join(', ')})`;
  const jfFake = fromRouter(srv.routers.jf);
  const mlFake = fromRouter(srv.routers.ml).filter((x) => !x.tpl.startsWith('/__fixture'));
  if (srv.spec) {
    const jfSpec = [...fromDoc(srv.spec.doc), ...EXTRA_ROUTES.map((r) => ({ method: r.method, tpl: r.tpl }))];
    for (const r of jf) if (!matchTemplates(r.shape, r.method, jfSpec, { ci: true }).length) problems.push('not in Jellyfin 12.1: ' + where(r));
  } else t.log('Jellyfin spec not cached — spec half skipped');
  if (srv.reelSpec) {
    const mlSpec = fromDoc(srv.reelSpec.doc);
    for (const r of ml) if (!matchTemplates(r.shape, r.method, mlSpec).length) problems.push("not in reel-api's OpenAPI: " + where(r));
  } else if (process.env.E2E_ALLOW_NO_REEL_SPEC === '1') t.log('reel-api spec absent — spec half skipped (E2E_ALLOW_NO_REEL_SPEC=1)');
  else problems.push('reel-api spec absent — ' + WARM_HINT);
  for (const r of jf) if (!matchTemplates(r.shape, r.method, jfFake, { ci: true }).length) problems.push('fake Jellyfin lacks: ' + where(r));
  for (const r of ml) if (!matchTemplates(r.shape, r.method, mlFake).length) problems.push('fake reel-api lacks: ' + where(r));
  assert(!problems.length, `${problems.length} route problem(s):\n      ` + problems.join('\n      '));

  // the matcher must reject what CLAUDE.md lists as removed in 12.x
  if (srv.spec) {
    const jfSpec = fromDoc(srv.spec.doc);
    for (const gone of ['/Users/{}/Images/Primary', '/Users/{}/PlayedItems/{}', '/Users/{}/Items/{}', '/Users/{}/Items/Resume'])
      assert(!matchTemplates(gone, null, jfSpec, { ci: true }).length, 'matcher accepts the removed route ' + gone);
  }
});
