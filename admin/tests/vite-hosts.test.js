import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import { createServer } from 'vite'

describe('Vite dev server host allowlist', () => {
  let server
  let baseUrl

  beforeAll(async () => {
    server = await createServer({
      configFile: 'vite.config.js',
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    })
    await server.listen()
    const address = server.httpServer.address()
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await server?.close()
  })

  it('blocks arbitrary hosts while allowing local and Tailscale MagicDNS hosts', async () => {
    const request = (host) => new Promise((resolve, reject) => {
      const req = http.get(baseUrl, { headers: { Host: host } }, (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
      })
      req.on('error', reject)
    })

    const blocked = await request('attacker.example')
    expect(blocked).toBe(403)

    const localhost = await request('localhost')
    expect(localhost).toBe(200)

    const magicDns = await request('operator.tailnet.ts.net')
    expect(magicDns).toBe(200)
  })
})
