import { useState } from 'react'

export default function NumberInput({ value, onChange, type = 'number', ...props }) {
  const [draft, setDraft] = useState(null)

  return (
    <input
      {...props}
      type={type}
      value={draft ?? value ?? ''}
      onChange={event => {
        const raw = event.target.value
        setDraft(raw)
        // Clearing or partially editing the field keeps the last valid value.
        const number = type === 'number' ? event.target.valueAsNumber : parseFloat(raw)
        if (Number.isFinite(number)) onChange(number)
      }}
      onBlur={() => setDraft(null)}
    />
  )
}
