import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useNavigate } from '../src/lib/router'

// Mirrors the shape of admin/src/App.jsx's route table, including its
// declaration order: param routes are declared BEFORE the static
// /updown/analysis and /gateway/logs pages, so matching must rank by
// specificity rather than taking the first declared match.
function AppRoutes({ dcaRoutes = false }) {
  return (
    <Routes>
      <Route path="/" element={<div>overview</div>} />
      <Route path="/:exchange/:pair" element={<div>fund dashboard</div>} />
      <Route path="/:exchange/:pair/config" element={<div>fund config</div>} />
      {dcaRoutes && <>
        <Route path="/:exchange/:pair/backtest" element={<div>fund backtest</div>} />
      </>}
      <Route path="/notifications" element={<div>notifications</div>} />
      <Route path="/updown/analysis" element={<div>updown analysis</div>} />
      <Route path="/updown" element={<div>updown</div>} />
      <Route path="/gateway" element={<div>gateway</div>} />
      <Route path="/gateway/logs" element={<div>gateway logs</div>} />
      <Route path="/:exchange" element={<Navigate to="/coinbase/BTC-USDC" replace />} />
      <Route path="*" element={<Navigate to="/coinbase/BTC-USDC" replace />} />
    </Routes>
  )
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="path">{location.pathname}</output>
}

function renderAt(pathname, ui = <AppRoutes />) {
  window.history.replaceState({}, '', pathname)
  return render(<BrowserRouter>{ui}<LocationProbe /></BrowserRouter>)
}

const currentPath = () => screen.getByTestId('path').textContent

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.replaceState({}, '', '/')
})

describe('admin router', () => {
  it.each([
    ['/', 'overview'],
    ['/coinbase/BTC-USDC', 'fund dashboard'],
    ['/coinbase/BTC-USDC/config', 'fund config'],
    ['/notifications', 'notifications'],
    ['/updown', 'updown'],
    ['/updown/analysis', 'updown analysis'],
    ['/gateway', 'gateway'],
    ['/gateway/logs', 'gateway logs'],
  ])('resolves %s', (pathname, text) => {
    renderAt(pathname)
    expect(screen.getByText(text)).toBeTruthy()
  })

  it('ignores trailing slashes and matches static segments case-insensitively', () => {
    renderAt('/updown/analysis/')
    expect(screen.getByText('updown analysis')).toBeTruthy()
    cleanup()
    renderAt('/Notifications')
    expect(screen.getByText('notifications')).toBeTruthy()
  })

  it('matches percent-encoded segments without changing the reported pathname', () => {
    renderAt('/coinbase/BTC%20USDC/config')
    expect(screen.getByText('fund config')).toBeTruthy()
    expect(currentPath()).toBe('/coinbase/BTC%20USDC/config')
  })

  it('keeps an encoded slash inside one segment', () => {
    renderAt('/coinbase/BTC%2FUSDC')
    expect(screen.getByText('fund dashboard')).toBeTruthy()
  })

  it('includes routes nested in conditional fragments', () => {
    renderAt('/coinbase/BTC-USDC/backtest', <AppRoutes dcaRoutes />)
    expect(screen.getByText('fund backtest')).toBeTruthy()
  })

  it('redirects /:exchange with replace', () => {
    window.history.replaceState({}, '', '/coinbase')
    const pushState = vi.spyOn(window.history, 'pushState')
    render(<BrowserRouter><AppRoutes /><LocationProbe /></BrowserRouter>)
    expect(screen.getByText('fund dashboard')).toBeTruthy()
    expect(window.location.pathname).toBe('/coinbase/BTC-USDC')
    expect(pushState).not.toHaveBeenCalled()
  })

  it('redirects unknown routes through the * fallback', () => {
    renderAt('/no/such/page/here')
    expect(screen.getByText('fund dashboard')).toBeTruthy()
    expect(currentPath()).toBe('/coinbase/BTC-USDC')
  })

  it('follows back/forward navigation via popstate', async () => {
    renderAt('/updown', <><AppRoutes /><Link to="/gateway">go gateway</Link></>)
    fireEvent.click(screen.getByText('go gateway'))
    expect(screen.getByText('gateway')).toBeTruthy()
    await act(async () => {
      window.history.back()
      await new Promise(resolve => window.addEventListener('popstate', resolve, { once: true }))
    })
    expect(screen.getByText('updown')).toBeTruthy()
    expect(currentPath()).toBe('/updown')
  })

  it('navigates programmatically, with and without replace', () => {
    function Buttons() {
      const navigate = useNavigate()
      return <>
        <button onClick={() => navigate('/gateway')}>push</button>
        <button onClick={() => navigate('/updown', { replace: true })}>replace</button>
      </>
    }
    renderAt('/', <><AppRoutes /><Buttons /></>)
    const pushState = vi.spyOn(window.history, 'pushState')
    const replaceState = vi.spyOn(window.history, 'replaceState')
    fireEvent.click(screen.getByText('push'))
    expect(screen.getByText('gateway')).toBeTruthy()
    expect(pushState).toHaveBeenCalledTimes(1)
    expect(replaceState).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('replace'))
    expect(screen.getByText('updown')).toBeTruthy()
    expect(pushState).toHaveBeenCalledTimes(1)
    expect(replaceState).toHaveBeenCalledTimes(1)
  })

  describe('Link', () => {
    const renderLink = (props = {}) => renderAt('/', <><AppRoutes /><Link to="/gateway" className="nav" {...props}>go gateway</Link></>)

    it('renders an anchor with href and passes props through', () => {
      renderLink({ title: 'Gateway' })
      const link = screen.getByText('go gateway')
      expect(link.tagName).toBe('A')
      expect(link.getAttribute('href')).toBe('/gateway')
      expect(link.className).toBe('nav')
      expect(link.getAttribute('title')).toBe('Gateway')
    })

    it('intercepts plain left clicks and runs onClick', () => {
      let clicked = 0
      renderLink({ onClick: () => { clicked++ } })
      const event = fireEvent.click(screen.getByText('go gateway'))
      expect(event).toBe(false) // default prevented
      expect(clicked).toBe(1)
      expect(currentPath()).toBe('/gateway')
    })

    it.each([
      ['meta', { metaKey: true }],
      ['ctrl', { ctrlKey: true }],
      ['shift', { shiftKey: true }],
      ['alt', { altKey: true }],
      ['middle', { button: 1 }],
    ])('lets %s clicks open normally', (_name, init) => {
      renderLink()
      const event = fireEvent.click(screen.getByText('go gateway'), init)
      expect(event).toBe(true) // default not prevented
      expect(currentPath()).toBe('/')
    })

    it('lets target=_blank and onClick preventDefault through', () => {
      renderLink({ target: '_blank' })
      expect(fireEvent.click(screen.getByText('go gateway'))).toBe(true)
      expect(currentPath()).toBe('/')
      cleanup()
      renderLink({ onClick: (event) => event.preventDefault() })
      fireEvent.click(screen.getByText('go gateway'))
      expect(currentPath()).toBe('/')
    })
  })
})
