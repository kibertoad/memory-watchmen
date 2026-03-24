# memory-watchmen

Memory and event loop testing for Node.js — heap monitoring, event loop delay and utilization tracking, object lifecycle verification, stream buffer assertions, and comparative profiling.

CI-friendly heap stability checks, event loop starvation detection via `perf_hooks`, object lifecycle tracking with WeakRef/FinalizationRegistry, stream buffer assertions, and an HTTP profiler with chart generation for comparing memory usage across implementations.

## Table of Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [API](#api)
  - [Heap Monitor](#heap-monitor)
  - [Event Loop Monitor](#event-loop-monitor)
  - [Object Tracker](#object-tracker)
  - [Stream Assertions](#stream-assertions)
  - [Test Helpers](#test-helpers)
  - [Profiler](#profiler)
- [CLI](#cli)
- [Memory Test Setup](#memory-test-setup)
- [When to Use memlab Instead](#when-to-use-memlab-instead)
- [When to Use memory-watchmen](#when-to-use-memory-watchmen)

## Install

```bash
npm install memory-watchmen
```

Requires Node.js >= 22.0.0.

## Quick Start

### Heap leak detection

```typescript
import { monitorHeap, forceGC, formatHeapResult } from 'memory-watchmen'

// Requires --expose-gc flag
forceGC()

const result = await monitorHeap()

if (!result.passed) {
  console.error(formatHeapResult(result, 'my workload'))
}
```

### Event loop starvation detection

```typescript
import { monitorEventLoop, formatEventLoopResult } from 'memory-watchmen'

// No special flags required — uses perf_hooks
const result = await monitorEventLoop({ maxP99DelayMs: 50 })

if (!result.passed) {
  console.error(formatEventLoopResult(result, 'my workload'))
}
```

## API

### Heap Monitor

```typescript
import { forceGC, collectMemorySample, monitorHeap, formatHeapResult } from 'memory-watchmen'
```

#### `forceGC()`

Double-pass garbage collection. Requires `--expose-gc` flag. Throws a clear error if unavailable.

Why double GC? `FinalizationRegistry` callbacks run asynchronously after GC, and V8 deferred tasks (weak callback processing, dead ephemeron cleanup) may not complete in a single cycle. Two calls empirically produce more stable readings. See [PATTERNS.md](./PATTERNS.md#why-double-gc) for details.

#### `collectMemorySample(): MemorySample`

Returns `{ timestamp, heapUsed, heapTotal, rss, external }` from `process.memoryUsage()`.

#### `monitorHeap(options?): Promise<HeapMonitorResult>`

Dual-metric leak detection over time:

1. **Monotonic growth** - heap grew every sample for N+ consecutive checks (tight leak)
2. **Envelope growth** - first-third avg vs last-third avg exceeds threshold (step-wise/burst leaks)

Options (all optional):
| Option | Default | Description |
|--------|---------|-------------|
| `sampleCount` | 15 | Number of monitoring samples |
| `sampleIntervalMs` | 1500 | Milliseconds between samples |
| `maxConsecutiveGrowth` | 10 | Consecutive growth before monotonic leak |
| `maxEnvelopeGrowthMB` | 15 | Max MB envelope drift |

Returns `HeapMonitorResult` with `passed: boolean` and diagnostic fields.

#### `formatHeapResult(result, context?): string`

Human-readable error message for failed results.

### Event Loop Monitor

```typescript
import { monitorEventLoop, formatEventLoopResult } from 'memory-watchmen'
```

#### `monitorEventLoop(options?): Promise<EventLoopMonitorResult>`

Monitors event loop delay and utilization over time using `perf_hooks.monitorEventLoopDelay` and `performance.eventLoopUtilization()`.

Two complementary checks:

1. **Delay** — p99 and mean event loop delay stay under thresholds (catches blocking code that starves the event loop)
2. **Utilization** — event loop active ratio stays under saturation threshold (catches CPU saturation — set to `null` to disable for workloads that are intentionally busy but responsive)

Options (all optional):
| Option | Default | Description |
|--------|---------|-------------|
| `sampleCount` | 20 | Number of monitoring samples |
| `sampleIntervalMs` | 500 | Milliseconds between samples |
| `resolution` | 20 | Histogram resolution in nanoseconds |
| `maxP99DelayMs` | 100 | Max p99 delay before starvation. Set to `null` to disable. |
| `maxMeanDelayMs` | 50 | Max mean delay before starvation. Set to `null` to disable. |
| `maxUtilization` | 0.95 | Max utilization (0–1) before saturation. Set to `null` to disable. |

Set any threshold to `null` to disable that specific check while keeping the others active. This is useful for workloads that are intentionally busy but responsive (high utilization, low delay):

```typescript
const result = await monitorEventLoop({
  maxP99DelayMs: 50,
  maxUtilization: null, // don't flag high utilization — only check delay
})
```

Returns `EventLoopMonitorResult` with `passed: boolean` and diagnostic fields including per-sample delay histograms and utilization ratios.

```typescript
const result = await monitorEventLoop({
  sampleCount: 10,
  sampleIntervalMs: 200,
  maxP99DelayMs: 50,
})

if (!result.passed) {
  console.error(formatEventLoopResult(result, 'my workload'))
}
```

#### `formatEventLoopResult(result, context?): string`

Human-readable error message for failed results.

#### `collectDelaySample(histogram): EventLoopDelaySample`

Low-level: read percentiles from a running `monitorEventLoopDelay` histogram.

#### `collectUtilizationSample(previous): EventLoopUtilizationSample`

Low-level: diff two `performance.eventLoopUtilization()` snapshots.

### Object Tracker

```typescript
import { createTracker, trackObject, expectCollected } from 'memory-watchmen'
```

#### `createTracker(): ObjectTracker`

Tracks objects with `WeakRef` + `FinalizationRegistry` to verify they get garbage collected.

```typescript
const tracker = createTracker()

let obj: object | null = { data: 'test' }
const handle = tracker.track(obj, 'my-object')

obj = null // release reference

await tracker.expectCollected(handle, { timeout: 5000 })
```

Methods:
- `tracker.track(obj, label?)` - returns a `TrackerHandle`
- `tracker.expectCollected(handle, options?)` - polls GC until collected, throws on timeout
- `tracker.expectAllCollected(options?)` - checks all tracked objects
- `tracker.handles()` - list all handles

#### `trackObject(obj, label?)`

Convenience: creates a one-off tracker, returns `{ handle, tracker }`.

#### `expectCollected(handle, options?)`

Standalone GC polling - works with handles from any tracker.

### Stream Assertions

```typescript
import {
  snapshotStreamState,
  monitorStreamBuffers,
  assertBufferBounded,
  assertBackpressure,
  assertDrainOccurred,
  assertFlowing,
} from 'memory-watchmen'
```

#### `snapshotStreamState(stream): StreamSnapshot`

Captures buffer and flow state once. Duck-typed, works with Readable, Writable, and Duplex.

Returns: `{ readableLength?, readableHighWaterMark?, readableFlowing?, writableLength?, writableHighWaterMark?, writableNeedDrain?, timestamp }`

#### `monitorStreamBuffers(streams[], intervalMs?): StreamMonitor`

Continuous monitoring. Call `monitor.stop()` to end and retrieve all samples.

#### `assertBufferBounded(stream, options?): Promise<StreamSnapshot[]>`

Checks periodically that buffer sizes stay within `highWaterMark * multiplier`. Throws on violation.

Options: `{ intervalMs?, durationMs?, multiplier?, signal? }`

#### `assertBackpressure(writable)`, `assertFlowing(readable)`

Sync assertions on current stream state.

#### `assertDrainOccurred(writable, timeout?): Promise<void>`

Resolves when `'drain'` fires, rejects on timeout.

### Test Helpers

```typescript
import {
  assertNoLeak, withHeapMonitor,
  assertNoStarvation, withEventLoopMonitor,
} from 'memory-watchmen/vitest'
```

All test helpers run the workload function **concurrently** with monitoring. The execution model:

1. Your function `fn(ctx)` starts running (not awaited — it runs in the background)
2. Warm-up period elapses
3. Monitoring collects samples
4. `ctx.stopped.value` is set to `true` — signalling your workload to stop
5. The helper awaits your function's promise to let it clean up

This means `fn` can use `while (!ctx.stopped.value)` loops with `await` inside — they will exit naturally when monitoring completes. The `assert*` variants throw on failure; the `with*` variants return the result for custom assertions.

#### `assertNoLeak(fn, options?)`

Runs a function and asserts it doesn't leak. Throws with a diagnostic message on failure. The workload runs concurrently with monitoring — check `ctx.stopped.value` to know when to stop.

```typescript
await assertNoLeak(async (ctx) => {
  while (!ctx.stopped.value) {
    doWork()
    await sleep(10)
  }
})
```

#### `withHeapMonitor(testFn, options?): Promise<HeapMonitorResult>`

Wraps a test function with heap monitoring. Does NOT throw — returns the result for custom assertions.

```typescript
const result = await withHeapMonitor(async (ctx) => {
  while (!ctx.stopped.value) {
    doWork()
    await sleep(10)
  }
})
expect(result.passed, formatHeapResult(result, 'streaming')).toBe(true)
```

#### `assertNoStarvation(fn, options?)`

Runs a function and asserts it doesn't starve the event loop. Throws with a diagnostic message if p99 delay, mean delay, or utilization exceed thresholds. The workload runs concurrently with monitoring — check `ctx.stopped.value` to know when to stop.

```typescript
await assertNoStarvation(async (ctx) => {
  while (!ctx.stopped.value) {
    doCpuWork()
    await new Promise(resolve => setImmediate(resolve))
  }
}, { maxP99DelayMs: 50, maxUtilization: null })
```

Does not require `--expose-gc` — uses `perf_hooks` APIs that work in any Node.js process.

#### `withEventLoopMonitor(testFn, options?): Promise<EventLoopMonitorResult>`

Wraps a test function with event loop monitoring. Does NOT throw — returns the result for custom assertions.

```typescript
const result = await withEventLoopMonitor(async (ctx) => {
  while (!ctx.stopped.value) {
    doCpuWork()
    await new Promise(resolve => setImmediate(resolve))
  }
}, { maxUtilization: null })
expect(result.passed, formatEventLoopResult(result, 'processing')).toBe(true)
```

### Profiler

HTTP-based memory comparison tool. Register "approach" functions that process a file, the server runs them while sampling `process.memoryUsage()`, and streams NDJSON samples back. Compare memory behavior of different implementations side-by-side.

#### Step 1: Define approaches

Create a file that exports your approaches as a Map:

```typescript
// my-approaches.ts
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Writable } from 'node:stream'
import { collectMemorySample } from 'memory-watchmen'
import type { ApproachFn, MemorySample } from 'memory-watchmen'

const approaches = new Map<string, ApproachFn>()

approaches.set('native-json-parse', async (filePath, _multi, onSample) => {
  const { readFile } = await import('node:fs/promises')
  const content = await readFile(filePath, 'utf-8')
  onSample(collectMemorySample())
  JSON.parse(content)
  onSample(collectMemorySample())
})

approaches.set('streaming-parse', async (filePath, _multi, onSample) => {
  await pipeline(
    createReadStream(filePath),
    new Writable({
      write(chunk, _enc, cb) {
        onSample(collectMemorySample())
        cb()
      },
    }),
  )
})

export default approaches
```

Call `onSample(collectMemorySample())` at meaningful points - the server also samples on a timer, so you don't need to call it on every chunk.

#### Step 2: Start the server and profile

```typescript
import { createProfileServer } from 'memory-watchmen/profiler'
import { runProfile } from 'memory-watchmen/profiler/runner'
import { generateChart } from 'memory-watchmen/profiler/chart'
import { writeFile } from 'node:fs/promises'

// Programmatic usage
const server = createProfileServer({ approaches, port: 3847 })

const result = await runProfile('native-json-parse', '/path/to/data.json', false)
console.log(`Peak: ${result.summary.peakHeapUsedMB} MB`)

// Generate chart from multiple runs
const results = [
  await runProfile('native-json-parse', '/path/to/data.json', false),
  await runProfile('streaming-parse', '/path/to/data.json', false),
]
const html = generateChart(results)
await writeFile('chart.html', html)
```

#### Step 3: Batch profiling with output directory

```typescript
import { runProfiles } from 'memory-watchmen/profiler/runner'

const results = await runProfiles({
  approaches: ['native-json-parse', 'streaming-parse'],
  files: [
    { path: '/path/to/small.json' },
    { path: '/path/to/large.ndjson', multi: true },
  ],
  outputDir: './profile-results',
  sampleIntervalMs: 100,
})

// Output directory contains:
//   summary.json     - peak/baseline/delta per approach
//   chart-data.json  - time-series for external tools
//   report.txt       - ASCII comparison table
//   samples/         - raw NDJSON per approach
```

## CLI

```bash
# Start profiler server with custom approaches
memory-watchmen serve --config ./my-approaches.ts --port 3847

# Run a single profile against a running server
memory-watchmen profile --approach native-json-parse --file data.json

# Generate HTML chart from results directory
memory-watchmen chart --input ./profile-results --output ./report
```

## Memory Test Setup

### With Vitest

`--expose-gc` is a V8 flag that only works with process-level `execArgv`, not `worker_threads`. Vitest must use `pool: 'forks'` (which forks child processes) and `execArgv` to propagate the flag:

```typescript
// vitest.memory.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    execArgv: ['--expose-gc'],
    include: ['test/memory/**/*.memory-test.ts'],
    testTimeout: 180_000,
  },
})
```

package.json scripts:
```json
{
  "test:memory": "vitest run --config vitest.memory.config.ts"
}
```

No `NODE_OPTIONS` or `cross-env` needed - `execArgv` in the vitest config handles propagation explicitly.

### With node:test

```json
{
  "test:memory": "NODE_OPTIONS='--expose-gc' node --test 'test/**/*.memory-test.ts'"
}
```

## When to Use memlab Instead

Reach for [memlab](https://github.com/nicolo-ribaudo/memlab) when you need:

- Retainer traces showing the full reference chain (which object leaked and why)
- Browser/DOM leak detection with Puppeteer
- React fiber/hook analysis (detached fiber detection)
- Object-level heap snapshot diffing
- Retained size and dominator tree analysis

## When to Use memory-watchmen

- Process-level heap stability checks that run in CI
- Event loop starvation detection — verify CPU-bound work yields properly
- Event loop utilization tracking — ensure the loop isn't saturated under load
- Leak detection during sustained streaming/backpressure load
- Checking that objects actually get collected (WeakRef/FinalizationRegistry)
- Stream buffer assertions (readableLength, writableNeedDrain, etc.)
- Comparing memory profiles across implementations with chart generation

## License

MIT
