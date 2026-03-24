export interface MemorySample {
  timestamp: number
  heapUsed: number
  heapTotal: number
  rss: number
  external: number
  arrayBuffers: number
}

export interface HeapMonitorOptions {
  /** Number of monitoring samples to collect (default: 15) */
  sampleCount?: number
  /** Milliseconds between samples (default: 1500) */
  sampleIntervalMs?: number
  /** Max consecutive growth samples before declaring monotonic leak (default: 10) */
  maxConsecutiveGrowth?: number
  /** Max MB of envelope drift between first and last third (default: 15) */
  maxEnvelopeGrowthMB?: number
}

export interface HeapMonitorResult {
  samples: number[]
  samplesMB: number[]
  consecutiveGrowth: number
  stabilized: boolean
  envelopeGrowthMB: number
  monotonicLeak: boolean
  envelopeLeak: boolean
  passed: boolean
}

export interface TrackerHandle {
  label: string
  isCollected(): boolean
}

export interface ObjectTracker {
  track(obj: object, label?: string): TrackerHandle
  expectCollected(handle: TrackerHandle, options?: CollectionOptions): Promise<void>
  expectAllCollected(options?: CollectionOptions): Promise<void>
  handles(): TrackerHandle[]
}

export interface CollectionOptions {
  /** Timeout in milliseconds before giving up (default: 5000) */
  timeout?: number
  /** Milliseconds between GC + check cycles (default: 100) */
  gcIntervalMs?: number
}

export interface StreamSnapshot {
  readableLength?: number
  readableHighWaterMark?: number
  readableFlowing?: boolean | null
  writableLength?: number
  writableHighWaterMark?: number
  writableNeedDrain?: boolean
  timestamp: number
}

export interface StreamBufferSample {
  streamIndex: number
  snapshot: StreamSnapshot
}

export interface StreamMonitor {
  stop(): StreamBufferSample[]
  readonly samples: StreamBufferSample[]
}

export interface BufferBoundedOptions {
  /** Milliseconds between checks (default: 100) */
  intervalMs?: number
  /** Duration to monitor in milliseconds (default: 5000) */
  durationMs?: number
  /** Multiplier over highWaterMark to consider out-of-bounds (default: 2.0) */
  multiplier?: number
  /** AbortSignal to cancel monitoring early */
  signal?: AbortSignal
}

export interface ProfileRequest {
  approach: string
  filePath: string
  multi?: boolean
  path?: string
  sampleIntervalMs?: number
}

export interface ProfileSummary {
  summary: true
  approach: string
  file: string
  fileSizeMB: number
  baseline: MemorySample
  peak: MemorySample
  peakHeapUsedMB: number
  baselineHeapUsedMB: number
  deltaHeapUsedMB: number
  totalSamples: number
  elapsedMs: number
}

export type ApproachFn = (
  filePath: string,
  multi: boolean,
  onSample: (s: MemorySample) => void,
  path?: string,
) => Promise<void>

export interface ProfileServerOptions {
  approaches: Map<string, ApproachFn>
  port?: number
}

export interface ProfileResult {
  approach: string
  file: string
  samples: MemorySample[]
  summary: ProfileSummary
}

export interface RunProfilesConfig {
  serverUrl?: string
  approaches: string[]
  files: { path: string; multi?: boolean; jsonPath?: string }[]
  outputDir: string
  sampleIntervalMs?: number
}

export interface AssertNoLeakOptions extends HeapMonitorOptions {
  /** Warm-up time in milliseconds before monitoring starts (default: 3000) */
  warmUpMs?: number
}

export interface HeapMonitorContext {
  /** Set to true to signal workload to stop */
  stopped: { value: boolean }
}

// --- Event Loop Monitoring ---

export interface EventLoopDelaySample {
  timestamp: number
  /** Minimum delay in milliseconds */
  min: number
  /** Maximum delay in milliseconds */
  max: number
  /** Mean delay in milliseconds */
  mean: number
  /** 50th percentile delay in milliseconds */
  p50: number
  /** 99th percentile delay in milliseconds */
  p99: number
  /** Number of delay measurements in this sample */
  count: number
}

export interface EventLoopUtilizationSample {
  timestamp: number
  /** Fraction of time the event loop was active (0–1) */
  utilization: number
  /** Milliseconds the event loop was idle */
  idle: number
  /** Milliseconds the event loop was active */
  active: number
}

export interface EventLoopMonitorOptions {
  /** Number of monitoring samples to collect (default: 20) */
  sampleCount?: number
  /** Milliseconds between samples (default: 500) */
  sampleIntervalMs?: number
  /** Histogram resolution in milliseconds (default: 20) — passed to monitorEventLoopDelay */
  resolution?: number
  /** Maximum p99 delay in milliseconds before declaring starvation (default: 100). Set to null to disable. */
  maxP99DelayMs?: number | null
  /** Maximum mean delay in milliseconds before declaring starvation (default: 50). Set to null to disable. */
  maxMeanDelayMs?: number | null
  /** Maximum event loop utilization (0–1) before declaring saturation (default: 0.95). Set to null to disable. */
  maxUtilization?: number | null
}

export interface EventLoopMonitorResult {
  delaySamples: EventLoopDelaySample[]
  utilizationSamples: EventLoopUtilizationSample[]
  /** Peak p99 delay across all samples (ms) */
  peakP99DelayMs: number
  /** Peak mean delay across all samples (ms) */
  peakMeanDelayMs: number
  /** Mean of all p99 delay samples (ms) */
  meanP99DelayMs: number
  /** Peak utilization across all samples (0–1) */
  peakUtilization: number
  /** Mean utilization across all samples (0–1) */
  meanUtilization: number
  /** Whether p99 delay exceeded the threshold */
  p99DelayExceeded: boolean
  /** Whether mean delay exceeded the threshold */
  meanDelayExceeded: boolean
  /** Whether utilization exceeded the threshold */
  utilizationExceeded: boolean
  /** True if all checks passed */
  passed: boolean
  /** Thresholds that were applied (resolved from options + defaults). null means the check was disabled. */
  thresholds: {
    maxP99DelayMs: number | null
    maxMeanDelayMs: number | null
    maxUtilization: number | null
  }
}

/** Alias for HeapMonitorContext — same shape, shared for convenience */
export type EventLoopMonitorContext = HeapMonitorContext

export interface AssertNoStarvationOptions extends EventLoopMonitorOptions {
  /** Warm-up time in milliseconds before monitoring starts (default: 1000) */
  warmUpMs?: number
}
