import { createContext, useContext, useCallback } from 'react'

// addToast returns the new toast's id so a caller can removeToast(id) once the
// message is stale (e.g. a sticky "restart to apply" warning after the restart).
export const ToastContext = createContext({
  addToast: () => null,
  removeToast: () => {},
})

export const useToast = () => useContext(ToastContext)

/*
 * Feedback convention for admin views (issue #1606). Pick the channel by what
 * the message is, not by what the component happened to do before:
 *
 *   - Toast (useToast / useNotify): the RESULT of an action the operator just
 *     took -- save/delete/create/test succeeded, or failed transiently. Toasts
 *     render in a fixed corner, so they are visible even when the button sat at
 *     the bottom of a long form. Errors stay until dismissed; others auto-close.
 *   - Inline, next to the field/form: validation errors and persistent states
 *     the operator must fix or keep seeing (bad input, load failures that
 *     replace the page body, "not configured", per-row status).
 *   - Banner (AlertBanner / page-level): engine-wide conditions that are not the
 *     result of one click (engine stopped, exchange unreachable, drawdown halt).
 *
 * Native <dialog> modals render in the top layer above the toast stack, so a
 * failure the operator must read while a modal is still open stays inline in
 * that modal.
 */

// notify(type, message, { title, sticky }) is sugar over addToast for the common
// "report the outcome of this request" call. type: success | error | warning |
// info. Errors never auto-close; pass `sticky` to keep a warning the operator must
// act on (e.g. "restart the engine to apply") until dismissed. Returns the toast
// id (null when there was no message) -- pair a sticky toast with
// useToast().removeToast(id) so it is dismissed once the condition clears.
export function useNotify() {
  const { addToast } = useToast()
  return useCallback((type, message, { title, sticky } = {}) => (
    message ? addToast({ type, title, message, sticky }) : null
  ), [addToast])
}
