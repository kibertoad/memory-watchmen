import { setTimeout as sleep } from 'node:timers/promises'

import { forceGC, formatHeapResult, monitorHeap } from './heap-monitor.ts'
import type { AssertNoLeakOptions, HeapMonitorContext, HeapMonitorOptions, HeapMonitorResult } from './types.ts'

/**
 * Run a function and assert it does not leak memory.
 *
 * Calls forceGC(), waits for warm-up, then monitors heap using dual-metric
 * detection (monotonic + envelope). Throws with a descriptive message if
 * a leak is detected.
 *
 * The function `fn` should set up a sustained workload that continues
 * running during the monitoring period (e.g., a streaming pipeline).
 * It receives a context object with a `stopped` flag — set it to true
 * when you detect that monitoring is complete.
 *
 * @example
 * ```ts
 * await assertNoLeak(async (ctx) => {
 *   const interval = setInterval(() => {
 *     if (ctx.stopped.value) { clearInterval(interval); return }
 *     doWork()
 *   }, 10)
 * })
 * ```
 */
export async function assertNoLeak(
  fn: (ctx: HeapMonitorContext) => Promise<void> | void,
  options?: AssertNoLeakOptions,
): Promise<HeapMonitorResult> {
  const warmUpMs = options?.warmUpMs ?? 3000

  const ctx: HeapMonitorContext = { stopped: { value: false } }

  forceGC()
  await fn(ctx)
  await sleep(warmUpMs)

  const result = await monitorHeap(options)

  ctx.stopped.value = true

  if (!result.passed) {
    throw new Error(formatHeapResult(result))
  }

  return result
}

/**
 * Wrap a test function with heap monitoring.
 *
 * Returns the HeapMonitorResult for further assertions. Does NOT throw
 * on failure — the caller decides how to assert (e.g., `expect(result.passed).toBe(true)`).
 *
 * @example
 * ```ts
 * const result = await withHeapMonitor(async (ctx) => {
 *   startStreaming()
 *   // monitoring happens after this returns
 * })
 * expect(result.passed, formatHeapResult(result, 'streaming test')).toBe(true)
 * ```
 */
export async function withHeapMonitor(
  testFn: (ctx: HeapMonitorContext) => Promise<void> | void,
  options?: HeapMonitorOptions & { warmUpMs?: number },
): Promise<HeapMonitorResult> {
  const warmUpMs = options?.warmUpMs ?? 3000

  const ctx: HeapMonitorContext = { stopped: { value: false } }

  forceGC()
  await testFn(ctx)
  await sleep(warmUpMs)

  const result = await monitorHeap(options)

  ctx.stopped.value = true

  return result
}
