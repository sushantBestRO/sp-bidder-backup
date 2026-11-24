// PM2 process definition for the SuperProcure auto-bidder.
//
// CO-TENANT SAFETY: this host runs other PM2 apps too. This file declares ONLY the
// bid-command process, so `pm2 start ecosystem.config.cjs` never touches anything else.
// Always operate on it BY NAME:
//     pm2 restart bid-command    pm2 logs bid-command    pm2 stop bid-command
// NEVER `pm2 restart all` / `pm2 delete all` on a shared box.
//
// SECRETS ARE NOT HERE. The SuperProcure token and any keys live in an on-box .env
// (chmod 600, gitignored), loaded by the app via dotenv. This file sets only
// non-secret runtime defaults.
module.exports = {
  apps: [
    {
      name: 'bid-command',
      script: 'src/web/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',            // single process: the engine holds in-memory auction state
      autorestart: true,
      max_restarts: 10,
      min_uptime: '20s',
      max_memory_restart: '500M',   // headroom guard on a shared VPS
      env: {
        NODE_ENV: 'production',
        // SuperProcure datetimes may lack a timezone offset; Date.parse reads those in the
        // process TZ. Pin IST (SP's zone, and the zone the live captures were verified in) so
        // a UTC box can't shift every auction countdown by 5.5h. Harmless if SP sends offsets.
        TZ: process.env.TZ || 'Asia/Kolkata',
        // PLATFORM deliberately NOT set here. PM2 env wins over dotenv (dotenv never
        // overrides an already-set var), so a 'real' fallback here would silently flip a
        // mock/demo box to real on any start/startOrReload that re-reads this file.
        // PLATFORM comes from the on-box .env only; absent -> the app defaults to mock,
        // which is the fail-safe direction (mock can never place a real bid).
        HOST: process.env.HOST || '127.0.0.1',    // loopback only - the reverse proxy is the front door
        PORT: process.env.PORT || '4103',
      },
      time: true,                   // timestamp PM2 logs
      out_file: 'data/logs/pm2-out.log',
      error_file: 'data/logs/pm2-err.log',
    },
  ],
};
