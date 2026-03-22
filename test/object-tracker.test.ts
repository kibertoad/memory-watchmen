import { describe, expect, it } from 'vitest'

import { createTracker, trackObject } from '../src/index.ts'

describe('createTracker', () => {
  it('tracks an object and reports it as not yet collected', () => {
    const tracker = createTracker()
    const obj = { data: 'test' }
    const handle = tracker.track(obj, 'my-object')

    expect(handle.label).toBe('my-object')
    // Object is still strongly referenced by `obj`, so it cannot be collected
    expect(handle.isCollected()).toBe(false)
  })

  it('auto-generates unique labels', () => {
    const tracker = createTracker()
    const h1 = tracker.track({})
    const h2 = tracker.track({})

    expect(h1.label).not.toBe(h2.label)
    expect(h1.label).toMatch(/^object-\d+$/)
  })

  it('lists all tracked handles', () => {
    const tracker = createTracker()
    // Hold references to prevent GC
    const a = { a: 1 }
    const b = { b: 2 }
    tracker.track(a, 'first')
    tracker.track(b, 'second')

    const handles = tracker.handles()
    expect(handles).toHaveLength(2)
    expect(handles.map((h) => h.label)).toContain('first')
    expect(handles.map((h) => h.label)).toContain('second')
  })
})

describe('trackObject', () => {
  it('returns both handle and tracker', () => {
    const obj = { x: 1 }
    const { handle, tracker } = trackObject(obj, 'test-obj')

    expect(handle.label).toBe('test-obj')
    expect(handle.isCollected()).toBe(false)
    expect(tracker.handles()).toHaveLength(1)
  })
})
