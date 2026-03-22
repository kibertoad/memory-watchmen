import { describe, expect, it } from 'vitest'

import { createTracker } from '../src/index.ts'

describe('createTracker', () => {
  it('tracks an object with a label', () => {
    const tracker = createTracker()
    const obj = { data: 'test' }
    const handle = tracker.track(obj, 'my-object')

    expect(handle.label).toBe('my-object')
    expect(handle.isCollected()).toBe(false)
  })

  it('auto-generates label when not provided', () => {
    const tracker = createTracker()
    const handle = tracker.track({ x: 1 })

    expect(handle.label).toMatch(/^object-\d+$/)
  })

  it('lists all handles', () => {
    const tracker = createTracker()
    tracker.track({ a: 1 }, 'first')
    tracker.track({ b: 2 }, 'second')

    const handles = tracker.handles()
    expect(handles).toHaveLength(2)
    expect(handles.map((h) => h.label)).toEqual(['first', 'second'])
  })
})
