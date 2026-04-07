import { Readable, Transform, Writable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import {
  assertBackpressure,
  assertDrainOccurred,
  assertFlowing,
  monitorPushBackpressure,
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

describe('monitorPushBackpressure', () => {
  it('tracks push count and maxReadableLength', () => {
    const readable = new Readable({
      objectMode: true,
      highWaterMark: 2,
      read() {},
    })

    const monitor = monitorPushBackpressure(readable)

    readable.push('a')
    readable.push('b')
    readable.push('c') // exceeds highWaterMark

    const stats = monitor.stop()

    expect(stats.pushCount).toBe(3)
    expect(stats.maxReadableLength).toBe(3)
  })

  it('tracks pushFalseCount when buffer exceeds highWaterMark', () => {
    const readable = new Readable({
      objectMode: true,
      highWaterMark: 1,
      read() {},
    })

    const monitor = monitorPushBackpressure(readable)

    const result1 = readable.push('a') // fills to HWM
    const result2 = readable.push('b') // exceeds HWM

    const stats = monitor.stop()

    expect(result1).toBe(false) // at HWM, returns false
    expect(result2).toBe(false)
    expect(stats.pushFalseCount).toBe(2)
    expect(stats.firstPushFalseAtReadableLength).toBe(1)
  })

  it('reports null for firstPushFalseAtReadableLength when no backpressure', () => {
    const readable = new Readable({
      objectMode: true,
      highWaterMark: 100,
      read() {},
    })

    const monitor = monitorPushBackpressure(readable)
    readable.push('a')

    const stats = monitor.stop()

    expect(stats.pushFalseCount).toBe(0)
    expect(stats.firstPushFalseAtReadableLength).toBeNull()
  })

  it('stops tracking after stop() and further pushes are not counted', () => {
    const readable = new Readable({
      objectMode: true,
      highWaterMark: 1,
      read() {},
    })

    const monitor = monitorPushBackpressure(readable)

    readable.push('a')
    const stats = monitor.stop()

    // further pushes don't update stats
    readable.push('b')
    expect(stats.pushCount).toBe(1)
  })

  it('provides live stats via stats getter', () => {
    const readable = new Readable({
      objectMode: true,
      highWaterMark: 10,
      read() {},
    })

    const monitor = monitorPushBackpressure(readable)

    expect(monitor.stats.pushCount).toBe(0)
    readable.push('a')
    expect(monitor.stats.pushCount).toBe(1)
    readable.push('b')
    expect(monitor.stats.pushCount).toBe(2)

    monitor.stop()
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
