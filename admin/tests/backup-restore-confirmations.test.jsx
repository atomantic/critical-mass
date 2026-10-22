import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { renderWithToasts as render } from './renderWithToasts'
import BackupRestore from '../src/components/BackupRestore'

HTMLDialogElement.prototype.showModal = function () { this.open = true; this.querySelector('[autofocus]')?.focus() }
HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }

const FILENAME = 'backup-2026-10-20.zip'
const FUND_PATH = '/api/backups/fund-state/snap-1/coinbase/ETH-USDC/restore'
const listing = {
  config: { enabled: true, intervalMs: 24 * 60 * 60 * 1000 },
  backups: [{ filename: FILENAME, sizeBytes: 2048, createdAt: '2026-10-20T00:00:00Z' }],
  fundStateBackups: [{
    snapshotId: 'snap-1',
    sizeBytes: 512,
    createdAt: '2026-10-20T00:00:00Z',
    funds: [{ exchange: 'coinbase', pair: 'ETH-USDC', files: ['a.json'] }],
  }],
}

let writes, writeResponse
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

beforeEach(() => {
  writes = []
  writeResponse = () => json(200, { success: true })
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    if (options.method === 'DELETE' || options.method === 'POST') {
      writes.push({ url, method: options.method, body: options.body })
      return writeResponse(url, options)
    }
    if (String(url).endsWith('/compatibility')) return json(200, { success: true, compatible: true, legacy: false })
    return json(200, listing)
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function escape() {
  const dialog = screen.getByRole('dialog')
  const event = new Event('cancel', { cancelable: true })
  if (dialog.dispatchEvent(event)) dialog.close()
}

it('Delete only opens the confirm dialog; Cancel and Escape send no request; Confirm sends exactly one DELETE', async () => {
  render(<BackupRestore />)
  const trigger = await screen.findByRole('button', { name: 'Delete' })
  fireEvent.click(trigger)
  expect(screen.getByRole('heading', { name: 'Delete Backup' })).toBeTruthy()
  expect(within(screen.getByRole('dialog')).getByText(FILENAME)).toBeTruthy()
  expect(writes).toHaveLength(0)

  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(trigger)
  act(() => { escape() })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(writes).toHaveLength(0)

  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('button', { name: 'Delete Backup' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(writes).toEqual([{ url: `/api/backups/${FILENAME}`, method: 'DELETE', body: undefined }])
  expect(await screen.findByText(`Deleted ${FILENAME}`)).toBeTruthy()
})

it('a failed delete reports the server error and sends no second request', async () => {
  writeResponse = () => json(500, { error: 'disk busy' })
  render(<BackupRestore />)
  fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete Backup' }))
  expect(await screen.findByText(`Could not delete ${FILENAME}: disk busy`)).toBeTruthy()
  expect(writes).toHaveLength(1)
})

it('Restore Fund State only opens the confirm dialog; Cancel sends nothing; Confirm posts once without force', async () => {
  render(<BackupRestore />)
  const trigger = await screen.findByRole('button', { name: 'Restore Fund State' })
  fireEvent.click(trigger)
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText('coinbase/ETH-USDC')).toBeTruthy()
  expect(writes).toHaveLength(0)

  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(writes).toHaveLength(0)

  fireEvent.click(trigger)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Restore Fund State' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({ url: FUND_PATH, method: 'POST' })
  expect(JSON.parse(writes[0].body)).toEqual({ force: false })
})

it('fund-state restore blocked by unquiesced writers keeps the dialog open, lists the writers, and only forces after acknowledgement', async () => {
  writeResponse = (url, options) => JSON.parse(options.body).force
    ? json(200, { success: true, forced: true, unconfirmed: [{ exchange: 'coinbase', reason: 'ipc-timeout' }], message: 'Forced restore done' })
    : json(409, { code: 'writers-not-quiesced', error: 'writers still running', unconfirmed: [{ exchange: 'coinbase', reason: 'ipc-timeout' }] })
  render(<BackupRestore />)
  fireEvent.click(await screen.findByRole('button', { name: 'Restore Fund State' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Restore Fund State' }))

  expect(await screen.findByText(/coinbase · ipc-timeout/)).toBeTruthy()
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByRole('button', { name: 'Retry Restore' })).toBeTruthy()
  const force = within(dialog).getByRole('button', { name: 'Force Restore Anyway' })
  expect(force.disabled).toBe(true)
  fireEvent.click(force)
  expect(writes).toHaveLength(1)

  fireEvent.click(within(dialog).getByRole('checkbox'))
  expect(force.disabled).toBe(false)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Retry Restore' }))
  await waitFor(() => expect(writes).toHaveLength(2))
  expect(JSON.parse(writes[1].body)).toEqual({ force: false })
  await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('checkbox').checked).toBe(false))
  expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Force Restore Anyway' }).disabled).toBe(true)

  fireEvent.click(within(screen.getByRole('dialog')).getByRole('checkbox'))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Force Restore Anyway' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(writes).toHaveLength(3)
  expect(JSON.parse(writes[2].body)).toEqual({ force: true })
  expect(await screen.findByText(/Forced restore done — FORCED past 1 unconfirmed writer/)).toBeTruthy()
})

it('Cancel on a blocked fund-state restore clears the blocked list so the next dialog starts clean', async () => {
  writeResponse = () => json(409, { code: 'writers-not-quiesced', unconfirmed: [{ exchange: 'coinbase', reason: 'ipc-timeout' }] })
  render(<BackupRestore />)
  const trigger = await screen.findByRole('button', { name: 'Restore Fund State' })
  fireEvent.click(trigger)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Restore Fund State' }))
  await screen.findByText(/ipc-timeout/)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(trigger)
  expect(screen.queryByText(/ipc-timeout/)).toBeNull()
  expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'Force Restore Anyway' })).toBeNull()
})

