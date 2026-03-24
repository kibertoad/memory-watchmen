import { setTimeout as sleep } from 'node:timers/promises'

import { formatEventLoopResult, monitorEventLoop } from './event-loop-monitor.ts'
import { forceGC, formatHeapResult, monitorHeap } from './heap-monitor.ts'
import type {
  AssertNoLeakOptions,
  AssertNoStarvationOptions,
  EventLoopMonitorContext,
  EventLoopMonitorOptions,
  EventLoopMonitorResult,
  HeapMonitorContext,
  HeapMonitorOptions,
  HeapMonitorResult,
} from './types.ts'

/**
 * Run a function and assert it does not leak memory.
 *
 * Calls forceGC(), waits for warm-up, then monitors heap using dual-metric
 * detection (monotonic + envelope). Throws with a descriptive message if
 * a leak is detected.
 *
 * The function `fn` should set up a sustained workload that continues
 * running during the monitoring period (e.g., a streaming pipeline).
 * It receives a context object with a `stopped` flag — check it to
 * know when to stop. The workload runs concurrently with monitoring.
 *
 * @example
 * ```ts
 * await assertNoLeak(async (ctx) => {
 *   while (!ctx.stopped.value) {
 *     doWork()
 *     await sleep(10)
 *   }
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

  // Start workload without awaiting — let it run concurrently with monitoring.
  // Attach a no-op catch to prevent unhandled rejection if the workload
  // throws during monitoring — the error is re-thrown when we await below.
  const workloadPromise = fn(ctx)
  workloadPromise?.catch?.(() => {})

  await sleep(warmUpMs)

  const result = await monitorHeap(options)

  ctx.stopped.value = true

  // Wait for workload to clean up after being signalled to stop.
  // If the workload threw, this re-throws that error.
  await workloadPromise

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
 * The workload runs concurrently with monitoring — check `ctx.stopped.value`
 * to know when to stop.
 *
 * @example
 * ```ts
 * const result = await withHeapMonitor(async (ctx) => {
 *   while (!ctx.stopped.value) {
 *     doWork()
 *     await sleep(10)
 *   }
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

  // Start workload without awaiting — let it run concurrently with monitoring.
  // Attach a no-op catch to prevent unhandled rejection if the workload
  // throws during monitoring — the error is re-thrown when we await below.
  const workloadPromise = testFn(ctx)
  workloadPromise?.catch?.(() => {})

  await sleep(warmUpMs)

  const result = await monitorHeap(options)

  ctx.stopped.value = true

  // Wait for workload to clean up after being signalled to stop.
  // If the workload threw, this re-throws that error.
  await workloadPromise

  return result
}

/**
 * Run a function and assert it does not starve the event loop.
 *
 * Starts the workload, waits for warm-up, then monitors event loop delay
 * and utilization. Throws with a descriptive message if starvation is detected.
 *
 * The function `fn` should set up a sustained workload that continues
 * running during the monitoring period. It receives a context object with
 * a `stopped` flag — check it to know when to stop.
 *
 * @example
 * ```ts
 * await assertNoStarvation(async (ctx) => {
 *   while (!ctx.stopped.value) {
 *     doCpuWork()
 *     await new Promise(resolve => setImmediate(resolve))
 *   }
 * })
 * ```
 */
export async function assertNoStarvation(
  fn: (ctx: EventLoopMonitorContext) => Promise<void> | void,
  options?: AssertNoStarvationOptions,
): Promise<EventLoopMonitorResult> {
  const warmUpMs = options?.warmUpMs ?? 1000

  const ctx: EventLoopMonitorContext = { stopped: { value: false } }

  // Start workload without awaiting — let it run concurrently with monitoring.
  // Attach a no-op catch to prevent unhandled rejection if the workload
  // throws during monitoring — the error is re-thrown when we await below.
  const workloadPromise = fn(ctx)
  workloadPromise?.catch?.(() => {})

  await sleep(warmUpMs)

  const result = await monitorEventLoop(options)

  ctx.stopped.value = true

  // Wait for workload to clean up after being signalled to stop.
  // If the workload threw, this re-throws that error.
  await workloadPromise

  if (!result.passed) {
    throw new Error(formatEventLoopResult(result))
  }

  return result
}

/**
 * Wrap a test function with event loop monitoring.
 *
 * Returns the EventLoopMonitorResult for further assertions. Does NOT throw
 * on failure — the caller decides how to assert.
 *
 * The workload runs concurrently with monitoring — check `ctx.stopped.value`
 * to know when to stop.
 *
 * @example
 * ```ts
 * const result = await withEventLoopMonitor(async (ctx) => {
 *   while (!ctx.stopped.value) {
 *     doCpuWork()
 *     await new Promise(resolve => setImmediate(resolve))
 *   }
 * })
 * expect(result.passed, formatEventLoopResult(result, 'processing')).toBe(true)
 * ```
 */
export async function withEventLoopMonitor(
  testFn: (ctx: EventLoopMonitorContext) => Promise<void> | void,
  options?: EventLoopMonitorOptions & { warmUpMs?: number },
): Promise<EventLoopMonitorResult> {
  const warmUpMs = options?.warmUpMs ?? 1000

  const ctx: EventLoopMonitorContext = { stopped: { value: false } }

  // Start workload without awaiting — let it run concurrently with monitoring.
  // Attach a no-op catch to prevent unhandled rejection if the workload
  // throws during monitoring — the error is re-thrown when we await below.
  const workloadPromise = testFn(ctx)
  workloadPromise?.catch?.(() => {})

  await sleep(warmUpMs)

  const result = await monitorEventLoop(options)

  ctx.stopped.value = true

  // Wait for workload to clean up after being signalled to stop.
  // If the workload threw, this re-throws that error.
  await workloadPromise

  return result
}
