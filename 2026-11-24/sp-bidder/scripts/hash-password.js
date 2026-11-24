'use strict';
/**
 * Generate the admin password hash for the .env. The plaintext is never stored.
 *   node scripts/hash-password.js 'the-password'
 *   node scripts/hash-password.js            # then type it at the prompt (not echoed to argv/history)
 * Copy the printed SP_ADMIN_PASS_HASH=... line into the on-box .env (chmod 600).
 */
const { hashPassword } = require('../src/auth/adminAuth');

function emit(pw) {
  if (!pw || !pw.trim()) { console.error('empty password - nothing generated'); process.exit(1); }
  console.log(`SP_ADMIN_PASS_HASH=${hashPassword(pw.trim())}`);
}

const arg = process.argv[2];
if (arg) { emit(arg); }
else {
  process.stdout.write('Password: ');
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { buf += d; });
  process.stdin.on('end', () => emit(buf.replace(/\r?\n$/, '')));
}
