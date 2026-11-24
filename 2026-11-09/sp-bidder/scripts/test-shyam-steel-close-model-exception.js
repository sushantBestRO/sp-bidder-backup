'use strict';

const assert = require('assert');
const { DiscoveryPoller } = require('../src/discovery/discovery');

const makePoller = (shippers, lanes = []) => new DiscoveryPoller({
  adapter: {},
  requests: {},
  notifier: {},
  config: {
    allowlist: { shippers, lanes, hardCloseOnly: true },
    softClose: { enabled: false, shippers: [] },
  },
});

const poller = makePoller(['Shyam Steel', 'Syngenta']);

const load = (companyName, extra = {}) => ({
  companyName,
  lane: { origin: 'A', destination: 'B' },
  softClose: false,
  closeModelKnown: true,
  ...extra,
});

const checks = [
  ['Shyam Steel hard-close admitted',
    poller.matchesAllowlist(load('Shyam Steel Ltd')) === true],
  ['Shyam Steel soft-close admitted',
    poller.matchesAllowlist(load('Shyam Steel Ltd', { softClose: true })) === true],
  ['Shyam Steel unknown-close admitted',
    poller.matchesAllowlist(load('Shyam Steel Ltd', { closeModelKnown: false })) === true],
  ['Syngenta hard-close remains admitted',
    poller.matchesAllowlist(load('Syngenta India Ltd')) === true],
  ['Syngenta soft-close remains rejected',
    poller.matchesAllowlist(load('Syngenta India Ltd', { softClose: true })) === false],
  ['Syngenta unknown-close remains rejected',
    poller.matchesAllowlist(load('Syngenta India Ltd', { closeModelKnown: false })) === false],
  ['Unlisted shipper remains rejected',
    poller.matchesAllowlist(load('Other Steel Ltd')) === false],
  ['Shyam Enterprises does not get the exception',
    poller.matchesAllowlist(load('Shyam Enterprises', { closeModelKnown: false })) === false],
  ['Shyam Steel outside the configured lane remains rejected',
    makePoller(['Shyam Steel'], ['X Y']).matchesAllowlist(load('Shyam Steel Ltd', {
      softClose: true,
      lane: { origin: 'A', destination: 'B' },
    })) === false],
  ['Shyam Steel excluded by hard allowlist remains rejected',
    makePoller(['Syngenta']).matchesAllowlist(load('Shyam Steel Ltd', {
      closeModelKnown: false,
    })) === false],
];

let failed = 0;
for (const [description, passed] of checks) {
  if (passed) console.log('  PASS -', description);
  else {
    failed++;
    console.error('  FAIL -', description);
  }
}

console.log(`\n${checks.length - failed}/${checks.length} Shyam Steel exception checks passed`);
if (failed) process.exit(1);
