import React from 'react'
import { render } from '@testing-library/react'
import { ToastProvider } from '../src/components/Toast'

// Components report action results through toasts (see the feedback convention
// in Toast.jsx), so tests that assert those messages must render inside the
// provider. Drop-in replacement for RTL's `render`.
export function renderWithToasts(ui, options = {}) {
  return render(ui, { wrapper: ToastProvider, ...options })
}
