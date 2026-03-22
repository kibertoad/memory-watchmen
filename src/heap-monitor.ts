import { setTimeout as sleep } from 'node:timers/promises'

import type { HeapMonitorOptions, HeapMonitorResult, MemorySample } from './types.ts'

/**
 * Force garbage collection with double pass for measurement stability.
 *
 * Each `gc()` call with no arguments triggers a synchronous full GC.
 * Two calls help because: FinalizationRegistry callbacks run asynchronously
 * after GC (a second cycle collects objects released by those callbacks),
 * and V8-internal deferred tasks (weak callback processing, dead ephemeron
 * table entry cleanup) may not complete until a subsequent cycle.
 *
 * Requires `--expose-gc` flag. Throws a clear error if unavailable.
 */
export function forceGC(): void {
  if (typeof global.gc !== 'function') {
    throw new Error(
      'forceGC() requires the --expose-gc flag. ' +
        'Run with: node --expose-gc your-script.js ' +
        'or set NODE_OPTIONS=--expose-gc',
    )
  }
  global.gc()
  global.gc()
}

/**
 * Collect a single memory sample from the current process.
 */
export function collectMemorySample(): MemorySample {
  const mem = process.memoryUsage()
  return {
    timestamp: Date.now(),
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    rss: mem.rss,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
  }
}

/**
 * Monitor heap usage over time and apply dual-assertion leak detection.
 *
 * Two complementary checks:
 * 1. Monotonic growth — heap grew every sample for N+ consecutive checks (tight leak)
 * 2. Envelope growth — first-third avg vs last-third avg exceeds threshold (step-wise/burst leaks)
 *
 * See PATTERNS.md for background on why this approach works.
 */
export async function monitorHeap(options?: HeapMonitorOptions): Promise<HeapMonitorResult> {
  const sampleCount = options?.sampleCount ?? 15
  const sampleIntervalMs = options?.sampleIntervalMs ?? 1500
  const maxConsecutiveGrowth = options?.maxConsecutiveGrowth ?? 10
  const maxEnvelopeGrowthMB = options?.maxEnvelopeGrowthMB ?? 15

  const samples: number[] = []

  // Baseline — not counted toward growth detection
  forceGC()
  samples.push(process.memoryUsage().heapUsed)

  let consecutiveGrowth = 0
  let stabilized = false

  for (let i = 0; i < sampleCount; i++) {
    await sleep(sampleIntervalMs)

    forceGC()
    const heap = process.memoryUsage().heapUsed
    samples.push(heap)

    const prevHeap = samples[samples.length - 2]!
    if (heap <= prevHeap) {
      stabilized = true
      consecutiveGrowth = 0
    } else {
      consecutiveGrowth++
    }
  }

  // Envelope growth: compare first-third avg to last-third avg
  const thirdLen = Math.max(1, Math.floor(samples.length / 3))
  const firstThird = samples.slice(1, 1 + thirdLen)
  const lastThird = samples.slice(-thirdLen)
  const avgFirst = firstThird.length > 0 ? firstThird.reduce((a, b) => a + b, 0) / firstThird.length : 0
  const avgLast = lastThird.length > 0 ? lastThird.reduce((a, b) => a + b, 0) / lastThird.length : 0
  const envelopeGrowthMB = (avgLast - avgFirst) / (1024 * 1024)

  const monotonicLeak = !stabilized && consecutiveGrowth >= maxConsecutiveGrowth
  const envelopeLeak = envelopeGrowthMB > maxEnvelopeGrowthMB

  return {
    samples,
    samplesMB: samples.map((s) => Math.round((s / (1024 * 1024)) * 10) / 10),
    consecutiveGrowth,
    stabilized,
    envelopeGrowthMB,
    monotonicLeak,
    envelopeLeak,
    passed: !monotonicLeak && !envelopeLeak,
  }
}

/**
 * Format a HeapMonitorResult into a human-readable error message.
 */
export function formatHeapResult(result: HeapMonitorResult, context?: string): string {
  const parts: string[] = []
  if (result.monotonicLeak) parts.push('heap grew monotonically')
  if (result.envelopeLeak) parts.push(`envelope grew ${result.envelopeGrowthMB.toFixed(1)} MB`)
  return (
    'Possible memory leak' +
    (context ? ` (${context})` : '') +
    ': ' +
    parts.join('; ') +
    `. Samples (MB): [${result.samplesMB.join(', ')}].`
  )
}
