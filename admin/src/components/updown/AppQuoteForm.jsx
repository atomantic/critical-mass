import { useEffect, useRef, useState } from 'react'
import Button from '../ui/Button'
import { apiPost, describeMutationFailure } from '../../utils/apiClient'
import { formatSpread } from '../../utils/format.mjs'

// Quotes the operator confirms from the Crypto.com app. They set the spread and the
// listed contracts, so nothing is recorded without a click.

const URL = '/api/updown/app-quotes'
const FIELD = 'w-full bg-gray-900 border border-gray-700 rounded-sm px-2 py-1 text-xs text-white focus:outline-hidden focus:border-blue-500'
const localMs = (value) => (value ? new Date(value).getTime() : undefined)

async function send(body) {
  const res = await apiPost(URL, body)
  if (!res.ok) throw new Error(describeMutationFailure(res, 'Could not record the quote'))
  return res.data.quote
}

/** Offers the quote read from an Up select screenshot. */
export function ScreenshotQuote({ extracted }) {
  const [captured, setCaptured] = useState('')
  const [quote, setQuote] = useState(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [recorded, setRecorded] = useState(false)
  // The countdown in the screenshot was read as if it were taken now.
  const readAt = useRef(Date.now())

  const build = () => {
    const capturedAt = localMs(captured)
    const age = capturedAt ? readAt.current - capturedAt : 0
    return {
      source: 'screenshot', direction: extracted.direction, range: extracted.range, shown: extracted.currentPrice,
      up: extracted.upPrice, down: extracted.downPrice, floor: extracted.stop, ceiling: extracted.target, maxLoss: extracted.maxLoss,
      ...(extracted.expiryMs ? { expiry: extracted.expiryMs - age } : {}),
      ...(capturedAt ? { capturedAt } : {}),
    }
  }

  useEffect(() => {
    let active = true
    setQuote(null)
    setError('')
    setRecorded(false)
    send({ preview: true, ...build() })
      .then((q) => { if (active) setQuote(q) })
      .catch((err) => { if (active) setError(err.message) })
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- build reads only these two
  }, [extracted, captured])

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      setQuote(await send(build()))
      setRecorded(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border-t border-gray-700 pt-2 space-y-1.5 text-xs">
      {error && <div role="alert" className="text-red-400">{error}</div>}
      {quote && <div className="text-gray-200">Spread {formatSpread(quote.halfSpread)} a side{recorded && ' recorded'}</div>}
      <label className="block text-2xs text-gray-400">Captured (only if this is an older screenshot)
        <input type="datetime-local" value={captured} onChange={(e) => setCaptured(e.target.value)} className={FIELD} />
      </label>
      {quote && !recorded && <Button onClick={save} disabled={saving} variant="primary" size="compact-xs" className="w-full">Record quote</Button>}
    </div>
  )
}

const EMPTY = { range: '2000', shown: '', up: '', down: '', floor: '', captured: '', expiry: '' }

/** The same numbers typed in from the app. */
export default function AppQuoteForm({ onRecorded }) {
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(null)
  const field = (name) => ({ value: form[name], onChange: (e) => setForm((f) => ({ ...f, [name]: e.target.value })), className: FIELD })

  const save = async () => {
    setSaving(true)
    setError('')
    setDone(null)
    try {
      const quote = await send({
        source: 'manual', range: Number(form.range), shown: Number(form.shown), up: Number(form.up), down: Number(form.down), floor: Number(form.floor),
        ...(form.captured ? { capturedAt: localMs(form.captured) } : {}),
        // Any time that Saturday: the gateway snaps it to the 04:00 New York settlement.
        ...(form.expiry ? { expiry: Date.parse(`${form.expiry}T09:00:00Z`) } : {}),
      })
      setDone(quote)
      setForm(EMPTY)
      onRecorded()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <details className="text-xs mb-2">
      <summary className="cursor-pointer text-gray-400">Record an app quote</summary>
      <div className="grid grid-cols-2 gap-1.5 mt-1.5">
        <label className="text-2xs text-gray-400">Range<select {...field('range')}><option value="2000">$2,000</option><option value="500">$500</option></select></label>
        <label className="text-2xs text-gray-400">Bitcoin price<input type="number" {...field('shown')} /></label>
        <label className="text-2xs text-gray-400">Up<input type="number" {...field('up')} /></label>
        <label className="text-2xs text-gray-400">Down<input type="number" {...field('down')} /></label>
        <label className="text-2xs text-gray-400">Stop (floor, with Up selected)<input type="number" {...field('floor')} /></label>
        <label className="text-2xs text-gray-400">Expiry (blank: this Saturday)<input type="date" {...field('expiry')} /></label>
        <label className="text-2xs text-gray-400 col-span-2">Captured (blank: now)<input type="datetime-local" {...field('captured')} /></label>
        {error && <div role="alert" className="text-red-400 col-span-2">{error}</div>}
        {done && <div className="text-gray-200 col-span-2">Spread {formatSpread(done.halfSpread)} a side recorded</div>}
        <Button onClick={save} disabled={saving} variant="primary" size="sm" className="col-span-2">Record quote</Button>
      </div>
    </details>
  )
}
