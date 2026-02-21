import { useState, useEffect, useCallback } from 'react'
import { History, Plus, Trash2, Edit3, Check, X } from 'lucide-react'

function fmt(v) {
  if (v == null) return '---'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v)
}

export default function TradeHistory() {
  const [trades, setTrades] = useState([])
  const [summary, setSummary] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState(null)
  const [form, setForm] = useState({ date: '', cost: '', returnAmount: '', note: '' })

  const fetchTrades = useCallback(async () => {
    const res = await fetch('/api/updown/trades').catch(() => null)
    if (!res?.ok) return
    const data = await res.json()
    if (data.success) {
      setTrades(data.trades)
      setSummary(data.summary)
    }
  }, [])

  useEffect(() => { fetchTrades() }, [fetchTrades])

  const resetForm = () => {
    setForm({ date: new Date().toISOString().slice(0, 10), cost: '', returnAmount: '', note: '' })
    setShowForm(false)
    setEditId(null)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    const payload = {
      date: form.date,
      cost: parseFloat(form.cost),
      returnAmount: parseFloat(form.returnAmount),
      note: form.note,
    }

    if (editId != null) {
      await fetch(`/api/updown/trades/${editId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } else {
      await fetch('/api/updown/trades', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    }
    resetForm()
    fetchTrades()
  }

  const handleEdit = (trade) => {
    setForm({
      date: trade.date || '',
      cost: trade.cost?.toString() || '',
      returnAmount: trade.returnAmount?.toString() || '',
      note: trade.note || '',
    })
    setEditId(trade.id)
    setShowForm(true)
  }

  const handleDelete = async (id) => {
    await fetch(`/api/updown/trades/${id}`, { method: 'DELETE' })
    fetchTrades()
  }

  const pnlColor = (v) => v > 0 ? 'text-green-400' : v < 0 ? 'text-red-400' : 'text-gray-400'
  const winRate = summary?.count > 0 ? ((summary.wins / summary.count) * 100).toFixed(0) : 0

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <History size={16} className="text-emerald-400" />
          <h3 className="text-sm font-semibold">Trade History</h3>
          {summary && (
            <span className="text-xs text-gray-500">{summary.count} trades</span>
          )}
        </div>
        <button
          onClick={() => { resetForm(); setShowForm(!showForm) }}
          className="flex items-center gap-1 px-2 py-1 text-xs bg-emerald-600 hover:bg-emerald-700 rounded transition-colors"
        >
          <Plus size={12} /> Add Trade
        </button>
      </div>

      {/* P&L Summary */}
      {summary && (
        <div className="grid grid-cols-4 gap-2 mb-3 text-xs">
          <div className="bg-gray-900 rounded px-2 py-1.5">
            <div className="text-gray-500">Total P&L</div>
            <div className={`font-mono font-semibold ${pnlColor(summary.totalPnl)}`}>
              {summary.totalPnl >= 0 ? '+' : ''}{fmt(summary.totalPnl)}
            </div>
          </div>
          <div className="bg-gray-900 rounded px-2 py-1.5">
            <div className="text-gray-500">Total Cost</div>
            <div className="font-mono font-medium text-white">{fmt(summary.totalCost)}</div>
          </div>
          <div className="bg-gray-900 rounded px-2 py-1.5">
            <div className="text-gray-500">Total Return</div>
            <div className="font-mono font-medium text-white">{fmt(summary.totalReturn)}</div>
          </div>
          <div className="bg-gray-900 rounded px-2 py-1.5">
            <div className="text-gray-500">Win Rate</div>
            <div className="font-mono font-medium text-white">
              {winRate}% <span className="text-gray-500">({summary.wins}W / {summary.losses}L)</span>
            </div>
          </div>
        </div>
      )}

      {/* Add/Edit Form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="bg-gray-900 border border-gray-700 rounded-lg p-3 mb-3 space-y-2">
          <div className="text-xs font-medium text-emerald-400 mb-1">
            {editId != null ? 'Edit Trade' : 'New Trade'}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-[10px] text-gray-500 block mb-0.5">Date</label>
              <input
                type="date"
                value={form.date}
                onChange={e => setForm({ ...form, date: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 block mb-0.5">Cost (Open)</label>
              <input
                type="number"
                step="0.01"
                value={form.cost}
                onChange={e => setForm({ ...form, cost: e.target.value })}
                placeholder="500.00"
                required
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 block mb-0.5">Return (Close)</label>
              <input
                type="number"
                step="0.01"
                value={form.returnAmount}
                onChange={e => setForm({ ...form, returnAmount: e.target.value })}
                placeholder="650.00"
                required
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500"
              />
            </div>
          </div>
          <div>
            <label className="text-[10px] text-gray-500 block mb-0.5">Note (optional)</label>
            <input
              type="text"
              value={form.note}
              onChange={e => setForm({ ...form, note: e.target.value })}
              placeholder="e.g. Up $500 range, hit target"
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500"
            />
          </div>
          {form.cost && form.returnAmount && (
            <div className="text-xs">
              <span className="text-gray-500">P&L: </span>
              <span className={pnlColor(parseFloat(form.returnAmount) - parseFloat(form.cost))}>
                {fmt(parseFloat(form.returnAmount) - parseFloat(form.cost))}
              </span>
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              className="flex-1 py-1.5 bg-emerald-600 hover:bg-emerald-700 rounded text-xs font-medium transition-colors flex items-center justify-center gap-1"
            >
              <Check size={12} /> {editId != null ? 'Update' : 'Save'}
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="flex-1 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs font-medium transition-colors flex items-center justify-center gap-1"
            >
              <X size={12} /> Cancel
            </button>
          </div>
        </form>
      )}

      {/* Trade Table */}
      {trades.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-gray-700">
                <th className="text-left py-1.5 pr-2">Date</th>
                <th className="text-right py-1.5 px-2">Cost</th>
                <th className="text-right py-1.5 px-2">Return</th>
                <th className="text-right py-1.5 px-2">P&L</th>
                <th className="text-left py-1.5 px-2">Note</th>
                <th className="py-1.5 pl-2 w-14"></th>
              </tr>
            </thead>
            <tbody>
              {[...trades].reverse().map(t => (
                <tr key={t.id} className="border-b border-gray-700/50 hover:bg-gray-700/20">
                  <td className="py-1.5 pr-2 text-gray-300">{t.date}</td>
                  <td className="py-1.5 px-2 text-right font-mono text-gray-300">{fmt(t.cost)}</td>
                  <td className="py-1.5 px-2 text-right font-mono text-gray-300">{fmt(t.returnAmount)}</td>
                  <td className={`py-1.5 px-2 text-right font-mono font-medium ${pnlColor(t.pnl)}`}>
                    {t.pnl >= 0 ? '+' : ''}{fmt(t.pnl)}
                  </td>
                  <td className="py-1.5 px-2 text-gray-500 max-w-[120px] truncate" title={t.note}>{t.note}</td>
                  <td className="py-1.5 pl-2">
                    <div className="flex gap-1">
                      <button onClick={() => handleEdit(t)} className="text-gray-500 hover:text-blue-400 transition-colors" title="Edit">
                        <Edit3 size={12} />
                      </button>
                      <button onClick={() => handleDelete(t.id)} className="text-gray-500 hover:text-red-400 transition-colors" title="Delete">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-gray-500 text-xs text-center py-4">No trades recorded yet</div>
      )}
    </div>
  )
}
