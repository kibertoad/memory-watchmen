import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as sleep } from 'node:timers/promises'

import { describe, expect, it } from 'vitest'

import { collectMemorySample, forceGC, formatHeapResult, monitorHeap } from '../../src/index.ts'

describe('--expose-gc propagation', () => {
  it('global.gc is available in forked vitest worker', () => {
    expect(typeof global.gc).toBe('function')
  })

  it('forceGC() does not throw', () => {
    expect(() => forceGC()).not.toThrow()
  })
})

describe('heap monitor', () => {
  it('detects no leak in a discarding Transform pipeline', async () => {
    // Representative test: Readable → Transform (discard) → Writable sink
    // running concurrently with heap monitoring.
    let generating = true

    const source = new Readable({
      read() {
        if (!generating) {
          this.push(null)
          return
        }
        this.push(Buffer.alloc(1024, 0x41))
      },
    })

    const discarder = new Transform({
      transform(_chunk, _enc, cb) {
        // Yield to the event loop periodically so monitorHeap's sleeps can resolve
        setImmediate(cb)
      },
    })

    const sink = new Writable({
      write(_chunk, _enc, cb) {
        cb()
      },
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
  })

  it('collectMemorySample includes arrayBuffers field', () => {
    const sample = collectMemorySample()
    expect(sample.arrayBuffers).toBeTypeOf('number')
    expect(sample.arrayBuffers).toBeGreaterThanOrEqual(0)
    expect(sample.external).toBeGreaterThanOrEqual(sample.arrayBuffers)
  })
})
