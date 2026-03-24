import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'

import type {
  EventLoopDelaySample,
  EventLoopMonitorOptions,
  EventLoopMonitorResult,
  EventLoopUtilizationSample,
} from './types.ts'

/**
 * Collect a single event loop delay sample from a running histogram.
 *
 * Reads percentiles and returns the sample. Does NOT reset the histogram —
 * the caller is responsible for calling `histogram.reset()` if needed.
 * The histogram must be enabled before calling this function.
 */
export function collectDelaySample(histogram: ReturnType<typeof monitorEventLoopDelay>): EventLoopDelaySample {
  return {
    timestamp: Date.now(),
    min: histogram.min / 1e6,
    max: histogram.max / 1e6,
    mean: histogram.mean / 1e6,
    p50: histogram.percentile(50) / 1e6,
    p99: histogram.percentile(99) / 1e6,
    count: histogram.count,
  }
}

/**
 * Collect an event loop utilization sample over an interval.
 *
 * Wraps `performance.eventLoopUtilization()` to diff two snapshots.
 */
export function collectUtilizationSample(
  previous: ReturnType<typeof performance.eventLoopUtilization>,
): EventLoopUtilizationSample {
  const elu = performance.eventLoopUtilization(previous)
  return {
    timestamp: Date.now(),
    utilization: elu.utilization,
    idle: elu.idle,
    active: elu.active,
  }
}

/**
 * Monitor event loop delay and utilization over time.
 *
 * Samples event loop delay (via `perf_hooks.monitorEventLoopDelay`) and
 * utilization (via `performance.eventLoopUtilization`) at regular intervals.
 *
 * Two complementary checks:
 * 1. **Delay** — p99 and mean event loop delay stay under thresholds
 * 2. **Utilization** — event loop active ratio stays under saturation threshold
 *
 * Returns a result object with `passed: boolean` and diagnostic fields.
 */
export async function monitorEventLoop(options?: EventLoopMonitorOptions): Promise<EventLoopMonitorResult> {
  const sampleCount = options?.sampleCount ?? 20
  const sampleIntervalMs = options?.sampleIntervalMs ?? 500
  const resolution = options?.resolution ?? 20
  const maxP99DelayMs = options?.maxP99DelayMs === null ? null : (options?.maxP99DelayMs ?? 100)
  const maxMeanDelayMs = options?.maxMeanDelayMs === null ? null : (options?.maxMeanDelayMs ?? 50)
  const maxUtilization = options?.maxUtilization === null ? null : (options?.maxUtilization ?? 0.95)

  const delaySamples: EventLoopDelaySample[] = []
  const utilizationSamples: EventLoopUtilizationSample[] = []

  const histogram = monitorEventLoopDelay({ resolution })
  histogram.enable()

  let eluPrevious = performance.eventLoopUtilization()

  for (let i = 0; i < sampleCount; i++) {
    await sleep(sampleIntervalMs)

    // Yield to let the histogram's internal timer fire before reading.
    // When the event loop is heavily blocked, the monitoring setTimeout and
    // histogram timer are both overdue. The setTimeout resolves first (as a
    // microtask), and without this yield we'd read the histogram before its
    // timer has recorded the blocking delay — producing count: 0 samples.
    await new Promise<void>((resolve) => setImmediate(resolve))

    // Delay sample — read and reset
    const delaySample = collectDelaySample(histogram)
    delaySamples.push(delaySample)
    histogram.reset()

    // Utilization sample — diff from previous
    const eluCurrent = performance.eventLoopUtilization()
    const utilizationSample = collectUtilizationSample(eluPrevious)
    utilizationSamples.push(utilizationSample)
    eluPrevious = eluCurrent
  }

  histogram.disable()

  // Compute aggregates
  const peakP99DelayMs = delaySamples.length > 0
    ? Math.max(...delaySamples.map((s) => s.p99))
    : 0
  const peakMeanDelayMs = delaySamples.length > 0
    ? Math.max(...delaySamples.map((s) => s.mean))
    : 0
  const meanP99DelayMs = delaySamples.length > 0
    ? delaySamples.reduce((sum, s) => sum + s.p99, 0) / delaySamples.length
    : 0
  const peakUtilization = utilizationSamples.length > 0
    ? Math.max(...utilizationSamples.map((s) => s.utilization))
    : 0
  const meanUtilization = utilizationSamples.length > 0
    ? utilizationSamples.reduce((sum, s) => sum + s.utilization, 0) / utilizationSamples.length
    : 0

  const p99DelayExceeded = maxP99DelayMs !== null && peakP99DelayMs > maxP99DelayMs
  const meanDelayExceeded = maxMeanDelayMs !== null && peakMeanDelayMs > maxMeanDelayMs
  const utilizationExceeded = maxUtilization !== null && peakUtilization > maxUtilization

  return {
    delaySamples,
    utilizationSamples,
    peakP99DelayMs,
    peakMeanDelayMs,
    meanP99DelayMs,
    peakUtilization,
    meanUtilization,
    p99DelayExceeded,
    meanDelayExceeded,
    utilizationExceeded,
    passed: !p99DelayExceeded && !meanDelayExceeded && !utilizationExceeded,
    thresholds: { maxP99DelayMs, maxMeanDelayMs, maxUtilization },
  }
}

/**
 * Format an EventLoopMonitorResult into a human-readable error message.
 */
export function formatEventLoopResult(result: EventLoopMonitorResult, context?: string): string {
  const { thresholds } = result
  const parts: string[] = []
  if (result.p99DelayExceeded && thresholds.maxP99DelayMs !== null) {
    parts.push(`p99 delay ${result.peakP99DelayMs.toFixed(1)}ms > ${thresholds.maxP99DelayMs}ms`)
  }
  if (result.meanDelayExceeded && thresholds.maxMeanDelayMs !== null) {
    parts.push(`mean delay ${result.peakMeanDelayMs.toFixed(1)}ms > ${thresholds.maxMeanDelayMs}ms`)
  }
  if (result.utilizationExceeded && thresholds.maxUtilization !== null) {
    parts.push(`utilization ${(result.peakUtilization * 100).toFixed(1)}% > ${(thresholds.maxUtilization * 100).toFixed(0)}%`)
  }
  return (
    'Event loop starvation detected' +
    (context ? ` (${context})` : '') +
    ': ' +
    parts.join('; ') +
    `. P99 delays (ms): [${result.delaySamples.map((s) => s.p99.toFixed(1)).join(', ')}].`
  )
}
