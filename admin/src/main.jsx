import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from './lib/router'
import App from './App'
import { preloadInitialRoute } from './routeChunks'
import OperatorLogin from './components/OperatorLogin'
import './index.css'

preloadInitialRoute(window.location.pathname)

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <OperatorLogin>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </OperatorLogin>
  </React.StrictMode>,
)
