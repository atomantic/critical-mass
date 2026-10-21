import Button from './Button'

// Error banner with a standard Retry action.
export default function RetryBanner({ message, onRetry, retryLabel = 'Retry', className = 'mb-4' }) {
  return (
    <div role="alert" className={`${className} p-4 bg-red-900/50 border border-red-700 rounded-lg text-red-200 flex items-center justify-between gap-4`}>
      <span>{message}</span>
      <Button variant="danger" size="sm" onClick={onRetry}>{retryLabel}</Button>
    </div>
  )
}
