import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as sleep } from 'node:timers/promises'

import { describe, expect, it } from 'vitest'

import {
  collectMemorySample,
  createTracker,
  forceGC,
  formatHeapResult,
  monitorHeap,
} from '../../src/index.ts'

describe('--expose-gc propagation', () => {
  it('global.gc is available in forked vitest worker', () => {
    expect(typeof global.gc).toBe('function')
  })

  it('forceGC does not throw', () => {
    expect(() => forceGC()).not.toThrow()
  })
})

describe('monitorHeap — positive case', () => {
  it('passes for a non-leaking streaming pipeline', async () => {
    let generating = true

    const source = new Readable({
      read() {
        if (!generating) { this.push(null); return }
        this.push(Buffer.alloc(1024, 0x41))
      },
    })
    const discarder = new Transform({
      transform(_chunk, _enc, cb) { setImmediate(cb) },
    })
    const sink = new Writable({
      write(_chunk, _enc, cb) { cb() },
    })

    const pipelineDone = pipeline(source, discarder, sink)
    await sleep(500)

    const result = await monitorHeap({
      sampleCount: 8,
      sampleIntervalMs: 500,
      maxConsecutiveGrowth: 6,
      maxEnvelopeGrowthMB: 10,
    })

    generating = false
    await pipelineDone

    expect(result.passed, formatHeapResult(result, 'discarding transform')).toBe(true)
    expect(result.monotonicLeak).toBe(false)
    expect(result.envelopeLeak).toBe(false)
  })
})

describe('monitorHeap — negative cases', () => {
  it('detects growth from a deliberate heap leak', async () => {
    // Accumulate JS objects (not Buffers!) to grow heapUsed.
    // Buffer.alloc grows external memory, not heapUsed, so it won't trigger
    // the heap monitor. Use arrays of strings instead.
    const leakedData: string[][] = []
    let leaking = true

    const leakInterval = setInterval(() => {
      if (!leaking) return
      // ~1 MB of heap strings per tick
      const chunk: string[] = []
      for (let i = 0; i < 1000; i++) {
        chunk.push('x'.repeat(1024))
      }
      leakedData.push(chunk)
    }, 100)

    const result = await monitorHeap({
      sampleCount: 10,
      sampleIntervalMs: 500,
      maxConsecutiveGrowth: 6,
      maxEnvelopeGrowthMB: 5,
    })

    leaking = false
    clearInterval(leakInterval)
    leakedData.length = 0

    expect(result.passed).toBe(false)
    expect(result.monotonicLeak || result.envelopeLeak).toBe(true)
  })

  it('detects envelope growth from burst heap allocations', async () => {
    // Allocate a large burst of heap objects DURING monitoring to create
    // envelope drift (first-third avg << last-third avg)
    const leakedData: string[][] = []

    // Let monitoring start clean, then burst-allocate after a delay
    const burstTimer = setTimeout(() => {
      for (let i = 0; i < 40; i++) {
        const chunk: string[] = []
        for (let j = 0; j < 1000; j++) {
          chunk.push('y'.repeat(1024))
        }
        leakedData.push(chunk)
      }
    }, 1500) // burst halfway through monitoring window

    const result = await monitorHeap({
      sampleCount: 8,
      sampleIntervalMs: 400,
      maxConsecutiveGrowth: 20, // high threshold so monotonic doesn't trigger
      maxEnvelopeGrowthMB: 5,  // low threshold to catch the burst
    })

    clearTimeout(burstTimer)
    leakedData.length = 0

    expect(result.envelopeGrowthMB).toBeGreaterThan(5)
    expect(result.envelopeLeak).toBe(true)
    expect(result.passed).toBe(false)
  })
})

describe('monitorHeap — edge cases', () => {
  it('works with minimal sampleCount', async () => {
    const result = await monitorHeap({
      sampleCount: 1,
      sampleIntervalMs: 100,
    })

    // 1 baseline + 1 sample = 2 entries
    expect(result.samples).toHaveLength(2)
    expect(result.samplesMB).toHaveLength(2)
    // With only 1 sample, cannot have 10 consecutive growths
    expect(result.monotonicLeak).toBe(false)
  })
})

describe('object tracker with GC', () => {
  it('detects collection of a dereferenced object', async () => {
    const tracker = createTracker()

    let obj: object | null = { data: 'will-be-collected', payload: Buffer.alloc(1024) }
    const handle = tracker.track(obj, 'test-object')

    expect(handle.isCollected()).toBe(false)

    // Release the reference
    obj = null

    // Should be collected after forced GC
    await tracker.expectCollected(handle, { timeout: 2000, gcIntervalMs: 50 })
    expect(handle.isCollected()).toBe(true)
  })

  it('times out when object is still referenced', async () => {
    const tracker = createTracker()
    const obj = { data: 'still-alive' }
    const handle = tracker.track(obj, 'held-object')

    await expect(
      tracker.expectCollected(handle, { timeout: 300, gcIntervalMs: 50 }),
    ).rejects.toThrow('was not garbage collected')

    // obj is still referenced — keep it alive past the assertion
    expect(obj.data).toBe('still-alive')
  })

  it('expectAllCollected succeeds when all objects are released', async () => {
    const tracker = createTracker()

    let a: object | null = { id: 'a' }
    let b: object | null = { id: 'b' }
    tracker.track(a, 'obj-a')
    tracker.track(b, 'obj-b')

    a = null
    b = null

    await tracker.expectAllCollected({ timeout: 2000, gcIntervalMs: 50 })
  })

  it('expectAllCollected fails when some objects are held', async () => {
    const tracker = createTracker()

    const held = { id: 'held' }
    let released: object | null = { id: 'released' }
    tracker.track(held, 'held-obj')
    tracker.track(released, 'released-obj')

    released = null

    await expect(
      tracker.expectAllCollected({ timeout: 300, gcIntervalMs: 50 }),
    ).rejects.toThrow('held-obj')

    expect(held.id).toBe('held')
  })
})

describe('collectMemorySample', () => {
  it('includes arrayBuffers as subset of external', () => {
    const sample = collectMemorySample()
    expect(sample.arrayBuffers).toBeTypeOf('number')
    expect(sample.external).toBeGreaterThanOrEqual(sample.arrayBuffers)
  })
})
