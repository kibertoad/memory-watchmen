import { describe, expect, it } from 'vitest'

import { collectMemorySample, formatHeapResult, type HeapMonitorResult } from '../src/index.ts'

describe('collectMemorySample', () => {
  it('returns a valid MemorySample with all fields', () => {
    const sample = collectMemorySample()

    expect(sample.timestamp).toBeTypeOf('number')
    expect(sample.timestamp).toBeGreaterThan(0)
    expect(sample.heapUsed).toBeTypeOf('number')
    expect(sample.heapUsed).toBeGreaterThan(0)
    expect(sample.heapTotal).toBeTypeOf('number')
    expect(sample.heapTotal).toBeGreaterThan(0)
    expect(sample.rss).toBeTypeOf('number')
    expect(sample.rss).toBeGreaterThan(0)
    expect(sample.external).toBeTypeOf('number')
    expect(sample.external).toBeGreaterThanOrEqual(0)
  })

  it('returns increasing timestamps on subsequent calls', () => {
    const s1 = collectMemorySample()
    const s2 = collectMemorySample()
    expect(s2.timestamp).toBeGreaterThanOrEqual(s1.timestamp)
  })
})

describe('formatHeapResult', () => {
  it('formats monotonic leak', () => {
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
    expect(msg).toContain('Possible memory leak')
    expect(msg).toContain('heap grew monotonically')
    expect(msg).toContain('Samples (MB)')
  })

  it('formats envelope leak', () => {
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
  })

  it('includes context when provided', () => {
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

    const msg = formatHeapResult(result, 'streaming test')
    expect(msg).toContain('(streaming test)')
  })

  it('formats both leak types together', () => {
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
})
