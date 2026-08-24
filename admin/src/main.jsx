import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
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
