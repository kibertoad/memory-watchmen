import { describe, expect, it } from 'vitest'

import { collectMemorySample, formatHeapResult, type HeapMonitorResult } from '../src/index.ts'

describe('collectMemorySample', () => {
  it('returns a MemorySample with consistent relationships', () => {
    const sample = collectMemorySample()

    expect(sample.heapUsed).toBeGreaterThan(0)
    expect(sample.heapTotal).toBeGreaterThanOrEqual(sample.heapUsed)
    expect(sample.rss).toBeGreaterThan(0)
    expect(sample.external).toBeGreaterThanOrEqual(0)
    expect(sample.arrayBuffers).toBeGreaterThanOrEqual(0)
    expect(sample.external).toBeGreaterThanOrEqual(sample.arrayBuffers)
    expect(sample.timestamp).toBeGreaterThan(0)
  })
})

describe('formatHeapResult', () => {
  it('describes monotonic leak', () => {
    const result: HeapMonitorResult = {
      samples: [100, 200, 300],
      samplesMB: [0.1, 0.2, 0.3],
      consecutiveGrowth: 10,
      stabilized: false,
      envelopeGrowthMB: 5,
      monotonicLeak: true,
      envelopeLeak: false,
      passed: false,
    }

    const msg = formatHeapResult(result)
    expect(msg).toContain('heap grew monotonically')
    expect(msg).not.toContain('envelope')
  })

  it('describes envelope leak', () => {
    const result: HeapMonitorResult = {
      samples: [100, 200, 300],
      samplesMB: [0.1, 0.2, 0.3],
      consecutiveGrowth: 3,
      stabilized: true,
      envelopeGrowthMB: 20.5,
      monotonicLeak: false,
      envelopeLeak: true,
      passed: false,
    }

    const msg = formatHeapResult(result)
    expect(msg).toContain('envelope grew 20.5 MB')
    expect(msg).not.toContain('monotonically')
  })

  it('describes both leak types', () => {
    const result: HeapMonitorResult = {
      samples: [],
      samplesMB: [],
      consecutiveGrowth: 15,
      stabilized: false,
      envelopeGrowthMB: 25,
      monotonicLeak: true,
      envelopeLeak: true,
      passed: false,
    }

    const msg = formatHeapResult(result)
    expect(msg).toContain('heap grew monotonically')
    expect(msg).toContain('envelope grew')
  })

  it('includes context string', () => {
    const result: HeapMonitorResult = {
      samples: [],
      samplesMB: [],
      consecutiveGrowth: 10,
      stabilized: false,
      envelopeGrowthMB: 0,
      monotonicLeak: true,
      envelopeLeak: false,
      passed: false,
    }

    expect(formatHeapResult(result, 'my-test')).toContain('(my-test)')
  })
})

describe('forceGC', () => {
  it('throws a clear error without --expose-gc', async () => {
    // In the regular test suite (no --expose-gc), forceGC should throw
    const { forceGC } = await import('../src/heap-monitor.ts')

    // global.gc may or may not be available depending on the test runner pool.
    // If it's not available, verify the error message is helpful.
    if (typeof global.gc !== 'function') {
      expect(() => forceGC()).toThrow('--expose-gc')
    }
  })
})
