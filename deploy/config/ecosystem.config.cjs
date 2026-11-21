// PM2 process list for Laytekz on the server. Started by setup.sh, resurrected at
// boot by the @reboot crontab entry (libexec/resurrect.sh). No secrets here:
// the launchers load the env files after PM2 has started them.
//
//   pm2 start  ~/galley-server/bin/config/ecosystem.config.cjs
//   pm2 status / pm2 restart galley-app / pm2 logs galley-compiler
const path = require('path');

const ROOT = process.env.GALLEY_ROOT || path.join(process.env.HOME, 'galley-server');
const LOGS = path.join(ROOT, 'logs');
const BIN = path.join(ROOT, 'bin');

const common = {
  interpreter: 'none',          // the scripts exec their program themselves
  autorestart: true,
  // Crash loop: wait 1 s before the first restart, growing to 15 s while it
  // keeps failing; the delay resets once a process stays up for 30 s.
  exp_backoff_restart_delay: 1000,
  min_uptime: 10000,
  max_restarts: 100000,         // never give up (a boot without network, say)
  kill_signal: 'SIGTERM',
  time: true,                   // timestamp every log line
  merge_logs: true,
};

const logs = (name) => ({
  out_file: path.join(LOGS, `${name}.log`),
  error_file: path.join(LOGS, `${name}.log`),
});

module.exports = {
  apps: [
    {
      ...common,
      ...logs('app'),
      name: 'galley-app',
      script: path.join(BIN, 'libexec/run-app.sh'),
      // On SIGTERM the server writes every open document and commits it;
      // give it time before PM2 falls back to SIGKILL.
      kill_timeout: 20000,
    },
    {
      ...common,
      ...logs('compiler'),
      name: 'galley-compiler',
      script: path.join(BIN, 'libexec/run-compiler.sh'),
      kill_timeout: 5000,
    },
    {
      ...common,
      ...logs('tunnel'),
      name: 'galley-tunnel',
      script: '/usr/local/bin/cloudflared',
      args: ['tunnel', '--config', path.join(ROOT, 'cloudflared/config.yml'), '--no-autoupdate', 'run'],
      kill_timeout: 15000,
    },
  ],
};
