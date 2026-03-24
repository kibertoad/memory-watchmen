import { describe, expect, it } from 'vitest'

import {
  formatEventLoopResult,
  monitorEventLoop,
} from '../../src/index.ts'
import { assertNoStarvation, withEventLoopMonitor } from '../../src/vitest.ts'

describe('monitorEventLoop — positive case', () => {
  it('passes for a cooperative workload that yields via setImmediate', async () => {
    let running = true

    // Workload that yields regularly — should not starve the loop.
    // Note: setImmediate round-trip is ~1ms typically but can be ~20ms
    // in CI or forked workers, so thresholds must be generous.
    const work = async () => {
      while (running) {
        // Simulate ~2ms of CPU work
        const end = Date.now() + 2
        while (Date.now() < end) { /* busy */ }
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }

    const workPromise = work()

    const result = await monitorEventLoop({
      sampleCount: 10,
      sampleIntervalMs: 200,
      maxP99DelayMs: 100,
      maxMeanDelayMs: 50,
      maxUtilization: 1.0, // cooperative busy loop runs near 100% — that's fine
    })

    running = false
    await workPromise

    expect(result.passed, formatEventLoopResult(result, 'cooperative workload')).toBe(true)
    expect(result.p99DelayExceeded).toBe(false)
    expect(result.meanDelayExceeded).toBe(false)
  })
})

describe('monitorEventLoop — negative case', () => {
  it('detects starvation from a tight blocking loop', async () => {
    let blocking = true

    // Block event loop for ~50ms per iteration
    const block = () => {
      if (!blocking) return
      const end = Date.now() + 50
      while (Date.now() < end) { /* busy */ }
      setImmediate(block)
    }
    setImmediate(block)

    const result = await monitorEventLoop({
      sampleCount: 6,
      sampleIntervalMs: 200,
      maxP99DelayMs: 10,
      maxMeanDelayMs: 5,
    })

    blocking = false

    expect(result.passed).toBe(false)
    expect(result.p99DelayExceeded || result.meanDelayExceeded).toBe(true)
    expect(result.peakP99DelayMs).toBeGreaterThan(10)
  })
})

describe('assertNoStarvation', () => {
  it('passes for cooperative workload using while loop', async () => {
    const result = await assertNoStarvation(
      async (ctx) => {
        // The while loop runs concurrently with monitoring —
        // ctx.stopped.value is set to true after monitoring completes
        while (!ctx.stopped.value) {
          const end = Date.now() + 1
          while (Date.now() < end) { /* busy */ }
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      },
      {
        warmUpMs: 500,
        sampleCount: 6,
        sampleIntervalMs: 200,
        maxP99DelayMs: 100,
        maxMeanDelayMs: 50,
        maxUtilization: null, // disable — cooperative busy loop runs near 100%
      },
    )

    expect(result.passed).toBe(true)
    expect(result.utilizationExceeded).toBe(false) // disabled check never exceeds
  })

  it('throws for a blocking workload', async () => {
    await expect(
      assertNoStarvation(
        async (ctx) => {
          const block = () => {
            if (ctx.stopped.value) return
            const end = Date.now() + 50
            while (Date.now() < end) { /* busy */ }
            setImmediate(block)
          }
          setImmediate(block)
        },
        {
          warmUpMs: 200,
          sampleCount: 4,
          sampleIntervalMs: 200,
          maxP99DelayMs: 10,
          maxMeanDelayMs: 5,
        },
      ),
    ).rejects.toThrow('Event loop starvation detected')
  })
})

describe('withEventLoopMonitor', () => {
  it('returns result without throwing on failure', async () => {
    const result = await withEventLoopMonitor(
      async (ctx) => {
        const block = () => {
          if (ctx.stopped.value) return
          const end = Date.now() + 40
          while (Date.now() < end) { /* busy */ }
          setImmediate(block)
        }
        setImmediate(block)
      },
      {
        warmUpMs: 200,
        sampleCount: 4,
        sampleIntervalMs: 200,
        maxP99DelayMs: 5,
        maxMeanDelayMs: 3,
      },
    )

    // Should not throw — just returns the result
    expect(result.passed).toBe(false)
    expect(result.delaySamples.length).toBeGreaterThan(0)
  })

  it('returns passing result for idle loop', async () => {
    const result = await withEventLoopMonitor(
      async () => {
        // No workload — idle loop
      },
      {
        warmUpMs: 100,
        sampleCount: 3,
        sampleIntervalMs: 100,
      },
    )

    expect(result.passed).toBe(true)
  })
})
