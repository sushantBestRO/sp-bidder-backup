'use strict';
// @requires-summary-line
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { MemoryStore } = require('../src/store/memoryStore');

const stopped = { name: 'bid-command', pm2_env: { status: 'stopped' } };
const online = { name: 'bid-command', pm2_env: { status: 'online' } };
const filename = path.join(__dirname, 'backfill-request-dimensions.js');
const source = fs.readFileSync(filename, 'utf8');
const record = { id: 'fixture-token', platformKey: 'gocomet', loadId: 'fixture-load',
  status: 'closed', capturedAt: 123, load: { equipment: '40 ft', dimensions: null } };
const dimensions = [{ id: 'fixture-load', platformKey: 'gocomet', equipment: '40 ft', dimensions: '40 x 8 x 9 ft' }];

async function scenario(processSnapshots, args) {
  const store = new MemoryStore();
  await store.putDoc('priceRequests', record.id, structuredClone(record));
  let writes = 0, checks = 0;
  const patch = store.patchDoc.bind(store);
  store.patchDoc = async (...params) => { writes += 1; return patch(...params); };
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = function (id) {
    if (id === 'fs') return { readFileSync: () => JSON.stringify(dimensions) };
    if (id === 'child_process') return { execFileSync: () => {
      const value = processSnapshots[Math.min(checks, processSnapshots.length - 1)];
      checks += 1;
      return JSON.stringify(value);
    } };
    if (id === '../src/store') return { createStore: () => store };
    return Module.prototype.require.call(this, id);
  };
  loaded._compile(source, filename);
  const previous = console.log;
  console.log = () => {};
  let error;
  try { await loaded.exports.main(['--source-file=fixture.json', '--data-dir=fixture', ...args]); }
  catch (caught) { error = caught; }
  finally { console.log = previous; }
  return { writes, checks, error, record: await store.getDoc('priceRequests', record.id) };
}

(async () => {
  let passed = 0;
  const cases = [
    [[], 'no registered app'],
    [[online], 'one online app'],
    [[stopped, online], 'stopped duplicate before online app'],
  ];
  for (const [processes, label] of cases) {
    const result = await scenario([processes], ['--apply', '--expect=1']);
    assert.ok(result.error, label + ' must refuse');
    assert.strictEqual(result.writes, 0, label + ' must write nothing');
    assert.deepStrictEqual(result.record, record);
    passed += 1;
  }
  const restarted = await scenario([[stopped], [online]], ['--apply', '--expect=1']);
  assert.ok(restarted.error, 'an app restarted during planning must refuse before writing');
  assert.strictEqual(restarted.writes, 0);
  passed += 1;
  const allowed = await scenario([[stopped, stopped]], ['--apply', '--expect=1']);
  assert.ifError(allowed.error);
  assert.strictEqual(allowed.writes, 1);
  assert.strictEqual(allowed.record.load.dimensions, dimensions[0].dimensions);
  assert.ok(allowed.checks >= 2, 'maintenance state must be rechecked before writes');
  passed += 1;
  const dry = await scenario([[online]], []);
  assert.ifError(dry.error);
  assert.strictEqual(dry.writes, 0);
  assert.strictEqual(dry.checks, 0, 'dry run needs no maintenance outage');
  passed += 1;
  console.log(`${passed}/6 checks passed`);
})().catch(error => { console.error('FAIL: maintenance guard', error); process.exitCode = 1; });
