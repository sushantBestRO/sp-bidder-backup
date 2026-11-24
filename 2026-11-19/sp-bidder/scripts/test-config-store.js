'use strict';
/**
 * ConfigStore test (deterministic, offline): defaults seeding, partial-merge save,
 * persistence across instances, recipient sanitization, and validation rejects.
 * Uses the memory store.
 */
const { createStore } = require('../src/store');
const { ConfigStore, defaultsFrom, validate, merge } = require('../src/admin/configStore');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const baseConfig = {
  marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3,
  allowlist: { shippers: [], lanes: [], hardCloseOnly: false },
  discoveryIntervalMs: 30000, priceDeadlineLeadMs: 35000, reminderLeadMs: 60000, notifyMode: 'dashboard',
};

(async () => {
  const defaults = defaultsFrom(baseConfig);
  ok(JSON.stringify(defaults.marginsPct) === JSON.stringify([12.6, 7.2, 6.3]), 'defaultsFrom carries margins');
  ok(defaults.recipients.length === 0, 'defaults recipients empty');

  const store = createStore({ backend: 'memory' });
  const cs = new ConfigStore({ store, defaults });

  const g0 = await cs.get();
  ok(g0.notifyMode === 'dashboard' && g0.allowlist.hardCloseOnly === false, 'first get returns defaults');

  // anti-detection ("human-like" cadence) defaults + merge + bounds
  ok(g0.antiDetection.enabled === true && g0.antiDetection.cadenceJitterMs === 250
    && g0.antiDetection.maxBidsPerMin === 20 && g0.antiDetection.minInterFireMs === 150,
    'defaults carry the anti-detection block (fallback when config omits it)');
  ok(g0.antiDetection.openJitterMs === 4000, 'defaults carry the establish-jitter (openJitterMs) knob');

  const sAd = await cs.save({ antiDetection: { enabled: false } });
  ok(sAd.antiDetection.enabled === false && sAd.antiDetection.cadenceJitterMs === 250,
    'partial antiDetection merges: toggle off preserves the other knobs');

  const badAd = (ad) => { try { validate(merge(defaults, { antiDetection: ad })); return null; } catch (e) { return e.code; } };
  ok(badAd({ cadenceJitterMs: 99999 }) === 'BAD_INPUT', 'jitter above the hard cap rejected');
  ok(badAd({ openJitterMs: 99999 }) === 'BAD_INPUT', 'establish-jitter above the hard cap rejected');
  ok(badAd({ maxBidsPerMin: 3 }) === 'BAD_INPUT', 'maxBidsPerMin below the 6-rung floor rejected');
  // minInterFireMs is capped at the 150ms hot-poll ceiling (was 1000ms): a value above it could
  // delay/skip the last-chance floor shot, so the whole 151-999 range the OLD cap allowed must now
  // be rejected. Pin the boundary and a mid-range value so a regression widening the cap back
  // toward 1s fails here.
  ok(badAd({ minInterFireMs: 5000 }) === 'BAD_INPUT', 'min inter-fire well above the 150ms hot-poll ceiling rejected');
  ok(badAd({ minInterFireMs: 151 }) === 'BAD_INPUT', 'min inter-fire just above the 150ms ceiling rejected (was valid under the old 1s cap)');
  ok(badAd({ minInterFireMs: 500 }) === 'BAD_INPUT', 'min inter-fire mid old-range (151-999) rejected (would delay the floor snipe)');
  ok(badAd({ minInterFireMs: 150 }) === null, 'min inter-fire exactly at the 150ms ceiling accepted');
  ok(badAd({ cadenceJitterMs: 250, openJitterMs: 4000, maxBidsPerMin: 20, minInterFireMs: 150 }) === null, 'in-bounds anti-detection accepted');

  const s1 = await cs.save({ allowlist: { shippers: ['Syngenta'], hardCloseOnly: true } });
  ok(s1.allowlist.shippers[0] === 'Syngenta' && s1.allowlist.hardCloseOnly === true, 'partial allowlist saved');
  ok(JSON.stringify(s1.marginsPct) === JSON.stringify([12.6, 7.2, 6.3]), 'unspecified fields preserved on partial save');
  ok(s1.allowlist.lanes.length === 0, 'unspecified allowlist sub-field preserved');

  const cs2 = new ConfigStore({ store, defaults });
  const g1 = await cs2.get();
  ok(g1.allowlist.shippers[0] === 'Syngenta', 'config persisted to the store (fresh instance reads it)');

  const s2 = await cs.save({ recipients: [{ name: 'Suyashh', phone: '9820098200', alerts: ['won', 'bogus'] }] });
  ok(s2.recipients[0].alerts.length === 1 && s2.recipients[0].alerts[0] === 'won', 'unknown alert kind dropped on save');
  ok(s2.recipients[0].phone === '+919820098200', 'recipient phone normalized to +91XXXXXXXXXX on save');

  // Phone is the required field; the name is an optional label.
  const s3 = await cs.save({ recipients: [{ phone: '+91 98200 98200', alerts: ['won'] }] });
  ok(s3.recipients[0].name === '' && s3.recipients[0].phone === '+919820098200', 'recipient saves phone-only (name optional), phone normalized');

  const bad = (partial) => { try { validate(merge(defaults, partial)); return null; } catch (e) { return e.code; } };
  ok(bad({ marginsPct: [] }) === 'BAD_INPUT', 'empty marginsPct rejected');
  ok(bad({ minMarginPct: -1 }) === 'BAD_INPUT', 'negative minMarginPct rejected');
  ok(bad({ discoveryIntervalMs: 100 }) === 'BAD_INPUT', 'too-small discoveryIntervalMs rejected');
  ok(bad({ priceDeadlineLeadMs: -1 }) === 'BAD_INPUT', 'negative priceDeadlineLeadMs rejected');
  ok(bad({ reminderLeadMs: -1 }) === 'BAD_INPUT', 'negative reminderLeadMs rejected');
  ok(g0.reminderLeadMs === 60000, 'defaults carry reminderLeadMs');
  {
    const s4 = await cs.save({ reminderLeadMs: 45000 });
    ok(s4.reminderLeadMs === 45000, 'reminderLeadMs saves via partial merge');
  }
  ok(bad({ notifyMode: 'sms' }) === 'BAD_INPUT', 'unknown notifyMode rejected');
  ok(bad({ recipients: [{ phone: '1' }] }) === 'BAD_INPUT', 'recipient with an invalid phone rejected');
  ok(bad({ recipients: [{ name: 'No Phone' }] }) === 'BAD_INPUT', 'recipient without a phone rejected');
  ok(bad({ recipients: [{ phone: '5820098200' }] }) === 'BAD_INPUT', 'phone not starting 6-9 rejected');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
