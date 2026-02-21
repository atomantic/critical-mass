/**
 * Alert Service
 * Sends alerts via Socket.IO and optional Slack webhook.
 * Fire-and-forget — webhook failures never block trading logic.
 */

const { ts } = require('../../time-utils')

/** @type {string} */
let webhookUrl = ''

/** @type {import('socket.io').Server | null} */
let io = null

/** @type {Array<{ level: string, title: string, details: Object, timestamp: string }>} */
const recentAlerts = []

/**
 * Initialize the alert service
 * @param {{ webhookUrl?: string, io?: import('socket.io').Server }} opts
 */
const initAlertService = ({ webhookUrl: url, io: ioServer } = {}) => {
  webhookUrl = url || ''
  io = ioServer || null
  console.log(`[${ts()}] 🔔 Alert service initialized (webhook: ${webhookUrl ? 'configured' : 'none'})`)
}

/**
 * Send an alert — logs, emits via Socket.IO, and POSTs to Slack webhook
 * @param {'info' | 'warning' | 'critical'} level
 * @param {string} title
 * @param {Object} [details]
 */
const sendAlert = (level, title, details = {}) => {
  const emoji = level === 'critical' ? '🚨' : level === 'warning' ? '⚠️' : 'ℹ️'
  console.log(`[${ts()}] ${emoji} ALERT [${level}]: ${title}`)

  const alert = { level, title, details, timestamp: new Date().toISOString() }

  recentAlerts.push(alert)
  if (recentAlerts.length > 50) recentAlerts.shift()

  if (io) {
    io.emit('kalshi:alert', alert)
  }

  if (webhookUrl) {
    const payload = {
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `${emoji} ${title}` }
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Level:*\n${level}` },
            { type: 'mrkdwn', text: `*Time:*\n${alert.timestamp}` },
            ...Object.entries(details).slice(0, 8).map(([k, v]) => ({
              type: 'mrkdwn',
              text: `*${k}:*\n${typeof v === 'object' ? JSON.stringify(v) : String(v)}`
            }))
          ]
        }
      ]
    }

    fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(err => {
      console.log(`[${ts()}] ⚠️ Webhook POST failed: ${err.message}`)
    })
  }
}

/**
 * Get recent alerts for dashboard
 * @returns {Array<{ level: string, title: string, details: Object, timestamp: string }>}
 */
const getRecentAlerts = () => recentAlerts.slice()

module.exports = {
  initAlertService,
  sendAlert,
  getRecentAlerts
}