it('full archive Restore needs Confirm Restore; Cancel sends nothing; a 409 offers Retry and gated Force', async () => {
  writeResponse = (url, options) => JSON.parse(options.body).force
    ? json(200, { success: true, forced: true, unconfirmed: [{}], message: 'Restored 3 files' })
    : json(409, { code: 'writers-not-quiesced', unconfirmed: [{ exchange: 'gemini', reason: 'no-ack' }] })
  render(<BackupRestore />)
  const trigger = await screen.findByRole('button', { name: 'Restore' })
  fireEvent.click(trigger)
  expect(await screen.findByRole('heading', { name: 'Confirm Restore' })).toBeTruthy()
  expect(writes).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('heading', { name: 'Confirm Restore' })).toBeNull()
  expect(writes).toHaveLength(0)

  fireEvent.click(trigger)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm Restore' }).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm Restore' }))
  expect(await screen.findByText(/gemini · no-ack/)).toBeTruthy()
  expect(writes).toHaveLength(1)
  expect(writes[0].url).toBe(`/api/backups/${FILENAME}/restore`)
  expect(screen.getByRole('button', { name: 'Retry Restore' })).toBeTruthy()
  const force = screen.getByRole('button', { name: 'Force Restore Anyway' })
  expect(force.disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: /verified the listed writers/ }))
  fireEvent.click(force)
  expect(await screen.findByText(/FORCED past 1 unconfirmed writer/)).toBeTruthy()
  expect(writes).toHaveLength(2)
  expect(JSON.parse(writes[1].body).force).toBe(true)
})

it('a successful restore names its recovery archive and shows the server warnings', async () => {
  writeResponse = () => json(200, {
    success: true,
    filesRestored: 3,
    configRestored: true,
    recoveryPoint: 'backup-pre.zip',
    message: 'Restored 3 files. The data it replaced is saved as backup-pre.zip; restore that backup to undo.',
    warnings: ['UpDown failed to reload restored state: boom'],
  })
  render(<BackupRestore />)
  fireEvent.click(await screen.findByRole('button', { name: 'Restore' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm Restore' }).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm Restore' }))
  expect(await screen.findByText(/saved as backup-pre\.zip; restore that backup to undo\..*UpDown failed to reload restored state: boom/)).toBeTruthy()
})

it('a later clean backup dismisses the earlier sticky engine-status warning', async () => {
  const backupResponses = [
    json(200, { filename: 'b1.zip', sizeBytes: 10, warnings: ['UpDown pause failed'] }),
    json(200, { filename: 'b2.zip', sizeBytes: 10 }),
  ]
  writeResponse = () => backupResponses.shift()
  render(<BackupRestore />)
  const create = await screen.findByRole('button', { name: /Create Backup Now/ })
  fireEvent.click(create)
  expect(await screen.findByText(/Check engine status before resuming trading/)).toBeTruthy()
  fireEvent.click(create)
  expect(await screen.findByText(/Backup created: b2\.zip/)).toBeTruthy()
  expect(screen.queryByText(/Check engine status before resuming trading/)).toBeNull()
})
