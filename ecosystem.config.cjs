module.exports = {
  apps: [{
    name: 'farmenta-backend',
    cwd: __dirname,
    script: 'bun',
    args: 'run src/main.ts',
    interpreter: 'none',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    exp_backoff_restart_delay: 2000,
    max_memory_restart: '512M',
    time: true,
  }],
};
