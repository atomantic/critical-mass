import NumberInput from '../ui/NumberInput'
import { useId, useRef, useState } from 'react'
import { DURATION_UNITS, displayToMs, msToDisplay, pickDurationUnit } from '../../utils/duration.mjs'

// Input component defined OUTSIDE ConfigEditor to prevent re-creation on every render
export function FormInput({ label, hint, value, onChange, type = 'text', className = '', readOnly = false }) {
  const inputId = useId()
  const hintId = `${inputId}-hint`
  if (type !== 'number') {
    return (
      <div className={className}>
        <label htmlFor={inputId} className="block text-xs text-gray-400 mb-1">{label}</label>
        <input
          id={inputId}
          type={type}
          aria-describedby={hint ? hintId : undefined}
          value={value ?? ''}
          readOnly={readOnly}
          onChange={(e) => { if (!readOnly) onChange(e.target.value) }}
          className={`w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-sm text-sm text-white focus:outline-hidden focus:border-blue-500${readOnly ? ' opacity-70 cursor-not-allowed' : ''}`}
        />
        {hint && <div id={hintId} className="text-2xs text-gray-400 mt-0.5 leading-tight">{hint}</div>}
      </div>
    )
  }
  return (
    <div className={className}>
      <label htmlFor={inputId} className="block text-xs text-gray-400 mb-1">{label}</label>
      <NumberInput
        id={inputId}
        type="text"
        inputMode="decimal"
        aria-describedby={hint ? hintId : undefined}
        value={value}
        onChange={onChange}
        className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-sm text-sm text-white focus:outline-hidden focus:border-blue-500"
      />
      {hint && <div id={hintId} className="text-2xs text-gray-400 mt-0.5 leading-tight">{hint}</div>}
    </div>
  )
}

export function FormSelect({ label, hint, value, onChange, options, className = '' }) {
  const selectId = useId()
  const hintId = `${selectId}-hint`
  return (
    <div className={className}>
      <label htmlFor={selectId} className="block text-xs text-gray-400 mb-1">{label}</label>
      <select
        id={selectId}
        aria-describedby={hint ? hintId : undefined}
        value={value ?? options[0]?.value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-sm text-sm text-white focus:outline-hidden focus:border-blue-500"
      >
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      {hint && <div id={hintId} className="text-2xs text-gray-400 mt-0.5 leading-tight">{hint}</div>}
    </div>
  )
}

// Reusable section card for the 2-column regime grid
export function SectionCard({ title, children, className = '' }) {
  return (
    <div className={`bg-gray-900/40 rounded-lg p-4 ${className}`}>
      <h3 className="text-sm font-medium text-purple-400 mb-3">{title}</h3>
      {children}
    </div>
  )
}


// Millisecond setting entered as seconds or minutes. The value in and out is
// always milliseconds, so the saved payload is unchanged. Like FormInput's
// number mode it keeps the raw text while editing and commits only parsed
// finite values.
export function DurationInput({ label, hint, value, onChange, className = '' }) {
  const inputId = useId()
  const hintId = `${inputId}-hint`
  const [unit, setUnit] = useState(() => pickDurationUnit(value))
  const [draft, setDraft] = useState(null)
  const pickedRef = useRef(false)
  const emittedRef = useRef(value)
  // A value that did not come from this input (Reset, reload) re-picks the unit
  // unless the operator chose one explicitly.
  if (value !== emittedRef.current) {
    emittedRef.current = value
    if (!pickedRef.current && draft == null) {
      const next = pickDurationUnit(value)
      if (next !== unit) setUnit(next)
    }
  }
  const handleChange = (e) => {
    const raw = e.target.value
    setDraft(raw)
    if (raw.trim() === '') return
    const n = parseFloat(raw)
    if (!Number.isFinite(n)) return
    const ms = displayToMs(n, unit)
    emittedRef.current = ms
    onChange(ms)
  }
  const display = draft != null ? draft : msToDisplay(value, unit)
  return (
    <div className={className}>
      <label htmlFor={inputId} className="block text-xs text-gray-400 mb-1">{label}</label>
      <div className="flex gap-1">
        <input
          id={inputId}
          type="text"
          inputMode="decimal"
          aria-describedby={hint ? hintId : undefined}
          value={display}
          onChange={handleChange}
          onBlur={() => setDraft(null)}
          className="min-w-0 flex-1 px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-sm text-sm text-white focus:outline-hidden focus:border-blue-500"
        />
        <select
          aria-label={`${label} unit`}
          value={unit}
          onChange={(e) => { pickedRef.current = true; setDraft(null); setUnit(e.target.value) }}
          className="px-1 py-1.5 bg-gray-700 border border-gray-600 rounded-sm text-sm text-white focus:outline-hidden focus:border-blue-500"
        >
          {DURATION_UNITS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
        </select>
      </div>
      {hint && <div id={hintId} className="text-2xs text-gray-400 mt-0.5 leading-tight">{hint}</div>}
    </div>
  )
}
