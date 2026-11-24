'use strict';
/**
 * Only a quote the write path could price is ever cached as the prepared quote.
 *
 * The prepared-quote fast path (T2b, ruling 61) sends the PUT alone at fire, so a cached document is
 * written back without a fresh read. A document with no quote id, or with no freight-charge container,
 * cannot be written: caching one would spend the buzzer shot on a PUT that fails. The shape guard was
 * pinned only for well-formed quotes (PR-2 mutation critique).
 *
 *   node scripts/test-gocomet-prepared-quote-shape-guard.js
 */
for (const k of Object.keys(process.env)) if (/^GC_/.test(k)) delete process.env[k];
const assert = require('assert');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const token = `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 86_400, user_id: 'u1' })}.sig`;
const FREIGHT = 'freight_charges_custom_charge_40ft';
const quoteDoc = (id) => ({
  id,
  charges_list: { '11_freight_charges': { [FREIGHT]: { units: 1, unit_name: 'TRUCK', price: 42000 } } },
  total_charges: { total: { units: 1.0, quote_units: 1.0, unit_name: 'TRUCK', total: 42000 } },
});

let pass = 0;
const ok = (n, m) => { console.log(`  ok  ${n}. ${m}`); pass++; };

const a = new GoCometAdapter({ token, bidEnabled: true, fetchImpl: async () => ({ status: 404, headers: { get: () => null }, text: async () => '{}' }), sleep: async () => {} });
assert.strictEqual(a._quoteIsCacheable(quoteDoc('Q1'), 'K1'), true, 'setup: a well-formed quote is not cacheable');

const noId = quoteDoc('Q1');
delete noId.id;
assert.strictEqual(a._quoteIsCacheable(noId, 'K1'), false, 'a quote with no id was accepted for the prepared cache');
ok(1, 'a quote with no id is never cached');

const noFreight = { id: 'Q2', charges_list: {}, total_charges: quoteDoc('Q2').total_charges };
assert.strictEqual(a._quoteIsCacheable(noFreight, 'K1'), false, 'a quote with no freight container was accepted for the prepared cache');
ok(2, 'a quote with no freight-charge container is never cached');

console.log(`\n${pass}/2 checks passed`);
