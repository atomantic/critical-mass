import { useState, useEffect } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { Settings, Key, Shield, Activity } from 'lucide-react'

export default function Config() {
  const location = useLocation()

  const tabs = [
    { path: '/kalshi/config', label: 'General', icon: Settings, exact: true },
    { path: '/kalshi/config/keys', label: 'API Keys', icon: Key },
    { path: '/kalshi/config/risk', label: 'Risk Limits', icon: Shield },
    { path: '/kalshi/config/strategies', label: 'Strategies', icon: Activity },
  ]

  const isActive = (tab) => {
    if (tab.exact) return location.pathname === tab.path
    return location.pathname.startsWith(tab.path)
  }

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Configuration</h1>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-gray-700">
        {tabs.map(tab => (
          <Link
            key={tab.path}
            to={tab.path}
            className={`flex items-center gap-2 px-4 py-2 -mb-px border-b-2 transition-colors ${
              isActive(tab)
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            <tab.icon size={16} />
            {tab.label}
          </Link>
        ))}
      </div>

      <Outlet />
    </div>
  )
}
