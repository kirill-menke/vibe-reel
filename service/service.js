/**
 * VibeReel companion service — picture-mode control for the web app.
 *
 * The web app is ACG-blocked from com.webos.settingsservice and SSAP's
 * setSystemSettings returns 401 on this C4 even with the signed LG manifest, so
 * the app cannot change the TV picture mode itself. This tiny Node service can:
 * it runs un-jailed (its own run-js-service wrapper sets thirdparty_jail=off)
 * and registers on the luna bus under the name "com.webos.app.multiviewsettings-
 * reel", which the hub matches to the real Multi-View Settings app role and
 * authorises with that app's settings permission. (Registering under our own
 * id is capped at the "public" group and gets "Access denied".)
 *
 * The app reaches it over a loopback HTTP endpoint (it already opens loopback
 * sockets for SSAP):  GET http://127.0.0.1:8791/picture[?mode=cinema]
 */
'use strict';
var Service = require('webos-service');
var http = require('http');
var url = require('url');
var fs = require('fs');

// This borrowed identity is what grants access to settingsservice. The "-reel"
// suffix keeps it distinct from the real app's own bus connections.
var BUS_NAME = process.env.REEL_SVC_NAME || 'com.webos.app.multiviewsettings-reel';
var PORT = 8791;
var LOG = '/tmp/reel-svc.log';
function log(x) { try { fs.appendFileSync(LOG, Date.now() + ' ' + x + '\n'); } catch (e) {} }

var service = new Service(BUS_NAME);
try { fs.writeFileSync('/tmp/reel-svc.pid', String(process.pid)); } catch (e) {}
log('service starting as ' + BUS_NAME + ' pid=' + process.pid);

// Nothing restarts this process until the next boot, so a stray exception must
// not take picture control away for the rest of the evening: log and carry on.
process.on('uncaughtException', function (e) { log('uncaught ' + (e && e.stack || e)); });

// service.call with a deadline and a normalised reply. The hub can answer late
// or never (settingsservice busy during a signal change), and a luna error must
// reach the app as {returnValue:false} rather than a hung socket. The deadline
// sits under the app's own 6 s fetch timeout (a set is two calls) so the app
// gets a real answer.
var LUNA_TIMEOUT = 2500;
function lcall(uri, params, cb) {
  var fired = false;
  function once(p) { if (!fired) { fired = true; clearTimeout(t); cb(p); } }
  var t = setTimeout(function () {
    log('timeout ' + uri);
    once({ returnValue: false, errorText: 'luna timeout' });
  }, LUNA_TIMEOUT);
  try {
    service.call(uri, params, function (m) {
      once((m && m.payload) || { returnValue: false, errorText: 'empty luna reply' });
    });
  } catch (e) {
    log('call threw ' + uri + ' ' + e.message);
    once({ returnValue: false, errorText: String(e.message || e) });
  }
}

function getPicture(cb) {
  lcall('luna://com.webos.settingsservice/getSystemSettings',
    { category: 'picture', keys: ['pictureMode'] },
    function (p) {
      var mode = p.settings && p.settings.pictureMode;
      cb({ returnValue: !!p.returnValue, pictureMode: mode || null, errorText: p.errorText });
    });
}
function getModes(cb) {
  // Picture modes are dimension-specific: for a Dolby Vision signal only the
  // dolbyHdr* modes are valid, for HDR10 the hdr* ones, for SDR the plain ones.
  // getSystemSettingValues marks the ones valid for the live signal visible:true.
  lcall('luna://com.webos.settingsservice/getSystemSettingValues',
    { category: 'picture', key: 'pictureMode' },
    function (p) {
      var arr = (p.values && p.values.arrayExt) || [];
      if (!Array.isArray(arr)) arr = [];
      var modes = arr.filter(function (x) { return x && x.visible; }).map(function (x) { return x.value; });
      getPicture(function (cur) {
        cb({ returnValue: !!p.returnValue && modes.length > 0,
             current: cur.pictureMode, modes: modes });
      });
    });
}
// Sets run one at a time: two overlapping requests would each read the
// dimension and then race their writes, so the mode the TV ends on could be
// either one. Queued, the last request is the one that sticks — so a waiting
// (not yet running) set is superseded by a newer one instead of running first:
// the queue is at most running + 1, which keeps the newest request's wait under
// two sets (≤ 10 s) however many stacked up, and the app re-checks after its
// own 6 s timeout (setPictureMode in player.svelte.js).
var setQueue = [];
function setPicture(mode, dimOverride, cb) {
  if (typeof dimOverride === 'function') { cb = dimOverride; dimOverride = null; }
  while (setQueue.length > 1) {
    var old = setQueue.pop();
    try { old[2]({ returnValue: false, pictureMode: old[0], errorText: 'superseded' }); } catch (e) {}
  }
  setQueue.push([mode, dimOverride, cb]);
  if (setQueue.length === 1) runSet();
}
function runSet() {
  var job = setQueue[0];
  setPictureNow(job[0], job[1], function (r) {
    setQueue.shift();
    try { job[2](r); } catch (e) { log('set cb threw ' + e.message); }
    if (setQueue.length) runSet();
  });
}
function setPictureNow(mode, dimOverride, cb) {
  // Picture settings are stored per "dimension" (SDR / HDR10 / Dolby Vision ×
  // input). Setting pictureMode without the dimension that matches the live
  // signal fails with "No matched extended item: pictureMode", so read the
  // current dimension first and echo it back (token-agnostic — works for
  // whatever DV/HDR range is on screen).
  lcall('luna://com.webos.settingsservice/getSystemSettings',
    { category: 'picture', keys: ['pictureMode'] },
    function (g) {
      var dim = dimOverride || g.dimension;
      var req = { category: 'picture', settings: { pictureMode: mode } };
      if (dim) req.dimension = dim;
      lcall('luna://com.webos.settingsservice/setSystemSettings', req, function (p) {
        log('set ' + mode + ' dim=' + JSON.stringify(dim) + ' -> ' + JSON.stringify(p.returnValue) + (p.errorText ? ' ' + p.errorText : ''));
        cb({ returnValue: !!p.returnValue, pictureMode: mode,
             dimension: dim || null, errorText: p.errorText });
      });
    });
}

