import { Readable, Transform, Writable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { assertFlowing, monitorStreamBuffers, snapshotStreamState } from '../src/index.ts'

describe('snapshotStreamState', () => {
  it('captures readable stream state', () => {
    const readable = new Readable({
      read() {
        this.push(null)
      },
    })

    const snap = snapshotStreamState(readable)
    expect(snap.timestamp).toBeTypeOf('number')
    expect(snap.readableLength).toBeTypeOf('number')
    expect(snap.readableHighWaterMark).toBeTypeOf('number')
  })

  it('captures writable stream state', () => {
    const writable = new Writable({
      write(_chunk, _enc, cb) {
        cb()
      },
    })

    const snap = snapshotStreamState(writable)
    expect(snap.timestamp).toBeTypeOf('number')
    expect(snap.writableLength).toBeTypeOf('number')
    expect(snap.writableHighWaterMark).toBeTypeOf('number')
  })

  it('captures duplex stream state', () => {
    const duplex = new Transform({
      transform(chunk, _enc, cb) {
        cb(null, chunk)
      },
    })

    const snap = snapshotStreamState(duplex)
    expect(snap.readableLength).toBeTypeOf('number')
    expect(snap.writableLength).toBeTypeOf('number')
    expect(snap.readableHighWaterMark).toBeTypeOf('number')
    expect(snap.writableHighWaterMark).toBeTypeOf('number')
  })
})

describe('assertFlowing', () => {
  it('throws when readable is not flowing', () => {
    const readable = new Readable({
      read() {},
    })

    expect(() => assertFlowing(readable)).toThrow('readableFlowing')
  })

  it('succeeds when readable is flowing', () => {
    const readable = new Readable({
      read() {},
    })
    readable.on('data', () => {})
    readable.push('test')

    expect(() => assertFlowing(readable)).not.toThrow()
  })
})

describe('monitorStreamBuffers', () => {
  it('collects samples over time', async () => {
    const transform = new Transform({
      transform(chunk, _enc, cb) {
        cb(null, chunk)
      },
    })

    const monitor = monitorStreamBuffers([transform], 50)

    await new Promise((resolve) => setTimeout(resolve, 200))

    const samples = monitor.stop()
    expect(samples.length).toBeGreaterThan(0)
    expect(samples[0].streamIndex).toBe(0)
    expect(samples[0].snapshot.timestamp).toBeTypeOf('number')
  })
})
