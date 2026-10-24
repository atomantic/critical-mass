// Keep 44px targets at every width for coarse pointers and on narrow screens.
// Only a fine primary pointer at md+ opts into compact desktop controls.
export const TOUCH_TARGET_RESET = 'md:pointer-fine:min-h-0 md:pointer-fine:min-w-0'
export const TOUCH_TARGET = `min-h-11 min-w-11 ${TOUCH_TARGET_RESET} inline-flex items-center justify-center`
