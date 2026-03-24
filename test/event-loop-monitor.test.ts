import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

import { describe, expect, it } from 'vitest'

import {
  collectDelaySample,
  collectUtilizationSample,
  formatEventLoopResult,
  monitorEventLoop,
  type EventLoopMonitorResult,
} from '../src/index.ts'

describe('monitorEventLoop', () => {
  it('returns samples with valid structure', async () => {
    const result = await monitorEventLoop({
      sampleCount: 3,
      sampleIntervalMs: 100,
    })

    expect(result.delaySamples).toHaveLength(3)
    expect(result.utilizationSamples).toHaveLength(3)

    for (const sample of result.delaySamples) {
      expect(sample.timestamp).toBeGreaterThan(0)
      expect(sample.min).toBeGreaterThanOrEqual(0)
      expect(sample.max).toBeGreaterThanOrEqual(sample.min)
      expect(sample.mean).toBeGreaterThanOrEqual(0)
      expect(sample.p50).toBeGreaterThanOrEqual(0)
      expect(sample.p99).toBeGreaterThanOrEqual(0)
      expect(sample.count).toBeGreaterThanOrEqual(0)
    }

    for (const sample of result.utilizationSamples) {
      expect(sample.timestamp).toBeGreaterThan(0)
      expect(sample.utilization).toBeGreaterThanOrEqual(0)
      expect(sample.utilization).toBeLessThanOrEqual(1)
      expect(sample.idle).toBeGreaterThanOrEqual(0)
      expect(sample.active).toBeGreaterThanOrEqual(0)
    }
  })

  it('passes for an idle event loop', async () => {
    const result = await monitorEventLoop({
      sampleCount: 3,
      sampleIntervalMs: 100,
    })

    expect(result.passed).toBe(true)
    expect(result.p99DelayExceeded).toBe(false)
    expect(result.meanDelayExceeded).toBe(false)
    expect(result.utilizationExceeded).toBe(false)
    expect(result.peakP99DelayMs).toBeGreaterThanOrEqual(0)
    expect(result.peakMeanDelayMs).toBeGreaterThanOrEqual(0)
    expect(result.meanP99DelayMs).toBeGreaterThanOrEqual(0)
    expect(result.peakUtilization).toBeGreaterThanOrEqual(0)
    expect(result.meanUtilization).toBeGreaterThanOrEqual(0)
  })

  it('detects starvation from a blocking loop', async () => {
    // Start a CPU-bound blocking workload
    let blocking = true
    const blockLoop = () => {
      if (!blocking) return
      // Block the event loop for ~30ms then yield
      const end = Date.now() + 30
      while (Date.now() < end) { /* busy wait */ }
      setImmediate(blockLoop)
    }
    setImmediate(blockLoop)

    const result = await monitorEventLoop({
      sampleCount: 5,
      sampleIntervalMs: 200,
      maxP99DelayMs: 5,
      maxMeanDelayMs: 3,
    })

    blocking = false

    // At least the delay checks should trigger
    expect(result.passed).toBe(false)
    expect(result.p99DelayExceeded || result.meanDelayExceeded).toBe(true)
  })

  it('works with minimal sampleCount', async () => {
    const result = await monitorEventLoop({
      sampleCount: 1,
      sampleIntervalMs: 100,
    })

    expect(result.delaySamples).toHaveLength(1)
    expect(result.utilizationSamples).toHaveLength(1)
  })

  it('respects custom thresholds', async () => {
    const result = await monitorEventLoop({
      sampleCount: 2,
      sampleIntervalMs: 100,
      maxP99DelayMs: 10000,
      maxMeanDelayMs: 10000,
      maxUtilization: 1.0,
    })

    // Very generous thresholds — should always pass
    expect(result.passed).toBe(true)
  })

  it('includes resolved thresholds in result', async () => {
    const result = await monitorEventLoop({
      sampleCount: 1,
      sampleIntervalMs: 50,
      maxP99DelayMs: 42,
      maxMeanDelayMs: 21,
      maxUtilization: 0.8,
    })

    expect(result.thresholds).toEqual({
      maxP99DelayMs: 42,
      maxMeanDelayMs: 21,
      maxUtilization: 0.8,
    })
  })

  it('uses default thresholds when none provided', async () => {
    const result = await monitorEventLoop({
      sampleCount: 1,
      sampleIntervalMs: 50,
    })

    expect(result.thresholds).toEqual({
      maxP99DelayMs: 100,
      maxMeanDelayMs: 50,
      maxUtilization: 0.95,
    })
  })

  it('skips checks for null thresholds', async () => {
    // Start a blocking workload that would normally fail all checks
    let blocking = true
    const blockLoop = () => {
      if (!blocking) return
      const end = Date.now() + 30
      while (Date.now() < end) { /* busy wait */ }
      setImmediate(blockLoop)
    }
    setImmediate(blockLoop)

    const result = await monitorEventLoop({
      sampleCount: 5,
      sampleIntervalMs: 200,
      maxP99DelayMs: null,
      maxMeanDelayMs: null,
      maxUtilization: null,
    })

    blocking = false

    // All checks disabled — should pass regardless of actual values
    expect(result.passed).toBe(true)
    expect(result.p99DelayExceeded).toBe(false)
    expect(result.meanDelayExceeded).toBe(false)
    expect(result.utilizationExceeded).toBe(false)
    expect(result.thresholds).toEqual({
      maxP99DelayMs: null,
      maxMeanDelayMs: null,
      maxUtilization: null,
    })
    // Metrics are still collected even when checks are disabled
    expect(result.peakP99DelayMs).toBeGreaterThan(0)
  })

  it('captures delay from long blocking workloads that yield via setImmediate', async () => {
    // Regression: when the event loop is blocked for much longer than sampleIntervalMs,
    // the monitoring timer and histogram timer are both overdue. Without the setImmediate
    // yield before reading, the monitoring timer's microtask would read and reset the
    // histogram before the histogram timer fired — producing count: 0 samples.
    const items = Array.from({ length: 200 }, (_, i) => i)
    let running = true

    const work = async () => {
      while (running) {
        // Block for ~400ms (200 items × 2ms)
        for (const _item of items) {
          const end = Date.now() + 2
          while (Date.now() < end) { /* busy */ }
        }
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
    const p = work()

    const result = await monitorEventLoop({
      sampleCount: 4,
      sampleIntervalMs: 200,
      maxP99DelayMs: null,
      maxMeanDelayMs: null,
      maxUtilization: null,
    })

    running = false
    await p

    // At least some samples must have captured the blocking delay
    const totalCount = result.delaySamples.reduce((sum, s) => sum + s.count, 0)
    expect(totalCount).toBeGreaterThan(0)
    expect(result.peakP99DelayMs).toBeGreaterThan(100)

    // Regression: empty samples (count: 0) produce mean: NaN. Math.max(NaN, ...)
    // returns NaN, which poisoned peakMeanDelayMs and caused false passes.
    // Aggregates must be computed from valid samples only.
    expect(Number.isFinite(result.peakMeanDelayMs)).toBe(true)
    expect(result.peakMeanDelayMs).toBeGreaterThan(100)
  })
})

describe('collectDelaySample', () => {
  it('reads histogram values in milliseconds', async () => {
    const histogram = monitorEventLoopDelay({ resolution: 20 })
    histogram.enable()

    // Let the histogram collect some data
    await new Promise((resolve) => setTimeout(resolve, 100))

    const sample = collectDelaySample(histogram)
    histogram.disable()

    expect(sample.timestamp).toBeGreaterThan(0)
    expect(sample.min).toBeGreaterThanOrEqual(0)
    expect(sample.max).toBeGreaterThanOrEqual(sample.min)
    expect(sample.mean).toBeGreaterThanOrEqual(0)
    expect(sample.p50).toBeGreaterThanOrEqual(0)
    expect(sample.p99).toBeGreaterThanOrEqual(0)
    expect(sample.count).toBeGreaterThanOrEqual(0)
  })

  it('does not reset the histogram', async () => {
    const histogram = monitorEventLoopDelay({ resolution: 20 })
    histogram.enable()

    await new Promise((resolve) => setTimeout(resolve, 100))

    const sample1 = collectDelaySample(histogram)
    const sample2 = collectDelaySample(histogram)
    histogram.disable()

    // Without reset, the second read should have count >= first read
    expect(sample2.count).toBeGreaterThanOrEqual(sample1.count)
  })
})

describe('collectUtilizationSample', () => {
  it('returns utilization between 0 and 1', async () => {
    const previous = performance.eventLoopUtilization()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const sample = collectUtilizationSample(previous)

    expect(sample.timestamp).toBeGreaterThan(0)
    expect(sample.utilization).toBeGreaterThanOrEqual(0)
    expect(sample.utilization).toBeLessThanOrEqual(1)
    expect(sample.idle).toBeGreaterThanOrEqual(0)
    expect(sample.active).toBeGreaterThanOrEqual(0)
  })
})

describe('formatEventLoopResult', () => {
  it('describes p99 delay exceeded with threshold', () => {
    const result: EventLoopMonitorResult = {
      delaySamples: [{ timestamp: 0, min: 0, max: 150, mean: 20, p50: 10, p99: 150, count: 100 }],
      utilizationSamples: [],
      peakP99DelayMs: 150,
      peakMeanDelayMs: 20,
      meanP99DelayMs: 150,
      peakUtilization: 0.5,
      meanUtilization: 0.5,
      p99DelayExceeded: true,
      meanDelayExceeded: false,
      utilizationExceeded: false,
      passed: false,
      thresholds: { maxP99DelayMs: 100, maxMeanDelayMs: 50, maxUtilization: 0.95 },
    }

    const msg = formatEventLoopResult(result)
    expect(msg).toContain('p99 delay 150.0ms > 100ms')
    expect(msg).not.toContain('utilization')
    expect(msg).not.toContain('mean delay')
  })

  it('describes utilization exceeded with threshold', () => {
    const result: EventLoopMonitorResult = {
      delaySamples: [],
      utilizationSamples: [],
      peakP99DelayMs: 5,
      peakMeanDelayMs: 2,
      meanP99DelayMs: 5,
      peakUtilization: 0.98,
      meanUtilization: 0.96,
      p99DelayExceeded: false,
      meanDelayExceeded: false,
      utilizationExceeded: true,
      passed: false,
      thresholds: { maxP99DelayMs: 100, maxMeanDelayMs: 50, maxUtilization: 0.95 },
    }

    const msg = formatEventLoopResult(result)
    expect(msg).toContain('utilization 98.0% > 95%')
    expect(msg).not.toContain('p99')
  })

  it('describes multiple exceeded thresholds', () => {
    const result: EventLoopMonitorResult = {
      delaySamples: [{ timestamp: 0, min: 0, max: 200, mean: 60, p50: 30, p99: 200, count: 50 }],
      utilizationSamples: [],
      peakP99DelayMs: 200,
      peakMeanDelayMs: 60,
      meanP99DelayMs: 200,
      peakUtilization: 0.99,
      meanUtilization: 0.97,
      p99DelayExceeded: true,
      meanDelayExceeded: true,
      utilizationExceeded: true,
      passed: false,
      thresholds: { maxP99DelayMs: 100, maxMeanDelayMs: 50, maxUtilization: 0.95 },
    }

    const msg = formatEventLoopResult(result)
    expect(msg).toContain('p99 delay')
    expect(msg).toContain('mean delay')
    expect(msg).toContain('utilization')
  })

  it('includes context string', () => {
    const result: EventLoopMonitorResult = {
      delaySamples: [],
      utilizationSamples: [],
      peakP99DelayMs: 200,
      peakMeanDelayMs: 60,
      meanP99DelayMs: 200,
      peakUtilization: 0.5,
      meanUtilization: 0.5,
      p99DelayExceeded: true,
      meanDelayExceeded: false,
      utilizationExceeded: false,
      passed: false,
      thresholds: { maxP99DelayMs: 100, maxMeanDelayMs: 50, maxUtilization: 0.95 },
    }

    expect(formatEventLoopResult(result, 'my-test')).toContain('(my-test)')
  })
})
