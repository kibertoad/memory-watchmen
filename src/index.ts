export { forceGC, collectMemorySample, monitorHeap, formatHeapResult } from './heap-monitor.ts'
export { createTracker, trackObject, expectCollected } from './object-tracker.ts'
export {
  snapshotStreamState,
  monitorStreamBuffers,
  assertBufferBounded,
  assertBackpressure,
  assertDrainOccurred,
  assertFlowing,
} from './stream-assertions.ts'

export type {
  MemorySample,
  HeapMonitorOptions,
  HeapMonitorResult,
  TrackerHandle,
  ObjectTracker,
  CollectionOptions,
  StreamSnapshot,
  StreamBufferSample,
  StreamMonitor,
  BufferBoundedOptions,
  ProfileRequest,
  ProfileSummary,
  ApproachFn,
  ProfileServerOptions,
  ProfileResult,
  RunProfilesConfig,
  AssertNoLeakOptions,
  HeapMonitorContext,
} from './types.ts'
