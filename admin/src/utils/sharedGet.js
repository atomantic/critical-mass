import { apiGet } from './apiClient.js'

// Concurrent readers share a transport and its start metadata. A caller can
// leave without cancelling the request for the other readers.
export function createSharedGet({ stamp, delay = 0 } = {}) {
  const pending = new Map()

  return (url, { signal } = {}) => {
    signal?.throwIfAborted()
    let entry = pending.get(url)
    if (!entry) {
      const controller = new AbortController()
      entry = { controller, readers: 0 }
      pending.set(url, entry)

      const read = async () => {
        if (delay) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, delay)
            controller.signal.addEventListener('abort', () => {
              clearTimeout(timer)
              reject(controller.signal.reason)
            }, { once: true })
          })
        }
        const metadata = stamp?.()
        const result = await apiGet(url, { signal: controller.signal })
        return { ...result, ...metadata }
      }
      const request = entry
      entry.promise = read().finally(() => {
        if (pending.get(url) === request) pending.delete(url)
      })
    }
    const request = entry
    request.readers += 1
    return new Promise((resolve, reject) => {
      const finish = () => {
        signal?.removeEventListener('abort', cancel)
        request.readers -= 1
      }
      const cancel = () => {
        finish()
        if (!request.readers && pending.get(url) === request) {
          pending.delete(url)
          request.controller.abort()
        }
        reject(signal.reason)
      }
      signal?.addEventListener('abort', cancel, { once: true })
      request.promise.then(result => {
        if (signal?.aborted) return
        finish()
        resolve(result)
      }, error => {
        if (signal?.aborted) return
        finish()
        reject(error)
      })
    })
  }
}
