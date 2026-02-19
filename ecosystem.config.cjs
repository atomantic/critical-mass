// =============================================================================
// Port Configuration - All ports defined here as single source of truth
// =============================================================================
const PORTS = {
  API: 5563,           // Express API server + static admin UI (gateway)
  UI: 5564,            // Vite dev server (admin UI development)
  KALSHI_HTTP: 5572,   // Kalshi+Hedge engine REST API
  KALSHI_IPC: 5573,    // Kalshi+Hedge engine IPC WebSocket
  COINBASE_IPC: 5570,  // Coinbase engine IPC WebSocket (Phase 3)
  GEMINI_IPC: 5571,    // Gemini engine IPC WebSocket (Phase 4)
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
        KALSHI_HTTP_PORT: PORTS.KALSHI_HTTP,
        KALSHI_IPC_PORT: PORTS.KALSHI_IPC,
        COINBASE_IPC_PORT: PORTS.COINBASE_IPC,
        NODE_OPTIONS: '--dns-result-order=ipv4first', // Force IPv4 for API stability (IPv6 rotates)
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: PORTS.API,
        KALSHI_HTTP_PORT: PORTS.KALSHI_HTTP,
        KALSHI_IPC_PORT: PORTS.KALSHI_IPC,
        COINBASE_IPC_PORT: PORTS.COINBASE_IPC,
        NODE_OPTIONS: '--dns-result-order=ipv4first',
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      max_memory_restart: '512M',
      out_file: './logs/critical-mass-out.log',
      error_file: './logs/critical-mass-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
    {
      name: 'critical-mass-kalshi',
      script: 'engines/kalshi-engine.js',
      cwd: __dirname,
      interpreter: 'node',
      env: {
        NODE_ENV: 'development',
        KALSHI_HTTP_PORT: PORTS.KALSHI_HTTP,
        KALSHI_IPC_PORT: PORTS.KALSHI_IPC,
        NODE_OPTIONS: '--dns-result-order=ipv4first',
      },
      env_production: {
        NODE_ENV: 'production',
        KALSHI_HTTP_PORT: PORTS.KALSHI_HTTP,
        KALSHI_IPC_PORT: PORTS.KALSHI_IPC,
        NODE_OPTIONS: '--dns-result-order=ipv4first',
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      max_memory_restart: '1G',
      out_file: './logs/critical-mass-kalshi-out.log',
      error_file: './logs/critical-mass-kalshi-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
    {
      name: 'critical-mass-coinbase',
      script: 'engines/coinbase-engine.js',
      cwd: __dirname,
      interpreter: 'node',
      env: {
        NODE_ENV: 'development',
        COINBASE_IPC_PORT: PORTS.COINBASE_IPC,
        NODE_OPTIONS: '--dns-result-order=ipv4first',
      },
      env_production: {
        NODE_ENV: 'production',
        COINBASE_IPC_PORT: PORTS.COINBASE_IPC,
        NODE_OPTIONS: '--dns-result-order=ipv4first',
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      max_memory_restart: '512M',
      out_file: './logs/critical-mass-coinbase-out.log',
      error_file: './logs/critical-mass-coinbase-error.log',
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
