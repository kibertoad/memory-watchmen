import { Readable, Transform, Writable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import {
  assertBackpressure,
  assertDrainOccurred,
  assertFlowing,
  monitorStreamBuffers,
  snapshotStreamState,
} from '../src/index.ts'

describe('snapshotStreamState', () => {
  it('captures readable properties', () => {
    const readable = new Readable({ read() { this.push(null) } })
    const snap = snapshotStreamState(readable)

    expect(snap.readableLength).toBe(0)
    expect(snap.readableHighWaterMark).toBe(readable.readableHighWaterMark)
    expect(snap.readableFlowing).toBeNull() // no consumer attached
    expect(snap.writableLength).toBeUndefined()
  })

  it('captures writable properties', () => {
    const writable = new Writable({ write(_c, _e, cb) { cb() } })
    const snap = snapshotStreamState(writable)

    expect(snap.writableLength).toBe(0)
    expect(snap.writableHighWaterMark).toBe(writable.writableHighWaterMark)
    expect(snap.readableLength).toBeUndefined()
  })

  it('captures both sides of a Duplex/Transform', () => {
    const transform = new Transform({ transform(c, _e, cb) { cb(null, c) } })
    const snap = snapshotStreamState(transform)

    expect(snap.readableLength).toBeTypeOf('number')
    expect(snap.writableLength).toBeTypeOf('number')
    expect(snap.readableHighWaterMark).toBeTypeOf('number')
    expect(snap.writableHighWaterMark).toBeTypeOf('number')
  })
})

describe('assertFlowing', () => {
  it('throws when readableFlowing is null (no consumer)', () => {
    const readable = new Readable({ read() {} })
    expect(() => assertFlowing(readable)).toThrow('readableFlowing')
  })

  it('throws when readableFlowing is false (paused)', () => {
    const readable = new Readable({ read() {} })
    readable.on('data', () => {}) // start flowing
    readable.pause() // now paused
    expect(() => assertFlowing(readable)).toThrow('readableFlowing')
  })

  it('passes when readableFlowing is true', () => {
    const readable = new Readable({ read() {} })
    readable.on('data', () => {})
    readable.push('data')
    expect(() => assertFlowing(readable)).not.toThrow()
  })
})

describe('assertBackpressure', () => {
  it('throws when no backpressure', () => {
    const writable = new Writable({ write(_c, _e, cb) { cb() } })
    expect(() => assertBackpressure(writable)).toThrow('writableNeedDrain')
  })
})

describe('assertDrainOccurred', () => {
  it('resolves when drain fires', async () => {
    const writable = new Writable({
      highWaterMark: 1,
      write(_c, _e, cb) { setTimeout(cb, 10) },
    })

    // Fill the buffer to trigger backpressure
    writable.write(Buffer.alloc(64))

    // drain should fire once the write callback runs
    await expect(assertDrainOccurred(writable, 1000)).resolves.toBeUndefined()
  })

  it('rejects on timeout', async () => {
    const writable = new Writable({
      write() { /* never calls callback — permanent backpressure */ },
    })
    writable.write('data')

    await expect(assertDrainOccurred(writable, 100)).rejects.toThrow('Drain event did not fire')
  })
})

describe('monitorStreamBuffers', () => {
  it('collects snapshots at intervals', async () => {
    const transform = new Transform({ transform(c, _e, cb) { cb(null, c) } })
    const monitor = monitorStreamBuffers([transform], 50)

    await new Promise((resolve) => setTimeout(resolve, 300))

    const samples = monitor.stop()
    expect(samples.length).toBeGreaterThanOrEqual(2)
    expect(samples[0].streamIndex).toBe(0)
    expect(samples[0].snapshot.readableLength).toBeTypeOf('number')
  })

  it('stops cleanly', () => {
    const transform = new Transform({ transform(c, _e, cb) { cb(null, c) } })
    const monitor = monitorStreamBuffers([transform], 10)

    const stopped = monitor.stop()
    // After stop, no more samples should accumulate
    const countAtStop = stopped.length

    // Brief wait — no new samples should appear
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(monitor.samples.length).toBe(countAtStop)
        resolve()
      }, 50)
    })
  })
})
