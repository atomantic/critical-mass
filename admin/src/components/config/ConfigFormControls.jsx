import { useId, useState } from 'react'

// Input component defined OUTSIDE ConfigEditor to prevent re-creation on every render
export function FormInput({ label, hint, value, onChange, type = 'text', className = '' }) {
  const inputId = useId()
  const hintId = `${inputId}-hint`
  // For number inputs, hold the raw string locally while editing so partial
  // entries survive ("0." doesn't collapse to "0" mid-type, and clearing the
  // field shows empty rather than instantly committing 0). The parsed number is
  // committed only when the text parses to a finite value; an empty/partial
  // field commits nothing (keeps the last valid value) (#111).
  const [draft, setDraft] = useState(null)
  if (type !== 'number') {
    return (
      <div className={className}>
        <label htmlFor={inputId} className="block text-xs text-gray-400 mb-1">{label}</label>
        <input
          id={inputId}
          type={type}
          aria-describedby={hint ? hintId : undefined}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-sm text-sm text-white focus:outline-hidden focus:border-blue-500"
        />
        {hint && <div id={hintId} className="text-2xs text-gray-400 mt-0.5 leading-tight">{hint}</div>}
      </div>
    )
  }
  const handleNumberChange = (e) => {
    const raw = e.target.value
    setDraft(raw)
    if (raw.trim() === '') return // don't commit 0 on clear
    const n = parseFloat(raw)
    if (Number.isFinite(n)) onChange(n)
  }
  // Show the in-progress draft while focused/editing; otherwise reflect the
  // committed value. Reset the draft on blur so external value changes show.
  const display = draft != null ? draft : (value ?? '')
  return (
    <div className={className}>
      <label htmlFor={inputId} className="block text-xs text-gray-400 mb-1">{label}</label>
      <input
        id={inputId}
        type="text"
        inputMode="decimal"
        aria-describedby={hint ? hintId : undefined}
        value={display}
        onChange={handleNumberChange}
        onBlur={() => setDraft(null)}
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

