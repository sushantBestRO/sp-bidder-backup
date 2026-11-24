'use strict';
// Seed demo "Recent alerts sent" rows so the Notifications panel isn't empty in a demo.
// Appends to the store's `notifications` event stream - the exact shape the notifier writes on a
// real send - so it shows up in the console with no code path faked. Backdated over ~2 days.
// Re-running adds another batch; to reset, delete data/logs/notifications-*.jsonl.
//
//   node scripts/seed-alerts-demo.js
const path = require('path');
const config = require('../src/config');
const { createStore } = require('../src/store');

const H = 3600_000;
// [hoursAgo, kind, recipientName, phone, ok, error?]
const DEMO = [
  [1, 'price_needed', 'Pricing desk', '+919000000002', true],
  [3, 'outbid', 'Pricing desk', '+919000000002', true],
  [5, 'won', 'Suyashh', '+919000000001', true],
  [8, 'lost', 'Suyashh', '+919000000001', true],
  [10, 'error', 'Suyashh', '+919000000001', false, 'template not approved'],
  [26, 'price_needed', 'Pricing desk', '+919000000002', true],
  [28, 'won', 'Suyashh', '+919000000001', true],
  [30, 'outbid', 'Pricing desk', '+919000000002', true],
  [33, 'bid_live', 'Suyashh', '+919000000001', true],
  [34, 'lost', 'Suyashh', '+919000000001', true],
  [50, 'price_needed', 'Pricing desk', '+919000000002', false, 'http 500'],
  [52, 'won', 'Suyashh', '+919000000001', true],
];

async function main() {
  const store = createStore({ dataDir: config.dataDir, logDir: path.join(config.dataDir, 'logs'), backend: config.storeBackend });
  const now = Date.now();
  for (const [hoursAgo, kind, name, to, ok, error] of DEMO) {
    await store.appendEvent('notifications', {
      ts: now - hoursAgo * H,
      kind, to, name,
      ok,
      error: ok ? null : error || 'unknown',
      messageId: ok ? 'demo-' + Math.random().toString(36).slice(2, 10) : null,
    });
  }
  console.log(`Seeded ${DEMO.length} demo alerts into the notifications stream (${path.join(config.dataDir, 'logs')}).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
