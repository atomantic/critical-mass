// Shared button. Variants standardise colour/radius; touch-sized targets on
// coarse (mobile) viewports reset on md+ so desktop density is unchanged.
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
  'soft-info': 'bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-400 disabled:opacity-50',
  // Text-only actions: no fill, muted text that brightens on hover.
  quiet: 'bg-transparent text-gray-400 hover:text-white disabled:opacity-50',
  link: 'bg-transparent text-blue-400 hover:text-blue-300 disabled:opacity-50',
}

const SIZES = {
  xs: 'px-2 py-1 text-xs',
  sm: 'px-3 py-1 text-sm',
  md: 'px-4 py-2 text-sm',
  lg: 'px-5 py-2.5 text-sm font-medium',
  // Row actions and inline Retry/Refresh buttons.
  compact: 'px-3 py-1.5 text-sm',
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
  className = '',
  children,
  ...rest
}) {
  const classes = [
    'min-h-11 min-w-11 md:min-h-0 md:min-w-0 inline-flex items-center justify-center rounded-sm transition-colors disabled:cursor-not-allowed',
    VARIANTS[variant] ?? VARIANTS.primary,
    SIZES[size] ?? SIZES.md,
    className,
  ].filter(Boolean).join(' ')
  return <button type={type} className={classes} {...rest}>{children}</button>
}
