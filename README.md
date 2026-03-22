# memory-watchmen

Memory testing, profiling, and leak detection for Node.js -- heap monitoring, object lifecycle tracking, stream buffer assertions, and comparative profiling.

Provides CI-friendly tools for verifying memory behavior under streaming/backpressure workloads, tracking object lifecycle via WeakRef/FinalizationRegistry, and comparing memory usage across implementations with an HTTP-based profiler and chart generation.

## Install

```bash
npm install memory-watchmen
```

Requires Node.js >= 22.0.0.

## Quick Start

```typescript
import { monitorHeap, forceGC, formatHeapResult } from 'memory-watchmen'

// Requires --expose-gc flag
forceGC()

const result = await monitorHeap()

if (!result.passed) {
  console.error(formatHeapResult(result, 'my workload'))
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

1. **Monotonic growth** -- heap grew every sample for N+ consecutive checks (tight leak)
2. **Envelope growth** -- first-third avg vs last-third avg exceeds threshold (step-wise/burst leaks)

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

### Object Tracker

```typescript
import { createTracker, trackObject, expectCollected } from 'memory-watchmen'
```

#### `createTracker(): ObjectTracker`

Creates a tracker using `WeakRef` + `FinalizationRegistry` to verify objects are garbage collected.

```typescript
const tracker = createTracker()

let obj: object | null = { data: 'test' }
const handle = tracker.track(obj, 'my-object')

obj = null // release reference

await tracker.expectCollected(handle, { timeout: 5000 })
```

Methods:
- `tracker.track(obj, label?)` -- returns a `TrackerHandle`
- `tracker.expectCollected(handle, options?)` -- polls GC until collected, throws on timeout
- `tracker.expectAllCollected(options?)` -- checks all tracked objects
- `tracker.handles()` -- list all handles

#### `trackObject(obj, label?)`

Convenience: creates a one-off tracker, returns `{ handle, tracker }`.

#### `expectCollected(handle, options?)`

Standalone GC polling -- works with handles from any tracker.

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

One-shot capture of buffer and flow state. Duck-typed for Readable, Writable, and Duplex.

Returns: `{ readableLength?, readableHighWaterMark?, readableFlowing?, writableLength?, writableHighWaterMark?, writableNeedDrain?, timestamp }`

#### `monitorStreamBuffers(streams[], intervalMs?): StreamMonitor`

Continuous monitoring. Call `monitor.stop()` to end and retrieve all samples.

#### `assertBufferBounded(stream, options?): Promise<StreamSnapshot[]>`

Periodic checks that buffer sizes stay within `highWaterMark * multiplier`. Throws on violation.

Options: `{ intervalMs?, durationMs?, multiplier?, signal? }`

#### `assertBackpressure(writable)`, `assertFlowing(readable)`

Sync assertions on current stream state.

#### `assertDrainOccurred(writable, timeout?): Promise<void>`

Resolves when `'drain'` fires, rejects on timeout.

### Test Helpers

```typescript
import { assertNoLeak, withHeapMonitor } from 'memory-watchmen/vitest'
```

#### `assertNoLeak(fn, options?)`

Run a function and assert it doesn't leak. Throws with diagnostic message on failure.

```typescript
await assertNoLeak(async (ctx) => {
  const interval = setInterval(() => {
    if (ctx.stopped.value) { clearInterval(interval); return }
    doWork()
  }, 10)
})
```

#### `withHeapMonitor(testFn, options?): Promise<HeapMonitorResult>`

Wraps a test function with heap monitoring. Does NOT throw -- returns the result for custom assertions.

```typescript
const result = await withHeapMonitor(async (ctx) => {
  startStreaming()
})
expect(result.passed, formatHeapResult(result, 'streaming')).toBe(true)
```

### Profiler

The profiler is an HTTP-based memory comparison tool. You register "approach" functions that process a file, the server runs them while sampling `process.memoryUsage()` at regular intervals, and streams NDJSON samples back. This lets you compare memory behavior of different implementations side-by-side.

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

Call `onSample(collectMemorySample())` at meaningful points -- the server also samples on a timer, so you don't need to call it on every chunk.

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
//   summary.json     -- peak/baseline/delta per approach
//   chart-data.json  -- time-series for external tools
//   report.txt       -- ASCII comparison table
//   samples/         -- raw NDJSON per approach
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

```json
// package.json scripts
{
  "test:memory": "vitest run --config vitest.memory.config.ts"
}
```

No `NODE_OPTIONS` or `cross-env` needed -- `execArgv` in the vitest config handles propagation explicitly.

### With node:test

```json
{
  "test:memory": "NODE_OPTIONS='--expose-gc' node --test 'test/**/*.memory-test.ts'"
}
```

## When to Use memlab Instead

Use [memlab](https://github.com/nicolo-ribaudo/memlab) when you need:

- **Which object leaked** -- retainer traces showing the full reference chain
- **Browser/DOM leak detection** -- Puppeteer-driven E2E testing
- **React fiber/hook analysis** -- built-in detached fiber detection
- **Heap snapshot diffing** -- object-level comparison across actions
- **Dominator tree analysis** -- understanding retained size hierarchies

## When to Use memory-watchmen

- **CI-friendly** process-level heap stability checks
- **Streaming/backpressure** leak detection during sustained load
- **Object collection verification** via WeakRef/FinalizationRegistry
- **Stream buffer assertions** (readableLength, writableNeedDrain, etc.)
- **Comparative memory profiling** with chart generation

## License

MIT
