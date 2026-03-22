import { setTimeout as sleep } from 'node:timers/promises'
import type { Readable, Writable } from 'node:stream'

import type { BufferBoundedOptions, StreamBufferSample, StreamMonitor, StreamSnapshot } from './types.ts'

type AnyStream = Readable | Writable | (Readable & Writable)

/**
 * Capture a one-shot snapshot of a stream's buffer and flow state.
 * Duck-typed to work with Readable, Writable, and Duplex streams.
 */
export function snapshotStreamState(stream: AnyStream): StreamSnapshot {
  const snapshot: StreamSnapshot = { timestamp: Date.now() }

  if ('readableLength' in stream && typeof stream.readableLength === 'number') {
    snapshot.readableLength = stream.readableLength
  }
  if ('readableHighWaterMark' in stream && typeof stream.readableHighWaterMark === 'number') {
    snapshot.readableHighWaterMark = stream.readableHighWaterMark
  }
  if ('readableFlowing' in stream) {
    snapshot.readableFlowing = stream.readableFlowing as boolean | null
  }
  if ('writableLength' in stream && typeof stream.writableLength === 'number') {
    snapshot.writableLength = stream.writableLength
  }
  if ('writableHighWaterMark' in stream && typeof stream.writableHighWaterMark === 'number') {
    snapshot.writableHighWaterMark = stream.writableHighWaterMark
  }
  if ('writableNeedDrain' in stream && typeof stream.writableNeedDrain === 'boolean') {
    snapshot.writableNeedDrain = stream.writableNeedDrain
  }

  return snapshot
}

/**
 * Monitor stream buffer sizes over time.
 * Returns a controller with `stop()` to end monitoring and retrieve all samples.
 */
export function monitorStreamBuffers(
  streams: AnyStream[],
  intervalMs = 100,
): StreamMonitor {
  const samples: StreamBufferSample[] = []

  const timer = setInterval(() => {
    for (let i = 0; i < streams.length; i++) {
      samples.push({
        streamIndex: i,
        snapshot: snapshotStreamState(streams[i]),
      })
    }
  }, intervalMs)

  return {
    get samples() {
      return samples
    },
    stop() {
      clearInterval(timer)
      return samples
    },
  }
}

/**
 * Assert that a stream's buffer stays within bounds over a monitoring period.
 *
 * Checks that readableLength and/or writableLength do not exceed
 * their respective highWaterMark multiplied by the given multiplier.
 */
export async function assertBufferBounded(
  stream: AnyStream,
  options?: BufferBoundedOptions,
): Promise<StreamSnapshot[]> {
  const intervalMs = options?.intervalMs ?? 100
  const durationMs = options?.durationMs ?? 5000
  const multiplier = options?.multiplier ?? 2.0
  const signal = options?.signal

  const snapshots: StreamSnapshot[] = []

  if (signal?.aborted) return snapshots

  const deadline = Date.now() + durationMs

  while (Date.now() < deadline) {
    if (signal?.aborted) break

    const snap = snapshotStreamState(stream)
    snapshots.push(snap)

    if (
      snap.readableLength !== undefined &&
      snap.readableHighWaterMark !== undefined &&
      snap.readableLength > snap.readableHighWaterMark * multiplier
    ) {
      throw new Error(
        `Readable buffer exceeded bounds: readableLength=${snap.readableLength} > ` +
          `highWaterMark(${snap.readableHighWaterMark}) * ${multiplier} = ${snap.readableHighWaterMark * multiplier}`,
      )
    }

    if (
      snap.writableLength !== undefined &&
      snap.writableHighWaterMark !== undefined &&
      snap.writableLength > snap.writableHighWaterMark * multiplier
    ) {
      throw new Error(
        `Writable buffer exceeded bounds: writableLength=${snap.writableLength} > ` +
          `highWaterMark(${snap.writableHighWaterMark}) * ${multiplier} = ${snap.writableHighWaterMark * multiplier}`,
      )
    }

    await sleep(intervalMs)
  }

  return snapshots
}

/**
 * Assert that a writable stream is currently experiencing backpressure.
 */
export function assertBackpressure(writable: Writable): void {
  if (!('writableNeedDrain' in writable)) {
    throw new Error('Stream does not have writableNeedDrain property')
  }
  if (!writable.writableNeedDrain) {
    throw new Error(
      `Expected backpressure (writableNeedDrain=true) but got false. ` +
        `writableLength=${writable.writableLength}, highWaterMark=${writable.writableHighWaterMark}`,
    )
  }
}

/**
 * Wait for a 'drain' event on a writable stream.
 * Resolves when drain fires, rejects on timeout.
 */
export async function assertDrainOccurred(writable: Writable, timeout = 5000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      writable.removeListener('drain', onDrain)
      reject(new Error(`Drain event did not fire within ${timeout}ms`))
    }, timeout)

    function onDrain() {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }

    writable.once('drain', onDrain)
  })
}

/**
 * Assert that a readable stream is currently in flowing mode.
 */
export function assertFlowing(readable: Readable): void {
  if (!('readableFlowing' in readable)) {
    throw new Error('Stream does not have readableFlowing property')
  }
  if (readable.readableFlowing !== true) {
    throw new Error(
      `Expected readableFlowing=true but got ${String(readable.readableFlowing)}`,
    )
  }
}
