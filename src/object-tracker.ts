import { setTimeout as sleep } from 'node:timers/promises'

import { forceGC } from './heap-monitor.ts'
import type { CollectionOptions, ObjectTracker, TrackerHandle } from './types.ts'

interface TrackedEntry {
  label: string
  weakRef: WeakRef<object>
  collected: boolean
}

async function pollUntilCollected(
  check: () => boolean,
  label: string,
  options?: CollectionOptions,
): Promise<void> {
  const timeout = options?.timeout ?? 5000
  const gcIntervalMs = options?.gcIntervalMs ?? 100
  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    forceGC()
    if (check()) return
    await sleep(gcIntervalMs)
  }

  forceGC()
  if (check()) return

  throw new Error(
    `Object "${label}" was not garbage collected within ${timeout}ms. ` +
      'It may still be referenced somewhere.',
  )
}

/**
 * Create a tracker that monitors object garbage collection using
 * WeakRef and FinalizationRegistry.
 *
 * Tracks whether specific objects are properly released after use
 * using WeakRef for reachability checks and FinalizationRegistry
 * for collection notification.
 */
export function createTracker(): ObjectTracker {
  const entries = new Map<string, TrackedEntry>()
  let counter = 0

  const registry = new FinalizationRegistry((label: string) => {
    const entry = entries.get(label)
    if (entry) {
      entry.collected = true
    }
  })

  function track(obj: object, label?: string): TrackerHandle {
    const resolvedLabel = label ?? `object-${counter++}`
    const weakRef = new WeakRef(obj)

    const entry: TrackedEntry = { label: resolvedLabel, weakRef, collected: false }
    entries.set(resolvedLabel, entry)
    registry.register(obj, resolvedLabel)

    return {
      label: resolvedLabel,
      isCollected() {
        return entry.collected || entry.weakRef.deref() === undefined
      },
    }
  }

  async function expectCollected(handle: TrackerHandle, options?: CollectionOptions): Promise<void> {
    return pollUntilCollected(() => handle.isCollected(), handle.label, options)
  }

  async function expectAllCollected(options?: CollectionOptions): Promise<void> {
    const timeout = options?.timeout ?? 5000
    const gcIntervalMs = options?.gcIntervalMs ?? 100
    const deadline = Date.now() + timeout

    while (Date.now() < deadline) {
      forceGC()
      const allCollected = [...entries.values()].every(
        (e) => e.collected || e.weakRef.deref() === undefined,
      )
      if (allCollected) return
      await sleep(gcIntervalMs)
    }

    forceGC()
    const uncollected = [...entries.values()]
      .filter((e) => !e.collected && e.weakRef.deref() !== undefined)
      .map((e) => e.label)

    if (uncollected.length > 0) {
      throw new Error(
        `${uncollected.length} object(s) were not garbage collected within ${timeout}ms: ` +
          `${uncollected.join(', ')}`,
      )
    }
  }

  return {
    track,
    expectCollected,
    expectAllCollected,
    handles: () =>
      [...entries.values()].map((e) => ({
        label: e.label,
        isCollected: () => e.collected || e.weakRef.deref() === undefined,
      })),
  }
}

/**
 * Convenience: track a single object and return both the handle and its tracker.
 */
export function trackObject(
  obj: object,
  label?: string,
): { handle: TrackerHandle; tracker: ObjectTracker } {
  const tracker = createTracker()
  const handle = tracker.track(obj, label)
  return { handle, tracker }
}

/**
 * Convenience: poll forceGC until the handle reports collected, or throw on timeout.
 *
 * Works with handles from any tracker — uses forceGC + handle.isCollected()
 * directly rather than going through a tracker instance.
 */
export async function expectCollected(
  handle: TrackerHandle,
  options?: CollectionOptions,
): Promise<void> {
  return pollUntilCollected(() => handle.isCollected(), handle.label, options)
}
