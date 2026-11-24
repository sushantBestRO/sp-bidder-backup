'use strict';
// Route-level test of the engine kill-switch controls. The engine always places real
// bids (no dry-run / go-live mode); the only mode ops are kill and resume. Runs the
// real Express app in mock mode (auth-off) on an ephemeral port and drives the
// endpoints end to end. Memory store so it writes no files.
process.env.STORE_BACKEND = 'memory';
delete process.env.PLATFORM; // mock (default) -> auth-off, engine live

const assert = require('assert');
const http = require('http');
const { app, engine } = require('../src/web/server');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); console.log('  ok  ' + msg); checks++; }

function req(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      {
        host: '127.0.0.1', port, method, path,
        headers: Object.assign(
          { 'content-type': 'application/json', Origin: `http://127.0.0.1:${port}` },
          data ? { 'content-length': Buffer.byteLength(data) } : {},
        ),
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
      },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    // status shape: {mode, killed, killReason, armed} - no live/dryRun mode anywhere.
    let res = await req(server, 'GET', '/api/engine');
    ok(res.status === 200 && res.body.killed === false && res.body.killReason === null,
      'GET /api/engine: not killed at boot');
    ok(typeof res.body.mode === 'string' && 'armed' in res.body && !('live' in res.body) && !('dryRun' in res.body),
      'status carries mode + armed, and NO live/dryRun mode field');

    // the removed dry-run / go-live routes no longer exist
    res = await req(server, 'POST', '/api/engine/golive', { confirm: 'GO LIVE' });
    ok(res.status === 404, 'POST /api/engine/golive removed (404)');
    res = await req(server, 'POST', '/api/engine/dryrun');
    ok(res.status === 404, 'POST /api/engine/dryrun removed (404)');

    // kill halts deterministically
    res = await req(server, 'POST', '/api/engine/kill', { reason: 'test' });
    ok(res.status === 200 && res.body.status.killed === true && engine.killed === true,
      'kill -> killed');
    ok(res.body.status.killReason === 'test', 'kill records the reason');

    // resume lifts the kill and stays live (there is no mode target)
    res = await req(server, 'POST', '/api/engine/resume');
    ok(res.status === 200 && res.body.status.killed === false && engine.killed === false,
      'resume -> not killed (back to live)');

    // resume is idempotent - a second resume on a live engine is a no-op, still not killed
    res = await req(server, 'POST', '/api/engine/resume');
    ok(res.status === 200 && res.body.status.killed === false && engine.killed === false,
      'resume again -> still live, no error');

    console.log(`\n${checks}/${checks} checks passed`);
    server.close();
    process.exit(0);
  } catch (e) {
    server.close();
    console.error('test-engine-control FAILED:', e && e.message);
    process.exit(1);
  }
})().catch((e) => { console.error('test-engine-control FAILED:', e && e.message); process.exit(1); });
