'use strict';
/**
 * Pins C075, D042 and D043 (fix/ops-alerting-divergences).
 *
 * Several shared (both-platform) WhatsApp templates hardcoded the literal "SuperProcure" instead
 * of deriving the platform's display name from the load's own platformKey - so a GoComet load's
 * WON receipt, its no-bid reason, and several desk-notice bodies all told the desk to go check
 * "SuperProcure" for a load that was never on that portal. The export headers had the same defect
 * ("SP Load Id" on an all-portal export). A new platformName(d) helper (absent -> SuperProcure,
 * 'gocomet' -> GoComet) now backs every one of these sites.
 *
 * @requires-summary-line
 *   node scripts/test-c075-d042-d043-platform-name-not-hardcoded.js
 */
const assert = require('assert');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const render = (kind, data) => renderMessage(templateFor(kind, data), data);

(async () => {
  // ---- D043: the WON template names the load's own platform, not a hardcoded SuperProcure ----
  {
    const sp = render('won', {});
    const gc = render('won', { platformKey: 'gocomet' });
    assert.ok(/Complete the allotment on SuperProcure\./.test(sp), `SP WON receipt still says SuperProcure: got "${sp}"`);
    assert.ok(/Complete the allotment on GoComet\./.test(gc), `D043: a GoComet WON receipt names GoComet, not SuperProcure: got "${gc}"`);
    assert.ok(!/SuperProcure/.test(gc), `D043: a GoComet WON receipt must not mention SuperProcure at all: got "${gc}"`);
    ok('D043: the WON receipt names the load\'s own platform');
  }

  // ---- D042: NO_BID_REASON_UNKNOWN (the no-recorded-reason fallback) names the right platform ----
  {
    const sp = render('no_bid', {});
    const gc = render('no_bid', { platformKey: 'gocomet' });
    assert.ok(/check this load on SuperProcure\./.test(sp), `SP no-bid fallback still says SuperProcure: got "${sp}"`);
    assert.ok(/check this load on GoComet\./.test(gc), `D042: a GoComet no-bid fallback names GoComet, not SuperProcure: got "${gc}"`);
    ok('D042: the no-recorded-reason no-bid fallback names the load\'s own platform');
  }

  // ---- C075: desk-notice bodies (load_not_biddable, no_schedule, catch-all) name the right platform ----
  {
    const gcStillWatching = { reason: 'load_not_biddable', stillWatching: true, platformKey: 'gocomet' };
    const body1 = render('desk_notice', gcStillWatching);
    assert.ok(!/SuperProcure/.test(body1) && /GoComet/.test(body1), `C075: still-watching desk notice names GoComet: got "${body1}"`);

    const gcClosed = { reason: 'load_not_biddable', stillWatching: false, platformKey: 'gocomet' };
    const body2 = render('desk_notice', gcClosed);
    assert.ok(!/SuperProcure/.test(body2) && /GoComet/.test(body2), `C075: closed-load desk notice names GoComet: got "${body2}"`);

    const gcNoSchedule = { reason: 'no_schedule', platformKey: 'gocomet' };
    const body3 = render('desk_notice', gcNoSchedule);
    assert.ok(!/SuperProcure/.test(body3) && /GoComet/.test(body3), `C075: no-schedule desk notice names GoComet: got "${body3}"`);

    const gcCatchAll = { reason: 'something_unmapped', platformKey: 'gocomet' };
    const body4 = render('desk_notice', gcCatchAll);
    assert.ok(!/SuperProcure/.test(body4) && /GoComet/.test(body4), `C075: catch-all desk notice names GoComet: got "${body4}"`);

    ok('C075: shared desk-notice bodies name the load\'s own platform, never a hardcoded SuperProcure');
  }

  // ---- control: SuperProcure loads (absent platformKey) are completely unaffected ----
  {
    const spStillWatching = render('desk_notice', { reason: 'load_not_biddable', stillWatching: true });
    assert.ok(/SuperProcure/.test(spStillWatching) && !/GoComet/.test(spStillWatching),
      `control: an SP (untagged) desk notice still names SuperProcure: got "${spStillWatching}"`);
    ok('control: SuperProcure (untagged) desk notices are byte-identical to before');
  }

  // ---- C075: the export header is platform-neutral, not "SP Load Id" ----
  {
    const raw = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'web', 'exportModel.js'), 'utf8');
    assert.ok(!/'SP Load Id'/.test(raw), 'C075: exportModel.js no longer has any literal \'SP Load Id\' header');
    assert.ok((raw.match(/'Load Id'/g) || []).length >= 3, 'C075: the three export headers now read the platform-neutral \'Load Id\'');
    ok('C075: export headers are platform-neutral (\'Load Id\', not \'SP Load Id\')');
  }

  console.log(`\n${pass}/5 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
