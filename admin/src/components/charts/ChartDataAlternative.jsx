import { useEffect, useId, useState } from 'react'
import { TABLE_PAGE_SIZE } from './chartDataText'

/**
 * Paginated native table. Rows are { id?, cells: string[] } or plain objects keyed by column.
 * Pagination controls are plain buttons so keyboard users can operate them, and the current
 * page is clamped (never reset) when live data shrinks the row count.
 */
function DataTable({ caption, columns, rows, pageSize }) {
  const [page, setPage] = useState(0)
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  useEffect(() => {
    if (page !== safePage) setPage(safePage)
  }, [page, safePage])

  const from = safePage * pageSize
  const visible = rows.slice(from, from + pageSize)

  return (
    <div className="mt-2">
      <div className="overflow-x-auto max-h-64 overflow-y-auto">
        <table className="w-full text-xs text-left text-gray-300">
          <caption className="text-left text-gray-400 mb-1">{caption}</caption>
          <thead className="text-gray-400">
            <tr>
              {columns.map(col => (
                <th key={col.key} scope="col" className="pr-4 py-1 font-medium whitespace-nowrap">{col.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr><td colSpan={columns.length} className="py-1 text-gray-500">No data</td></tr>
            ) : visible.map((row, i) => (
              <tr key={from + i} className="border-t border-gray-700">
                {columns.map((col, c) => (
                  c === 0
                    ? <th key={col.key} scope="row" className="pr-4 py-1 font-normal whitespace-nowrap">{row[col.key]}</th>
                    : <td key={col.key} className="pr-4 py-1 whitespace-nowrap">{row[col.key]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && (
        <nav aria-label={`${caption} pages`} className="flex items-center gap-2 mt-1 text-xs text-gray-400">
          <button
            type="button"
            className="px-2 py-0.5 rounded bg-gray-700 text-gray-200 disabled:opacity-40"
            disabled={safePage === 0}
            onClick={() => setPage(safePage - 1)}
          >
            Previous
          </button>
          <span>Rows {from + 1} to {from + visible.length} of {rows.length}</span>
          <button
            type="button"
            className="px-2 py-0.5 rounded bg-gray-700 text-gray-200 disabled:opacity-40"
            disabled={safePage >= pageCount - 1}
            onClick={() => setPage(safePage + 1)}
          >
            Next
          </button>
        </nav>
      )}
    </div>
  )
}

/**
 * Visible text summary plus a "View chart data" disclosure holding captioned tables.
 * `summaryId` is exposed so the chart SVG can reference it via aria-describedby. The summary is
 * deliberately not an aria-live region so live ticks are not announced.
 */
export default function ChartDataAlternative({ summaryId, summary = [], tables = [], pageSize = TABLE_PAGE_SIZE }) {
  const baseId = useId()
  return (
    <div className="mt-2 text-xs text-gray-400">
      <div id={summaryId} data-chart-summary>
        {summary.map((line, i) => <p key={i} className="mb-0.5">{line}</p>)}
      </div>
      <details className="mt-1" data-chart-data>
        <summary className="cursor-pointer text-gray-300 hover:text-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400 w-fit">
          View chart data
        </summary>
        {tables.map((table, i) => (
          <DataTable key={`${baseId}-${i}`} pageSize={pageSize} {...table} />
        ))}
      </details>
    </div>
  )
}
