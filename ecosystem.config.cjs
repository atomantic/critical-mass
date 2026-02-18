// =============================================================================
// Port Configuration - All ports defined here as single source of truth
// =============================================================================
const PORTS = {
  API: 5563,           // Express API server + static admin UI
  UI: 5564,            // Vite dev server (admin UI development)
};

module.exports = {
  PORTS, // Export for other configs to reference

  apps: [
    {
      name: 'critical-mass',
      script: 'server.js',
      cwd: __dirname,
      interpreter: 'node',
      env: {
        NODE_ENV: 'development',
        PORT: PORTS.API,
        NODE_OPTIONS: '--dns-result-order=ipv4first', // Force IPv4 for API stability (IPv6 rotates)
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: PORTS.API,
        NODE_OPTIONS: '--dns-result-order=ipv4first',
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      max_memory_restart: '1G',
      out_file: './logs/critical-mass-out.log',
      error_file: './logs/critical-mass-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
    {
      name: 'critical-mass-ui',
      script: `${__dirname}/admin/node_modules/.bin/vite`,
      cwd: `${__dirname}/admin`,
      args: `--host 0.0.0.0 --port ${PORTS.UI}`,
      env: {
        NODE_ENV: 'development',
        VITE_PORT: PORTS.UI,
        VITE_API_PORT: PORTS.API,
      },
      watch: false,
      autorestart: true,
      max_restarts: 5,
      min_uptime: '10s',
    }
  ]
};
