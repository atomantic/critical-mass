module.exports = {
  apps: [
    {
      name: 'dca-bot',
      script: 'index.js',
      cwd: __dirname,
      cron_restart: '0 10 * * *', // Run daily at 10:00 AM
      autorestart: false, // Don't restart after completion
      watch: false,
      instances: 1,
      env: {
        NODE_ENV: 'production',
      },
      // Logging
      out_file: './logs/dca-out.log',
      error_file: './logs/dca-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      // Process management
      max_memory_restart: '200M',
      kill_timeout: 30000,
    },
    {
      // Optional: Status check that runs every 4 hours
      name: 'dca-status',
      script: 'index.js',
      args: 'status',
      cwd: __dirname,
      cron_restart: '0 */4 * * *', // Every 4 hours
      autorestart: false,
      watch: false,
      instances: 1,
      env: {
        NODE_ENV: 'production',
      },
      out_file: './logs/status-out.log',
      error_file: './logs/status-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
};
