import { useId } from 'react'

// Accessible on/off switch (44px tap target). `onChange` receives the next value.
export default function ToggleSwitch({ label, checked, onChange, disabled = false, colorOn = 'bg-cyan-500', hint }) {
  const labelId = useId()
  const hintId = `${labelId}-hint`
  return (
    <div className="flex flex-col items-start gap-1 text-sm">
      <div className="flex items-center gap-2">
        <span id={labelId} className="text-gray-400">{label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-labelledby={labelId}
          aria-describedby={hint ? hintId : undefined}
          onClick={() => onChange(!checked)}
          disabled={disabled}
          className="min-h-11 min-w-11 inline-flex items-center justify-center rounded-full transition-colors disabled:opacity-50"
        >
          <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            checked ? colorOn : 'bg-gray-600'
          }`}>
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
              checked ? 'translate-x-5' : 'translate-x-1'
            }`} />
          </span>
        </button>
      </div>
      {hint && <div id={hintId} className="text-2xs text-gray-400 leading-tight">{hint}</div>}
    </div>
  )
}
