import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from './lib/router'
import App from './App'
import OperatorLogin from './components/OperatorLogin'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <OperatorLogin>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </OperatorLogin>
  </React.StrictMode>,
)
