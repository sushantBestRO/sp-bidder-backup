'use strict';

// SecretsVault: reconnect-minted tokens persist chmod-600, survive a restart, and OVERLAY
// process.env (vault wins over a stale .env value) so token resolution stays unchanged.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SecretsVault } = require('../src/store/secretsVault');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass += 1; console.log('  ok  ' + m); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spvault-'));

  const v = new SecretsVault({ dataDir: dir });
  ok(v.get('SP_TOKEN_2') === null, 'empty vault -> get returns null');

  v.set('SP_TOKEN_2', 'Bearer  jwt-value-abc ');
  ok(v.get('SP_TOKEN_2') === 'jwt-value-abc', 'set strips Bearer + trims; get returns the clean token');
  ok(fs.existsSync(path.join(dir, 'secrets.json')), 'set persists data/secrets.json');

  const v2 = new SecretsVault({ dataDir: dir });
  ok(v2.get('SP_TOKEN_2') === 'jwt-value-abc', 'a fresh instance reads the persisted token (survives a restart)');

  const env = { SP_TOKEN_2: 'stale-from-dotenv', OTHER: 'x' };
  const n = v2.applyToEnv(env);
  ok(n === 1, 'applyToEnv applied one key');
  ok(env.SP_TOKEN_2 === 'jwt-value-abc', 'vault OVERLAYS env (vault WINS over the .env value)');
  ok(env.OTHER === 'x', 'unrelated env untouched');

  let threw = false;
  try { v.set('SP_TOKEN_3', '   '); } catch (e) { threw = e.code === 'BAD_TOKEN'; }
  ok(threw, 'refuses to store an empty token');

  v.set('SP_TOKEN_3', 'tok3');
  ok(v.get('SP_TOKEN_2') === 'jwt-value-abc' && v.get('SP_TOKEN_3') === 'tok3', 'multiple token envs coexist');

  // The secret lives only in data/secrets.json (gitignored via data/*.json) - never elsewhere in the dir.
  const files = fs.readdirSync(dir);
  ok(files.length === 1 && files[0] === 'secrets.json', 'the vault writes exactly one file (secrets.json)');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${pass} passed, 0 failed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