/* loopback HTTP bridge for the file:// web app */
// Setting names are plain identifiers (filmMaker, dolbyHdrCinema, hdr10, …);
// anything else — a repeated ?mode=, junk, an empty value — is refused with a
// 400 before it gets near settingsservice.
var IDENT = /^[A-Za-z0-9_]{1,48}$/;
function one(q, k) { var v = q[k]; return typeof v === 'string' ? v : v == null ? null : false; }

var server = http.createServer(function (req, res) {
  var sent = false;
  function done(obj, code) {
    if (sent) return;
    sent = true;
    try {
      res.statusCode = code || 200;
      res.end(JSON.stringify(obj == null ? { returnValue: false, errorText: 'no reply' } : obj));
    } catch (e) {}
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  try {
    var u = url.parse(req.url, true);
    var q = u.query || {};
    if (u.pathname === '/health') { done({ ok: true, name: BUS_NAME }); return; }
    if (u.pathname === '/modes') { getModes(done); return; }
    if (u.pathname === '/desc') {
      lcall('luna://com.webos.settingsservice/getSystemSettingDesc',
        { category: 'picture', keys: ['pictureMode'] }, done);
      return;
    }
    if (u.pathname === '/picture') {
      var mode = one(q, 'mode');
      if (mode === null || mode === '') { getPicture(done); return; }
      // Optional ?dr=<dynamicRange>&input=<input> forces a dimension (for testing
      // ranges that aren't currently on screen); default auto-detects the live one.
      var dr = one(q, 'dr'), input = one(q, 'input');
      if (!IDENT.test(mode || '') || (dr !== null && !IDENT.test(dr || '')) ||
          (input !== null && !IDENT.test(input || ''))) {
        done({ returnValue: false, errorText: 'bad mode/dr/input' }, 400);
        return;
      }
      var dim = dr ? { input: input || 'default', dynamicRange: dr } : null;
      setPicture(mode, dim, done);
      return;
    }
    done({ error: 'not found' }, 404);
  } catch (e) {
    log('request ' + req.url + ' threw ' + (e && e.stack || e));
    done({ returnValue: false, errorText: 'internal error' }, 500);
  }
});
// A still-dying previous instance can hold the port for a moment after a
// restart (deploy-service.sh kills it with -9): retry the bind instead of
// living on as a bus client with no HTTP. Give up after ~30 s so the next
// boot-hook run can start a clean instance.
var bindTries = 0;
server.on('error', function (e) {
  log('http error ' + e.message);
  if (e.code === 'EADDRINUSE' && ++bindTries <= 30) {
    setTimeout(function () { server.listen(PORT, '127.0.0.1'); }, 1000);
  } else if (e.code === 'EADDRINUSE') {
    log('port ' + PORT + ' still busy, exiting');
    process.exit(1);
  }
});
server.on('listening', function () { log('http listening on 127.0.0.1:' + PORT); });
server.listen(PORT, '127.0.0.1');

// Keep the process alive (the webos-service activity manager would otherwise
// exit an "idle" service; the -k launch flag disables its timeouts, and this
// timer guarantees the event loop never drains).
setInterval(function () {}, 1 << 30);

/* optional startup self-test: REEL_SELFTEST=<mode> */
if (process.env.REEL_SELFTEST) {
  var m = process.env.REEL_SELFTEST;
  getPicture(function (before) {
    log('selftest before=' + JSON.stringify(before));
    setPicture(m, function (r) { log('selftest set ' + m + ' returnValue=' + r.returnValue); });
  });
}
