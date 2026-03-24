# Memory Testing Patterns for Node.js

Best practices and patterns for detecting memory leaks, optimizing memory usage, and testing streaming workloads in Node.js.

## Table of Contents

- [GC is Non-Deterministic](#gc-is-non-deterministic)
- [Why Call gc() Twice?](#why-call-gc-twice)
- [Warm-Up Periods](#warm-up-periods)
- [Dual-Metric Leak Detection](#dual-metric-leak-detection)
- [Sample Count and Interval Tuning](#sample-count-and-interval-tuning)
- [CI Considerations](#ci-considerations)
- [Event Loop Delay and Utilization](#event-loop-delay-and-utilization)
  - [Why Monitor the Event Loop?](#why-monitor-the-event-loop)
  - [Event Loop Delay](#event-loop-delay-monitoreventloopdelay)
  - [Event Loop Utilization](#event-loop-utilization-performanceeventlooputilization)
  - [CI Considerations for Timing-Sensitive Tests](#ci-considerations-for-timing-sensitive-tests)
  - [When Delay vs Utilization Matters](#when-delay-vs-utilization-matters)
  - [Starvation vs Saturation](#starvation-vs-saturation)
  - [Mixed Sync/Async Workloads](#mixed-syncasync-workloads)
  - [Placebo-Controlled Testing](#placebo-controlled-testing)
- [Profiler Workflow](#profiler-workflow)
- [Forking, Workers, and --expose-gc](#forking-workers-and---expose-gc)
- [Stream Backpressure Testing](#stream-backpressure-testing)
- [WeakRef and FinalizationRegistry](#weakref-and-finalizationregistry)
- [Memory Metrics](#memory-metrics)
- [Common Node.js Leak Sources](#common-nodejs-leak-sources)
- [Debugging Tools](#debugging-tools)
- [Prior Art and References](#prior-art-and-references)
- [Further Reading](#further-reading)

## GC is Non-Deterministic

V8's garbage collector is non-deterministic. It uses incremental marking, concurrent sweeping, and generational collection. When and what kind of GC runs (minor Scavenge vs major Mark-Sweep) is decided by V8 based on allocation pressure, not by you.

Memory tests should look for **trends over time**, not exact values. A single snapshot is meaningless. Always use multiple samples with forced GC and accept that some noise is inevitable.

`--expose-gc` exposes V8's gc extension; automatic GC still runs normally, and manual calls are supplemental. However, manually-triggered GC calls block the event loop during synchronous execution and should never be used in production - only in test scripts.

## Why Call gc() Twice?

Calling `global.gc()` twice increases measurement stability:

```typescript
function forceGC(): void {
  global.gc()
  global.gc()
}
```

Why two calls help:

1. **FinalizationRegistry**: Cleanup callbacks run asynchronously in a separate cleanup phase after GC, not during the GC pause itself and not as part of the normal microtask queue. A second `gc()` call gives those callbacks time to execute, and the resulting dereferenced objects can then be collected in the second cycle.
2. **Weak container cleanup**: `WeakMap`/`WeakSet` use ephemeron semantics - V8 resolves ephemeron reachability within a single GC cycle, but objects that become unreachable as a *consequence* of ephemeron resolution may not be collected until the next cycle. A second `gc()` call reclaims these transitively freed objects.
3. **V8-internal deferred tasks**: GC-related tasks like C++ pointers cleanup, weak callback processing, and finalization can be deferred until the thread is idle. A second `gc()` processes these deferred tasks.

Note: `global.gc()` typically triggers a synchronous major GC cycle, but V8 may still defer certain cleanup tasks (e.g., finalization callbacks), so it should not be treated as a guarantee of full memory reclamation. Minor GC can be requested via `gc(true)` or `gc({ type: 'minor' })`, but these APIs are undocumented and not stable across Node.js/V8 versions - avoid relying on them in tests. The full GC is deterministic in *what* it collects - there is no randomness in whether reachable objects survive. The non-determinism in memory testing comes from *when* V8's automatic GC runs between your samples, measurement timing, and cleanup callback scheduling.

The point is measurement stability, not a correctness guarantee. Two calls just produce more consistent readings than one.

Always run with `--expose-gc`. In test scripts: `NODE_OPTIONS=--expose-gc`.

## Warm-Up Periods

Measurements right after process start are noisy because of:

- **JIT compilation**: V8 compiles hot functions on first use, allocating code objects.
- **Inline caches and hidden classes**: V8 stabilizes object shapes and call-site caches after repeated calls, causing initial allocation spikes.
- **Lazy initialization**: Modules, caches, and pools initialize on first access.
- **Buffer pool priming**: Node.js allocates internal buffer pools on first I/O.

Wait long enough for the workload to reach steady state (often a few seconds, but should be validated for your specific workload - JIT thresholds, CPU speed, and allocation patterns all affect warm-up duration).

```typescript
// Start workload
startStreaming()

// Wait for warm-up
await sleep(3000)

// Now monitor
const result = await monitorHeap()
```

## Dual-Metric Leak Detection

Two complementary checks catch different leak patterns:

### Monotonic Growth

Heap grew every sample for N+ consecutive checks. Catches tight leaks where every operation adds memory.

Examples: event listeners accumulating on every request, Map entries never deleted, closures capturing scope in a loop.

Default threshold is 10 consecutive growth samples. Lower values increase false positives from GC timing jitter.

**Important**: This check is most reliable when GC is forced before each sample (which `monitorHeap` does). Without forced GC, V8's non-deterministic collection timing can create false streaks of growth that aren't actual leaks. Conversely, tests that rely on forced GC may miss leaks that only appear under natural GC scheduling in production - forced GC can create artificial stability that masks real-world behavior.

### Envelope Growth

Compare the average of the first third of samples to the last third. Catches step-wise or burst leaks that aren't monotonic.

Examples: memory grows in bursts (batch processing) then partially reclaims, buffer pool expansions that don't shrink, periodic cache rebuilds that grow over time.

Default threshold is 15 MB drift. Adjust based on workload size.

### Why Both?

- Monotonic catches leaks that plateau briefly (GC reclaims *some* garbage, but net trend is up). Envelope misses these if the middle third dips.
- Envelope catches leaks where occasional GC passes break the consecutive growth streak. Monotonic misses these because growth isn't unbroken.

## Sample Count and Interval Tuning

The default window is **15 samples x 1.5s = 22.5 seconds**. This balances:

| Factor | Fewer/shorter | More/longer |
|--------|---------------|-------------|
| Test time | Faster CI | Slower CI |
| Sensitivity | More false positives | Catches slower leaks |
| GC noise | More affected | Averaged out |

For fast leaks (streams, tight loops): reduce interval to 500ms, keep 15 samples.
For slow leaks (connection pools, caches): increase to 2000ms and 20 samples.

Allocation rate matters. High-allocation workloads tolerate shorter intervals because GC runs often and samples are more meaningful. Low-allocation workloads need longer windows to separate signal from noise.

## CI Considerations

Run memory tests in isolation. Parallel tests distort GC and memory signals because:
- Other tests' allocations affect heap size
- GC pauses from other tests create measurement jitter
- Shared process memory (if using worker threads) conflates signals

Vitest config for memory tests:

```typescript
// vitest.memory.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',             // required: worker_threads rejects --expose-gc
    execArgv: ['--expose-gc'],  // propagated to forked workers via execArgv
    include: ['test/memory/**/*.memory-test.ts'],
    testTimeout: 180_000,
  },
})
```

Do not rely on `NODE_OPTIONS=--expose-gc` for vitest - it applies to the vitest process itself but may not propagate to workers depending on the pool type. The `execArgv` config is explicit and reliable.

## Event Loop Delay and Utilization

### Why Monitor the Event Loop?

CPU-bound operations in Node.js block the event loop, preventing I/O callbacks, timers, and incoming requests from being processed. Libraries like [butter-spread](https://www.npmjs.com/package/butter-spread) chunk blocking work and yield between chunks via `setImmediate`, but verifying that the loop remains responsive requires measurement.

Two complementary metrics:

### Event Loop Delay (`monitorEventLoopDelay`)

Node.js (14+) provides `perf_hooks.monitorEventLoopDelay()`, a histogram-based sampler that measures how long the event loop was blocked between turns. It uses a libuv timer internally — each time the timer fires, the elapsed time since it was expected to fire is recorded as the delay.

**How it works under blocking conditions**: The histogram's internal timer is scheduled at `resolution` intervals. When the event loop is blocked (e.g., by a 200ms CPU-bound operation), the timer can't fire until the block ends and the event loop resumes. When it finally fires, it records the full blocking duration (~200ms) as a single measurement. This means even one yield (via `setImmediate`) between blocking periods is enough to capture the delay — you don't need frequent yields for accurate measurement.

**Important**: The workload being monitored must yield periodically (e.g., via `setImmediate`) for the histogram to record any measurements at all. A workload that never yields produces `count: 0` samples with `NaN` mean — because the histogram's timer never gets a chance to fire. This is not a limitation of the tool; a workload that never yields also hangs the process entirely. Any practical starvation test must include yields, and those yields are sufficient for the histogram to capture blocking duration.

Key properties:
- **Resolution**: configurable in milliseconds (default 20ms). Lower resolution = finer-grained measurements but more overhead.
- **Percentiles**: p50, p99, min, max, mean — the histogram records values in nanoseconds. p99 is the most useful for starvation detection because occasional GC pauses inflate max but are normal.
- **Count**: number of delay measurements in the sample period. A count of 0 means the event loop was blocked for the entire sample interval — the workload is not yielding.

```typescript
import { monitorEventLoopDelay } from 'node:perf_hooks'

const histogram = monitorEventLoopDelay({ resolution: 20 })
histogram.enable()

// ... let workload run ...

console.log(`p99: ${histogram.percentile(99) / 1e6}ms`)
histogram.reset() // reset for next sample window
```

### Event Loop Utilization (`performance.eventLoopUtilization`)

Node.js (14.10+) provides `performance.eventLoopUtilization()`, which returns `{ idle, active, utilization }` — the fraction of time the loop spent active vs idle. Diffing two snapshots gives utilization over an interval.

- **utilization = 0**: loop is completely idle (no work)
- **utilization = 1**: loop is 100% active (saturated, no idle time)
- **Typical healthy range**: 0.1–0.85 depending on workload

This catches a different signal than delay. A loop can have low delay (each turn completes quickly) but high utilization (turns fire back-to-back with no idle gaps). Conversely, a loop with one long-blocking operation shows high delay but utilization might not look extreme over a long sample window.

### CI Considerations for Timing-Sensitive Tests

Event loop delay is sensitive to system load, unlike heap measurements. In CI:

- **Use percentiles, not max**: A single GC pause or OS scheduling hiccup inflates max. p99 is more stable.
- **Use generous thresholds**: CI machines share CPUs. A threshold of 10ms that passes locally may flake in CI. Start with 50–100ms for p99 and tighten after observing baseline.
- **Warm up before measuring**: JIT compilation and module loading cause initial delay spikes. Wait 500–1000ms before sampling.
- **Use relative assertions when possible**: "delay didn't grow over time" is more robust than "delay < Xms". Compare first-half samples to second-half samples.
- **Sample count matters**: More samples smooth out noise. 10–20 samples at 200–500ms intervals gives 2–10 seconds of signal — enough to detect sustained starvation while tolerating transient spikes.

### When Delay vs Utilization Matters

| Scenario | Delay | Utilization | What to check |
|----------|-------|-------------|---------------|
| One chunk blocks for 200ms then yields | High p99 | Moderate | Delay (starvation) |
| Many 1ms chunks with no idle gaps | Low p99 | High (near 1.0) | Delay only — utilization is expected |
| Cooperative chunking with `setImmediate` yield | Low p99 | High (near 1.0) | Delay only (`maxUtilization: null`) |
| Idle server waiting for requests | Low p99 | Low | Both |

For cooperative workloads that yield between chunks, **delay** is the primary metric — you want to verify that individual blocking periods stay short. High utilization is expected and healthy for these workloads because the event loop is actively processing work, not blocked. Use `maxUtilization: null` to disable the utilization check for these cases.

### Starvation vs Saturation

These are distinct states that require different thresholds:

- **Starvation** = timers and I/O callbacks can't fire promptly → high delay. This is always bad.
- **Saturation** = the event loop is busy but callbacks still fire on time → high utilization, low delay. This can be optimal for CPU-bound workloads that yield cooperatively.

A workload that properly yields via `setImmediate` between chunks will show ~100% utilization (the loop is never idle) but low p99 delay (each turn completes quickly). This is the desired outcome — the CPU is fully utilized while remaining responsive.

The default `maxUtilization: 0.95` will flag this as a failure. For busy-but-responsive workloads, disable the utilization check:

```typescript
await assertNoStarvation(async (ctx) => {
  while (!ctx.stopped.value) {
    processChunk()
    await new Promise(resolve => setImmediate(resolve))
  }
}, {
  maxP99DelayMs: 100,
  maxMeanDelayMs: 50,
  maxUtilization: null, // disable — high utilization is expected
})
```

### Mixed Sync/Async Workloads

Workloads that alternate between synchronous and asynchronous operations will show higher delay measurements than pure sync workloads due to Promise microtask overhead:

1. `Promise.resolve()` wrapping creates microtask queue entries
2. `await` in the executor suspends and resumes for each async chunk
3. Each async-to-sync transition involves scheduling overhead

Expect p99 delays of ~60–100ms for mixed workloads vs ~30ms for pure sync workloads of equivalent CPU cost. Adjust thresholds accordingly — this is inherent to the async machinery, not a sign of starvation.

### Placebo-Controlled Testing

A placebo test pairs each starvation test with a matching workload that does the same CPU work *without* the library's yielding mechanism. This proves the library is actively preventing starvation — not just that the workload is too light to cause it.

```typescript
const items = Array.from({ length: 10_000 }, (_, i) => i)
function cpuBurn(item: number) {
  const end = Date.now() + 2
  while (Date.now() < end) { /* busy */ }
}

const monitorOpts = {
  warmUpMs: 200,
  sampleCount: 4,
  sampleIntervalMs: 200,
  maxP99DelayMs: 100,
  maxMeanDelayMs: 50,
  maxUtilization: null, // busy-but-responsive
}

// Positive: with the library's chunked execution → should pass
it('does not starve with chunked execution', async () => {
  await assertNoStarvation(async (ctx) => {
    while (!ctx.stopped.value) {
      await executeChunksWithYielding(items, cpuBurn)
    }
  }, monitorOpts)
})

// Placebo: same work, no yielding → should fail
it('placebo: raw loop starves the event loop', async () => {
  const result = await withEventLoopMonitor(async (ctx) => {
    while (!ctx.stopped.value) {
      for (const item of items) { cpuBurn(item) }
      await new Promise<void>(resolve => setImmediate(resolve)) // yield between batches so monitoring can measure
    }
  }, { ...monitorOpts, maxP99DelayMs: 10, maxMeanDelayMs: 5 })

  expect(result.passed).toBe(false)
})
```

**The placebo must yield via `setImmediate` between batches.** Without yields, the histogram's internal timer never fires, producing `count: 0` samples with no delay data. This is not a flaw — it just means the workload blocked the entire process including the measurement infrastructure. The `setImmediate` yield gives the histogram one chance per batch to record the blocking duration, which is all it needs. The yield itself adds negligible time (<1ms) compared to the blocking work, so it doesn't meaningfully reduce the starvation signal.

The key difference between the positive and placebo tests is *where* the yielding happens:
- **Positive test**: the library yields *within* each batch (between chunks), keeping individual blocking periods short → low p99 delay
- **Placebo test**: `setImmediate` yields only *between* full batches, so each batch blocks for its entire duration → high p99 delay

## Profiler Workflow

The profiler answers "which approach uses less memory?" not "is there a leak?". Use `monitorHeap()` for leak detection and the profiler for optimization work.

### Designing Approach Functions

Each approach function receives `(filePath, multi, onSample, path?)` and should:

1. **Call `onSample(collectMemorySample())` at meaningful points** - after loading data, after processing a batch, after cleanup. The server also samples on a timer, so you don't need to sample every iteration.
2. **Process the entire file** - the profiler measures peak/baseline/delta over the full run.
3. **Avoid caching between runs** - each approach should start from a clean state.

### Collecting Enough Samples for Useful Charts

The server samples on a configurable timer (default 20ms) in addition to manual `onSample()` calls. For useful charts:

- **Short-lived workloads** (< 1 second): decrease `sampleIntervalMs` to 5-10ms to capture the peak.
- **Long-running workloads** (> 10 seconds): 20-200ms intervals are fine; you'll get hundreds of samples.
- **Comparative runs**: keep the same `sampleIntervalMs` across approaches for fair comparison.

The chart normalizes all timestamps to relative (t=0 at first sample), so runs of different durations are still comparable visually.

### Interpreting Results

| Metric | Meaning |
|--------|---------|
| **Baseline** | Heap after forced GC before work starts |
| **Peak** | Maximum `heapUsed` during the run |
| **Delta** | Peak minus baseline - the memory cost of the workload |

A low delta means the approach avoids materializing large intermediate structures. Compare deltas across approaches to find what's most memory-efficient.

## Forking, Workers, and `--expose-gc`

### `--expose-gc` Does Not Propagate Automatically

The `--expose-gc` flag is a V8 flag that only applies to the process it was passed to. It does **not** propagate to:
- Child processes created with `child_process.fork()`
- Worker threads created with `worker_threads.Worker`
- Processes spawned with `child_process.spawn()` or `exec()`

You must explicitly pass the flag to each process or thread that needs it.

### Child Processes (`child_process.fork`)

```typescript
import { fork } from 'node:child_process'

// GC is NOT available in the child - --expose-gc was not passed
const bad = fork('./worker.js')

// GC IS available in the child
const good = fork('./worker.js', [], {
  execArgv: ['--expose-gc'],
})
```

The profiler server uses `fork()` internally and handles this for you:

```typescript
import { startServer } from 'memory-watchmen/profiler/runner'

// startServer already passes --expose-gc via execArgv
const server = await startServer('./my-server.ts', 3847)
```

### Worker Threads

```typescript
import { Worker } from 'node:worker_threads'

// GC is NOT available in the worker
const bad = new Worker('./worker.js')

// GC IS available in the worker
const good = new Worker('./worker.js', {
  execArgv: ['--expose-gc'],
})
```

### `NODE_OPTIONS` Environment Variable

`NODE_OPTIONS=--expose-gc` applies to the initial Node.js process and any child processes that inherit the environment (which is the default for `fork()` and `spawn()`). However:

- Worker threads do **not** inherit `NODE_OPTIONS` by default.
- Test runners (vitest, jest) may spawn workers without propagating `NODE_OPTIONS` to their execution context. The environment variable is inherited by forked child processes, but whether the runner actually uses it as `execArgv` depends on the runner's pool implementation. As of vitest 4.x: the default `threads` pool uses `worker_threads`, which does not support `--expose-gc` at all; the `forks` pool uses `child_process.fork()`, which inherits the environment but still benefits from explicit `execArgv` configuration for clarity.

### Test Runner Considerations

**Vitest** (4.x): The default pool (`threads`) uses `worker_threads`, which **cannot use `--expose-gc`**. For memory tests, use `pool: 'forks'` with explicit `execArgv: ['--expose-gc']` (see the CI config example above). Do not rely on `NODE_OPTIONS` alone - even with the `forks` pool, explicit `execArgv` is more reliable and self-documenting. Verify with:

```typescript
it('gc is available', () => {
  expect(typeof global.gc).toBe('function')
})
```

**node:test**: Runs tests in the main process (with `--test-isolation=none`) or forks child processes (default). Forked processes inherit `NODE_OPTIONS` from the environment.

### Memory Monitoring in Multi-Process Architectures

`process.memoryUsage()` only reports the **current process's** memory. It cannot see memory used by:
- Child processes (use their own `process.memoryUsage()` via IPC)
- Worker threads (each has its own V8 isolate with separate heap)

For multi-process testing, either:
1. Monitor each process/worker independently and aggregate results
2. Use OS-level metrics (RSS reflects memory of the current process only - it may include shared pages like shared libraries, but does not include memory used by separate child processes)
3. Pipe memory samples from workers back to the main process via `parentPort.postMessage()`

```typescript
// In worker thread
import { parentPort } from 'node:worker_threads'
import { collectMemorySample } from 'memory-watchmen'

setInterval(() => {
  parentPort?.postMessage({ type: 'memory-sample', sample: collectMemorySample() })
}, 1000)
```

### `forceGC()` Scope

`forceGC()` only triggers GC in the **current V8 isolate**. Each worker thread has its own isolate. Calling `forceGC()` in the main thread does not collect garbage in worker threads, and vice versa. If you need to force GC in a worker, the worker itself must call `forceGC()`.

## Stream Backpressure Testing

Backpressure leaks only appear under sustained load with a slow consumer. The pattern:

1. Create a producer that generates data continuously.
2. Pipe through the system under test.
3. Add a slow consumer (e.g., 200ms delay per batch).
4. Monitor heap while backpressure is sustained.

```typescript
import { pipeline } from 'node:stream/promises'

const source = createDataStream()
const processor = new MyTransform()
const slowSink = new Writable({
  write(chunk, enc, cb) {
    setTimeout(cb, 200) // simulate slow consumer
  }
})

// Always use stream/promises pipeline for proper error handling and cleanup
await pipeline(source, processor, slowSink)
```

A common source of backpressure leaks: writing to a stream without checking `write()` return value and waiting for `'drain'`. If `write()` returns `false`, the internal buffer has exceeded `highWaterMark` and the producer must pause until `'drain'` fires.

### Stream Buffer Assertions

Monitor buffer sizes during backpressure to verify they don't grow unbounded over time:

```typescript
import { monitorStreamBuffers } from 'memory-watchmen'

// Continuous monitoring
const monitor = monitorStreamBuffers([myTransform], 100)
// ... run workload ...
const samples = monitor.stop()

// Check that buffers didn't grow unbounded
// Note: buffers CAN temporarily exceed highWaterMark - that's normal.
// The concern is unbounded growth over time, not momentary spikes.
const maxReadable = Math.max(...samples.map(s => s.snapshot.readableLength ?? 0))
console.log(`Max readable buffer: ${maxReadable}`)
```

Key properties:
- `readableLength` - bytes (or objects) buffered in the readable side
- `writableLength` - bytes (or objects) buffered in the writable side
- `writableNeedDrain` - `true` when the writable buffer is full
- `readableFlowing` - `null` (no consumer), `false` (paused), `true` (flowing)

Note: `highWaterMark` is a **threshold, not a limit**. Node.js does not enforce it as a hard cap - buffers can and do temporarily exceed it. The `assertBufferBounded` function uses a multiplier (default 2x) as a heuristic for "something is probably wrong," not as an exact guarantee.

**Object mode streams**: with `objectMode: true`, `highWaterMark` counts objects (default 16), not bytes. This bites you when each object is large - 16 objects at 10 MB each means 160 MB of buffered data looks "normal" to Node. Watch byte-level memory alongside buffer counts for object mode streams.

## WeakRef and FinalizationRegistry

Verify that specific objects get released after you're done with them:

```typescript
import { createTracker } from 'memory-watchmen'

const tracker = createTracker()

let connection = createConnection()
const handle = tracker.track(connection, 'db-connection')

// Use connection...
closeConnection(connection)
connection = null  // release reference

// Verify GC collected it
await tracker.expectCollected(handle, { timeout: 5000 })
```

Caveats:
- Finalization timing is non-deterministic, so these tests can be flaky. Use generous timeouts.
- `expectCollected` polls with `forceGC()` at intervals. This is the most reliable approach, but collection still isn't guaranteed within any specific timeframe.
- Tests only, not for production code paths.

Good for checking that connections are released after close, event emitters are collected after removeAllListeners, request/response objects don't outlive their handler, and streams are collected after pipeline completes.

## Memory Metrics

`process.memoryUsage()` reports these metrics:

| Metric | What it tracks | When to watch |
|--------|---------------|---------------|
| `heapUsed` | JS objects, strings, closures | Most leak detection |
| `heapTotal` | Total heap allocated by V8 | Heap fragmentation |
| `rss` | Resident set (total process memory) | Native addons, mmap |
| `external` | C++ objects bound to JS (includes arrayBuffers) | Buffer-heavy workloads |
| `arrayBuffers` | ArrayBuffer and SharedArrayBuffer backing stores | Typed array workloads |

`arrayBuffers` is a subset of `external` (available since Node 13.9). Buffers and ArrayBuffers contribute to `external` memory that `heapUsed` doesn't reflect. For streaming workloads, always monitor `external` alongside `heapUsed`.

```typescript
import { collectMemorySample } from 'memory-watchmen'

const sample = collectMemorySample()
console.log(`Heap: ${(sample.heapUsed / 1024 / 1024).toFixed(1)} MB`)
console.log(`External: ${(sample.external / 1024 / 1024).toFixed(1)} MB`)
console.log(`RSS: ${(sample.rss / 1024 / 1024).toFixed(1)} MB`)
```

### RSS vs Heap Divergence

If RSS grows but `heapUsed` is stable, suspect:
- **Native addon leaks**: C++ memory not tracked by V8
- **Unreleased Buffers**: Large Buffers allocated but not dereferenced
- **Heap fragmentation**: `heapTotal` grows but `heapUsed` is stable - V8 has expanded the heap and may not immediately return memory to the OS due to fragmentation or heap growth heuristics. Note that fragmented heaps can hit OOM before RSS looks alarming if `--max-old-space-size` is set.

### Fragmentation

`heapTotal` growing while `heapUsed` stays flat means the heap is fragmented. V8 grew the heap and won't immediately give that memory back to the OS, either because of fragmentation or its growth heuristics. Some of this is normal, but it can point to allocation patterns that defeat compaction (e.g., mixing long-lived and short-lived objects on the same heap page).

## Common Node.js Leak Sources

### Event Listeners Not Removed

```typescript
// LEAK: listener accumulates on every request
server.on('request', (req, res) => {
  process.on('SIGTERM', () => res.end())  // never removed, one per request
})

// FIX: register signal handler once, outside the request handler
const connections = new Set()
process.once('SIGTERM', () => {
  for (const res of connections) res.end()
})
server.on('request', (req, res) => {
  connections.add(res)
  res.on('close', () => connections.delete(res))
})
```

### Closures Capturing Scope

```typescript
// LEAK: closure captures entire `data` even though only `id` is needed
function processItems(data: LargeObject[]) {
  return data.map(item => {
    const id = item.id
    return () => fetchById(id)  // `item` and `data` stay alive via closure scope
  })
}

// FIX: extract only what's needed before creating closures
function processItems(data: LargeObject[]) {
  const ids = data.map(item => item.id)
  return ids.map(id => () => fetchById(id))
}
```

### Unbounded Maps and Sets

```typescript
// LEAK: cache grows forever
const cache = new Map()
function getCached(key: string) {
  if (!cache.has(key)) cache.set(key, compute(key))
  return cache.get(key)
}

// FIX: use LRU eviction, WeakMap (if keys are objects), or TTL
```

### Forgotten Timers and Intervals

```typescript
// LEAK: interval keeps closure (and its captured scope) alive forever
function startPolling(resource: HeavyResource) {
  setInterval(() => {
    resource.check()  // resource can never be GC'd
  }, 1000)
}

// FIX: store and clear the interval
function startPolling(resource: HeavyResource) {
  const timer = setInterval(() => resource.check(), 1000)
  return () => clearInterval(timer)
}
```

### Stream Error Handlers

```typescript
// LEAK: error handler keeps reference to entire pipeline
function createPipeline() {
  const streams = [createReadStream(), transform1(), transform2(), createWriteStream()]
  streams.forEach(s => s.on('error', (err) => {
    streams.forEach(s => s.destroy())  // `streams` array kept alive by closure
  }))
}

// FIX: use stream.pipeline() which handles cleanup automatically
import { pipeline } from 'node:stream/promises'
await pipeline(createReadStream(), transform1(), transform2(), createWriteStream())
```

### Unresolved Promises and Async Leaks

```typescript
// LEAK: promise never resolves, keeping closure and all captured references alive
async function handleRequest(req) {
  const data = await loadLargeDataset()
  await someExternalService(data)  // if this never resolves, `data` is retained forever
}

// MITIGATION: always use timeouts on external calls, and clean up the timer
import { setTimeout } from 'node:timers/promises'
const ac = new AbortController()
try {
  const result = await Promise.race([
    someExternalService(data),
    setTimeout(30_000, undefined, { signal: ac.signal }).then(() => {
      throw new Error('Timeout')
    }),
  ])
  ac.abort() // cancel the timer if the service call won
  return result
} catch (err) {
  ac.abort()
  throw err
}
```

### Module-Level Singletons

```typescript
// LEAK: module-level array grows across requests in long-lived processes
const processedItems: Item[] = []

export function handleItem(item: Item) {
  processedItems.push(item)  // never cleared
  return process(item)
}
```

### Unclosed Resources

Sockets, streams, and file handles that aren't closed keep their internal buffers and event listeners alive, even if nothing in your code references them anymore.

```typescript
// LEAK: file handle stays open, internal buffer retained
async function readHeader(path: string) {
  const stream = createReadStream(path)
  const firstChunk = await new Promise(resolve => stream.once('data', resolve))
  // stream is never closed - fd and internal buffer leak
  return parseHeader(firstChunk)
}

// FIX: always close the stream
async function readHeader(path: string) {
  const stream = createReadStream(path)
  try {
    const firstChunk = await new Promise(resolve => stream.once('data', resolve))
    return parseHeader(firstChunk)
  } finally {
    stream.destroy()
  }
}
```

### Native Addon Leaks

Native addons allocate outside V8's heap. You won't see these in `heapUsed` - only `rss` grows. Watch RSS to catch them.

## Debugging Tools

If `monitorHeap` finds a leak but you can't track down the source, start with `--trace-gc` to see GC frequency and type (`node --trace-gc your-test.js`), then try these:

| Tool | Best for |
|------|----------|
| **memlab** | Heap snapshot diffing, retainer traces, React fiber analysis |
| **Chrome DevTools** (`--inspect`) | Interactive heap exploration, allocation timeline |
| **`heapdump`** | Taking heap snapshots programmatically in production |
| **`clinic heapprofiler`** | Allocation flamegraphs |

### When to Escalate to memlab

memory-watchmen tells you "is the heap stable?" - memlab tells you "which object leaked and why?"

When to reach for memlab:
- Heap monitoring detects a leak but you can't find the source
- You need to see the retainer chain (what's keeping the object alive)
- The leak is in browser/DOM code (detached elements, React fibers)
- You need object-level diffing between heap snapshots
- You want to analyze retained sizes and dominator trees

```bash
# memlab E2E scenario
npx memlab run --scenario scenario.js

# Analyze a heap snapshot
npx memlab analyze --snapshot heap.heapsnapshot
```

## Prior Art and References

This library builds on patterns from Node.js core, ecosystem projects, and V8 documentation:

- **Double GC and heap sampling** - the pattern of calling `global.gc()` twice and sampling `process.memoryUsage()` at intervals is widely used in Node.js core and ecosystem test suites (notably in undici's TLS and fetch leak tests, and Node.js core's own `test/parallel/` memory tests). Joyee Cheung's [Memory leak testing with V8/Node.js](https://joyeecheung.github.io/blog/2024/03/17/memory-leak-testing-v8-node-js-1/) (parts 1 and 2) provides authoritative background on why this pattern works and its limitations.

- **WeakRef + FinalizationRegistry for object tracking** - this approach to verifying GC collection is used in Node.js core tests and browser engine test suites. The [V8 blog post on weak references](https://v8.dev/features/weak-references) and [MDN FinalizationRegistry documentation](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/FinalizationRegistry) describe the semantics and caveats.

- **Dual-metric leak detection** (monotonic growth + envelope growth) - developed independently in streaming library test suites to catch both tight leaks (every operation grows) and burst/step-wise leaks (periodic growth with partial recovery). The monotonic check descends from simple consecutive-growth counters used in HTTP client tests; the envelope check adds statistical robustness for workloads with variable allocation rates.

- **Stream buffer introspection** - `readableLength`, `writableLength`, `writableNeedDrain`, and `readableFlowing` are documented in the [Node.js Stream API](https://nodejs.org/docs/latest/api/stream.html). The `highWaterMark` semantics (threshold, not limit) are explained in the [Node.js backpressuring guide](https://nodejs.org/en/learn/modules/backpressuring-in-streams).

- **V8 GC internals** - understanding of `global.gc()` behavior (synchronous full GC by default), ephemeron processing, and FinalizationRegistry timing draws on V8 source code and the [V8 Oilpan library blog post](https://v8.dev/blog/oilpan-library). The `process.memoryUsage().arrayBuffers` field was added in Node.js 13.9 via [PR #31550](https://github.com/nodejs/node/pull/31550).

- **Comparative memory profiling** - the HTTP-based profiler with NDJSON streaming and HTML chart generation is inspired by benchmarking patterns common in streaming parser libraries, where comparing peak/baseline/delta across implementations is the primary optimization workflow.

- **Event loop delay monitoring** - `perf_hooks.monitorEventLoopDelay()` was added in Node.js 12 and provides a histogram-based event loop delay sampler built on libuv's internal timer mechanism. The [Node.js documentation on monitorEventLoopDelay](https://nodejs.org/docs/latest/api/perf_hooks.html#perf_hooksmonitoreventloopdelayoptions) and the [Diagnostics Guide](https://nodejs.org/en/learn/diagnostics/live-debugging/using-diagnostics-channel) describe the API and its use for monitoring loop health.

- **Event loop utilization** - `performance.eventLoopUtilization()` was added in Node.js 14.10 and returns idle/active time ratios. It was designed specifically for load balancing and health checking in production. See [Node.js ELU documentation](https://nodejs.org/docs/latest/api/perf_hooks.html#performanceeventlooputilizationutilization1-utilization2) and Trevor Norris's original [PR #33922](https://github.com/nodejs/node/pull/33922) for design rationale.

## Further Reading

### V8 Garbage Collection

- [Trash talk: the Orinoco garbage collector](https://v8.dev/blog/trash-talk) - overview of V8's generational GC, Scavenger (young generation), and Mark-Compact (old generation)
- [Concurrent marking in V8](https://v8.dev/blog/concurrent-marking) - how V8 marks objects concurrently with JavaScript execution
- [Jank Busters Part Two: Orinoco](https://v8.dev/blog/orinoco) - parallel and concurrent GC techniques in V8
- [Getting garbage collection for free](https://v8.dev/blog/free-garbage-collection) - idle-time GC scheduling
- [Weak references and finalizers](https://v8.dev/features/weak-references) - V8's perspective on WeakRef and FinalizationRegistry semantics

### Node.js Memory

- [Memory leak testing with V8/Node.js, Part 1](https://joyeecheung.github.io/blog/2024/03/17/memory-leak-testing-v8-node-js-1/) - authoritative guide on heap snapshot testing patterns, `global.gc()` behavior, and why tests can be flaky (by Node.js core contributor Joyee Cheung)
- [Memory leak testing with V8/Node.js, Part 2](https://joyeecheung.github.io/blog/2024/03/17/memory-leak-testing-v8-node-js-2/) - FinalizationRegistry-based testing, `gcUntil()` patterns, and limitations of current approaches
- [Node.js: Understanding and Tuning Memory](https://nodejs.org/en/learn/diagnostics/memory/understanding-and-tuning-memory) - official guide to `--max-old-space-size`, heap limits, and memory diagnostics
- [Node.js Diagnostics: Memory](https://nodejs.org/en/learn/diagnostics/memory) - official overview of memory debugging tools and techniques
- [Backpressuring in Streams](https://nodejs.org/en/learn/modules/backpressuring-in-streams) - official guide to how `highWaterMark`, `write()` return value, and `'drain'` work together

### Event Loop

- [Node.js: monitorEventLoopDelay](https://nodejs.org/docs/latest/api/perf_hooks.html#perf_hooksmonitoreventloopdelayoptions) - histogram-based event loop delay measurement API
- [Node.js: eventLoopUtilization](https://nodejs.org/docs/latest/api/perf_hooks.html#performanceeventlooputilizationutilization1-utilization2) - idle/active time ratios for load assessment
- [The Node.js Event Loop, Timers, and process.nextTick()](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick) - official guide to event loop phases
- [Don't Block the Event Loop](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop) - official guide to avoiding event loop starvation

### Heap Snapshot Analysis

- [Chrome DevTools: Memory panel](https://developer.chrome.com/docs/devtools/memory) - using allocation timelines, heap snapshots, and retainer views
- [memlab documentation](https://facebook.github.io/memlab/) - automated heap snapshot diffing, retainer trace analysis, and React-specific leak detection

### FinalizationRegistry and WeakRef

- [MDN: FinalizationRegistry](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/FinalizationRegistry) - API reference with caveats about non-deterministic cleanup timing
- [MDN: WeakRef](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WeakRef) - API reference with guidance on when (and when not) to use weak references
- [TC39 WeakRefs proposal](https://github.com/tc39/proposal-weakrefs) - the specification rationale, including why cleanup callbacks are intentionally non-deterministic
