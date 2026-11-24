'use strict';

// Offline metadata refresh. Stop bid-command and back up priceRequests.json before applying.
const fs = require('fs'); // operator-supplied source file only; application state uses the store
const { execFileSync } = require('child_process');
const { createStore } = require('../src/store');
const { planDimensionRefresh } = require('../src/pricing/requestDimensions');

function requireStoppedApp() {
  let processes;
  try { processes = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8' })); }
  catch (_) { throw new Error('cannot verify PM2 state; nothing written'); }
  const apps = Array.isArray(processes) && processes.filter(process => process.name === 'bid-command');
  if (!apps || !apps.length || apps.some(app => !app.pm2_env || app.pm2_env.status !== 'stopped')) {
    throw new Error('all bid-command instances must be stopped before applying; nothing written');
  }
}

async function main(argv) {
  const options = { apply: false };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg.startsWith('--source-file=')) options.file = arg.slice('--source-file='.length);
    else if (arg.startsWith('--data-dir=')) options.dataDir = arg.slice('--data-dir='.length);
    else if (arg.startsWith('--expect=')) options.expect = arg.slice('--expect='.length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.file) throw new Error('--source-file=<normalized portal loads.json> is required');
  if (options.apply) {
    if (!/^\d+$/.test(options.expect || '')) throw new Error('--apply requires --expect=<planned count>');
    requireStoppedApp();
  }
  const sources = JSON.parse(fs.readFileSync(options.file, 'utf8'));
  const dataDir = options.dataDir || require('../src/config').dataDir;
  const store = createStore({ backend: 'file', dataDir });
  const records = await store.listDocs('priceRequests');
  const changes = planDimensionRefresh(records, sources);
  console.log(JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', count: changes.length,
    loads: changes.map(change => ({ platformKey: change.platformKey, loadId: change.loadId })) }));
  if (!options.apply) return;
  if (Number(options.expect) !== changes.length) throw new Error('planned count changed; nothing written');
  requireStoppedApp();
  for (const change of changes) {
    const record = records.find(row => row.id === change.id);
    await store.patchDoc('priceRequests', change.id, { load: change.afterLoad,
      __expect: { loadId: record.loadId, status: record.status, capturedAt: record.capturedAt } });
  }
  console.log(JSON.stringify({ applied: changes.length }));
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
