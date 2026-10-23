// Shared button. Variants standardise colour/radius; touch-sized targets on
// mobile viewports reset on md+ by default. Existing always-touch controls
// opt in to keeping the 44px minimum at every viewport.
const VARIANTS = {
  primary: 'bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50',
  // Idle state of a primary action with nothing pending (e.g. Save with no edits).
  'primary-muted': 'bg-blue-600/50 hover:bg-blue-600 text-white disabled:opacity-50',
  secondary: 'bg-gray-700 hover:bg-gray-600 text-gray-200 disabled:opacity-50',
  danger: 'bg-red-800 hover:bg-red-700 text-white disabled:opacity-50',
  // Dialog Cancel: muted text that brightens on hover.
  cancel: 'bg-gray-700 hover:bg-gray-600 text-gray-400 hover:text-white disabled:opacity-50',
  // Brighter red than `danger` for confirm-destructive actions.
  destructive: 'bg-red-700 hover:bg-red-800 text-white disabled:opacity-50',
  warning: 'bg-yellow-800 hover:bg-yellow-900 text-white disabled:opacity-50',
  caution: 'bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-50',
  success: 'bg-green-800 hover:bg-green-900 text-white disabled:opacity-50',
  accent: 'bg-cyan-700 hover:bg-cyan-600 text-white disabled:opacity-50',
  purple: 'bg-purple-600 hover:bg-purple-700 text-white disabled:opacity-50',
  ghost: 'bg-transparent hover:bg-gray-700/60 text-gray-300 disabled:opacity-50',
  // Tinted row actions: translucent fill with matching text, for dense lists
  // where a solid button would outweigh the row it sits in.
  'soft-warning': 'bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 disabled:opacity-50',
  'soft-success': 'bg-green-500/20 hover:bg-green-500/30 text-green-400 disabled:opacity-50',
  'soft-danger': 'bg-red-500/20 hover:bg-red-500/30 text-red-400 disabled:opacity-50',
  'soft-primary': 'bg-blue-600/30 hover:bg-blue-600/50 text-blue-300 border border-blue-500/30 disabled:opacity-50',
  'soft-purple': 'bg-purple-600/30 hover:bg-purple-600/50 text-purple-300 border border-purple-500/30 disabled:opacity-50',
  'soft-secondary': 'bg-gray-600/30 hover:bg-gray-600/50 text-gray-400 border border-gray-500/30 disabled:opacity-50',
  'soft-info': 'bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-400 disabled:opacity-50',
  // Text-only actions: no fill, muted text that brightens on hover.
  quiet: 'bg-transparent text-gray-400 hover:text-white disabled:opacity-50',
  'quiet-muted': 'bg-transparent text-gray-400 hover:text-gray-200 disabled:opacity-50',
  'quiet-blue': 'bg-transparent text-gray-400 hover:text-blue-400 disabled:opacity-50',
  'quiet-red': 'bg-transparent text-gray-400 hover:text-red-400 disabled:opacity-50',
  'quiet-danger': 'bg-transparent text-red-400 hover:text-red-300 disabled:opacity-50',
  'quiet-success': 'bg-transparent text-green-400 hover:text-green-300 disabled:opacity-50',
  'quiet-warning': 'bg-transparent text-yellow-400 hover:text-yellow-300 disabled:opacity-50',
  // Color comes from domain state (for example the suggested long-term bias).
  outline: 'bg-transparent hover:bg-gray-900/60 disabled:opacity-50',
  link: 'bg-transparent text-blue-400 hover:text-blue-300 disabled:opacity-50',
}

const SIZES = {
  xs: 'px-2 py-1 text-xs',
  sm: 'px-3 py-1 text-sm',
  md: 'px-4 py-2 text-sm',
  lg: 'px-5 py-2.5 text-sm font-medium',
  // Row actions and inline Retry/Refresh buttons.
  compact: 'px-3 py-1.5 text-sm',
  'compact-xs': 'px-3 py-1.5 text-xs',
  micro: 'px-2 py-0.5 text-2xs',
  icon: 'p-1.5',
  bare: 'p-0 text-sm',
  pill: 'px-1.5 py-0.5 text-xs',
  inline: 'p-0',
  // Dense header controls that shrink below the md breakpoint.
  responsive: 'px-2 md:px-3 py-1 md:py-1.5 text-xs md:text-sm',
  'responsive-xs': 'px-1.5 md:px-2 py-0.5 md:py-1 text-2xs md:text-xs',
}

export const BUTTON_VARIANTS = Object.keys(VARIANTS)
export const BUTTON_SIZES = Object.keys(SIZES)

export default function Button({
  variant = 'primary',
  size = 'md',
  type = 'button',
  touchTarget = 'responsive',
  className = '',
  children,
  ...rest
}) {
  // In-sentence actions must keep the line's natural height and flow.
  const isInlineText = size === 'inline' && touchTarget !== 'always'
  const classes = [
    isInlineText
      ? 'inline rounded-sm transition-colors disabled:cursor-not-allowed'
      : 'min-h-11 min-w-11 inline-flex items-center justify-center rounded-sm transition-colors disabled:cursor-not-allowed',
    !isInlineText && touchTarget !== 'always' ? 'md:min-h-0 md:min-w-0' : '',
    VARIANTS[variant] ?? VARIANTS.primary,
    SIZES[size] ?? SIZES.md,
    className,
  ].filter(Boolean).join(' ')
  return <button type={type} className={classes} {...rest}>{children}</button>
}
