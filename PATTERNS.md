# Memory Testing Patterns for Node.js

Best practices and patterns for detecting memory leaks, optimizing memory usage, and testing streaming workloads in Node.js.

## GC is Non-Deterministic

V8's garbage collector is non-deterministic. It uses incremental marking, concurrent sweeping, and generational collection. The exact timing and type of GC (minor Scavenge vs major Mark-Sweep) is decided internally by V8 based on allocation pressure, not by the caller.

Memory tests should look for **trends over time**, not exact values. A single snapshot is meaningless. Always use multiple samples with forced GC and accept that some noise is inevitable.

`--expose-gc` exposes V8's gc extension; automatic GC still runs normally, and manual calls are supplemental. However, manually-triggered GC calls block the event loop during synchronous execution and should never be used in production -- only in test scripts.

## Why Double GC

Calling `global.gc()` twice increases measurement stability:

```typescript
function forceGC(): void {
  global.gc()
  global.gc()
}
```

Why two calls help:

1. **FinalizationRegistry**: Cleanup callbacks run asynchronously *after* GC (in a macrotask-like slot between event loop phases), not during the GC pause itself. A second `gc()` call gives those callbacks time to execute, and the resulting dereferenced objects can then be collected in the second cycle.
2. **Weak container cleanup**: `WeakMap`/`WeakSet` use ephemeron semantics -- reachability is determined during GC within a single cycle, but observable disappearance of dead entries (table slot cleanup) is an implementation detail that may not complete immediately. A second cycle increases the likelihood that stale entries are fully reclaimed.
3. **V8-internal deferred tasks**: GC-related tasks like C++ pointers cleanup, weak callback processing, and finalization can be deferred until the thread is idle. A second `gc()` processes these deferred tasks.

Note: `gc()` with no arguments triggers a synchronous full GC. Minor GC can be requested via the legacy boolean form `gc(true)` or an options object `gc({ type: 'minor' })`. The full GC is deterministic in *what* it collects -- there is no randomness in whether reachable objects survive. The non-determinism in memory testing comes from *when* V8's automatic GC runs between your samples, measurement timing, and FinalizationRegistry callback scheduling.

The key idea is **measurement stability**, not a correctness guarantee. Two calls empirically produce more consistent readings than one.

Always run with `--expose-gc`. In test scripts: `NODE_OPTIONS=--expose-gc`.

## Warm-Up Periods

Measurements taken immediately after process start include noise from:

- **JIT compilation**: V8 compiles hot functions on first use, allocating code objects.
- **Inline caches and hidden classes**: V8 stabilizes object shapes and call-site caches after repeated calls, causing initial allocation spikes.
- **Lazy initialization**: Modules, caches, and pools initialize on first access.
- **Buffer pool priming**: Node.js allocates internal buffer pools on first I/O.

Wait 2--5 seconds after workload starts before sampling. This lets the process reach a steady state.

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

**When it triggers**: Event listeners accumulating on every request. Map entries never deleted. Closures capturing scope in a loop.

**Threshold**: 10 consecutive growth samples (default). Lower values increase false positives from GC timing jitter.

**Important**: This check is most reliable when GC is forced before each sample (which `monitorHeap` does). Without forced GC, V8's non-deterministic collection timing can create false streaks of growth that aren't actual leaks.

### Envelope Growth

Compare the average of the first third of samples to the last third. Catches step-wise or burst leaks that aren't monotonic.

**When it triggers**: Memory grows in bursts (e.g., batch processing), then partially reclaims. Buffer pool expansions that don't shrink. Periodic cache rebuilds that grow over time.

**Threshold**: 15 MB drift (default). Adjust based on workload size.

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

Allocation rate matters: high allocation rate workloads tolerate shorter intervals because GC runs frequently and samples are more meaningful. Low allocation rate workloads need longer windows to distinguish signal from noise.

## CI Considerations

Run memory tests in isolation. Parallel tests distort GC and memory signals because:
- Other tests' allocations affect heap size
- GC pauses from other tests create measurement jitter
- Shared process memory (if using worker threads) conflates signals

Recommended vitest config for memory tests:

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

Do not rely on `NODE_OPTIONS=--expose-gc` for vitest -- it applies to the vitest process itself but may not propagate to workers depending on the pool type. The `execArgv` config is explicit and reliable.

## Profiler Workflow

The profiler server is designed for comparative memory analysis -- answering "which approach uses less memory?" rather than "is there a leak?". Use `monitorHeap()` for leak detection and the profiler for optimization work.

### Designing Approach Functions

Each approach function receives `(filePath, multi, onSample, path?)` and should:

1. **Call `onSample(collectMemorySample())` at meaningful points** -- after loading data, after processing a batch, after cleanup. The server also samples on a timer, so you don't need to sample every iteration.
2. **Process the entire file** -- the profiler measures peak/baseline/delta over the full run.
3. **Avoid caching between runs** -- each approach should start from a clean state.

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
| **Delta** | Peak minus baseline -- the memory cost of the workload |

A low delta means the approach processes data without materializing large intermediate structures. Compare deltas across approaches to find the most memory-efficient implementation.

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

// GC is NOT available in the child — --expose-gc was not passed
const bad = fork('./worker.js')

// GC IS available in the child
const good = fork('./worker.js', [], {
  execArgv: ['--expose-gc'],
})
```

This is relevant for the profiler server, which uses `fork()` to start the server process:

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
- Some test runners (vitest, jest) may spawn workers without propagating `NODE_OPTIONS` to their execution context. The flag will be in the environment, but the worker may not have been started with it.

### Test Runner Considerations

**Vitest**: Uses worker threads by default. The `cross-env NODE_OPTIONS=--expose-gc` in your npm script ensures the vitest process has `gc()`, but individual test workers may also need it. In practice, vitest passes `NODE_OPTIONS` through to its worker processes because `fork()` inherits the environment, but verify with a simple test:

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
2. Use OS-level metrics (`rss` from the parent includes shared pages but not child process memory)
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
```

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
// Note: buffers CAN temporarily exceed highWaterMark -- that's normal.
// The concern is unbounded growth over time, not momentary spikes.
const maxReadable = Math.max(...samples.map(s => s.snapshot.readableLength ?? 0))
console.log(`Max readable buffer: ${maxReadable}`)
```

Key properties:
- `readableLength` -- bytes (or objects) buffered in the readable side
- `writableLength` -- bytes (or objects) buffered in the writable side
- `writableNeedDrain` -- `true` when the writable buffer is full
- `readableFlowing` -- `null` (no consumer), `false` (paused), `true` (flowing)

Note: `highWaterMark` is a **threshold, not a limit**. Node.js does not enforce it as a hard cap -- buffers can and do temporarily exceed it. The `assertBufferBounded` function uses a multiplier (default 2x) as a heuristic for "something is probably wrong," not as an exact guarantee.

## WeakRef and FinalizationRegistry

For verifying that specific objects are properly released:

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

**Important caveats**:
- Finalization timing is non-deterministic. Tests using `FinalizationRegistry` can be flaky. Always use generous timeouts and retries.
- `expectCollected` polls with `forceGC()` at intervals, which is the most reliable approach, but collection is still not guaranteed within any specific timeframe.
- Do not use this pattern for performance-critical paths -- it's for tests only.

Use cases:
- Verify connections are released after close
- Verify event emitters are collected after removeAllListeners
- Verify request/response objects don't survive beyond their handler
- Verify stream objects are collected after pipeline completes

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
- **Heap fragmentation**: `heapTotal` grows but `heapUsed` is stable -- V8 allocated more heap space but can't compact it

### Fragmentation

When `heapTotal` grows steadily but `heapUsed` remains constant, the heap is fragmented. V8 allocated memory it can't release back to the OS. This is normal to a degree but can indicate allocation patterns that defeat V8's compaction (e.g., mixing long-lived and short-lived objects in the same heap page).

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

// MITIGATION: always use timeouts on external calls
import { setTimeout } from 'node:timers/promises'
await Promise.race([
  someExternalService(data),
  setTimeout(30_000).then(() => { throw new Error('Timeout') }),
])
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

### Native Addon Leaks

Native addons allocate memory outside V8's heap. These leaks are invisible in `heapUsed` -- only `rss` grows. Use process-level RSS monitoring to detect them.

## Debugging Tools

When `monitorHeap` detects a leak but you can't find the source, escalate to deeper tools:

| Tool | Best for |
|------|----------|
| **memlab** | Heap snapshot diffing, retainer traces, React fiber analysis |
| **Chrome DevTools** (`--inspect`) | Interactive heap exploration, allocation timeline |
| **`heapdump`** | Taking heap snapshots programmatically in production |
| **`clinic heapprofiler`** | Allocation flamegraphs |

### When to Escalate to memlab

Use memory-watchmen for "is the heap stable?" checks. Escalate to memlab when you need to answer "which object leaked and why?"

Signs you need memlab:
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

The patterns in this library draw on established practices from several Node.js projects and V8 documentation:

- **Double GC and heap sampling** — the pattern of calling `global.gc()` twice and sampling `process.memoryUsage()` at intervals is widely used in Node.js core and ecosystem test suites (notably in undici's TLS and fetch leak tests, and Node.js core's own `test/parallel/` memory tests). Joyee Cheung's [Memory leak testing with V8/Node.js](https://joyeecheung.github.io/blog/2024/03/17/memory-leak-testing-v8-node-js-1/) (parts 1 and 2) provides authoritative background on why this pattern works and its limitations.

- **WeakRef + FinalizationRegistry for object tracking** — this approach to verifying GC collection is used in Node.js core tests and browser engine test suites. The [V8 blog post on weak references](https://v8.dev/features/weak-references) and [MDN FinalizationRegistry documentation](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/FinalizationRegistry) describe the semantics and caveats.

- **Dual-metric leak detection** (monotonic growth + envelope growth) — developed independently in streaming library test suites to catch both tight leaks (every operation grows) and burst/step-wise leaks (periodic growth with partial recovery). The monotonic check descends from simple consecutive-growth counters used in HTTP client tests; the envelope check adds statistical robustness for workloads with variable allocation rates.

- **Stream buffer introspection** — `readableLength`, `writableLength`, `writableNeedDrain`, and `readableFlowing` are documented in the [Node.js Stream API](https://nodejs.org/docs/latest/api/stream.html). The `highWaterMark` semantics (threshold, not limit) are explained in the [Node.js backpressuring guide](https://nodejs.org/en/learn/modules/backpressuring-in-streams).

- **V8 GC internals** — understanding of `global.gc()` behavior (synchronous full GC by default), ephemeron processing, and FinalizationRegistry timing draws on V8 source code and the [V8 Oilpan library blog post](https://v8.dev/blog/oilpan-library). The `process.memoryUsage().arrayBuffers` field was added in Node.js 13.9 via [PR #31550](https://github.com/nodejs/node/pull/31550).

- **Comparative memory profiling** — the HTTP-based profiler with NDJSON streaming and HTML chart generation is inspired by benchmarking patterns common in streaming parser libraries, where comparing peak/baseline/delta across implementations is the primary optimization workflow.

## Further Reading

### V8 Garbage Collection

- [Trash talk: the Orinoco garbage collector](https://v8.dev/blog/trash-talk) — overview of V8's generational GC, Scavenger (young generation), and Mark-Compact (old generation)
- [Concurrent marking in V8](https://v8.dev/blog/concurrent-marking) — how V8 marks objects concurrently with JavaScript execution
- [Jank Busters Part Two: Orinoco](https://v8.dev/blog/orinoco) — parallel and concurrent GC techniques in V8
- [Getting garbage collection for free](https://v8.dev/blog/free-garbage-collection) — idle-time GC scheduling
- [Weak references and finalizers](https://v8.dev/features/weak-references) — V8's perspective on WeakRef and FinalizationRegistry semantics

### Node.js Memory

- [Memory leak testing with V8/Node.js, Part 1](https://joyeecheung.github.io/blog/2024/03/17/memory-leak-testing-v8-node-js-1/) — authoritative guide on heap snapshot testing patterns, `global.gc()` behavior, and why tests can be flaky (by Node.js core contributor Joyee Cheung)
- [Memory leak testing with V8/Node.js, Part 2](https://joyeecheung.github.io/blog/2024/03/17/memory-leak-testing-v8-node-js-2/) — FinalizationRegistry-based testing, `gcUntil()` patterns, and limitations of current approaches
- [Node.js: Understanding and Tuning Memory](https://nodejs.org/en/learn/diagnostics/memory/understanding-and-tuning-memory) — official guide to `--max-old-space-size`, heap limits, and memory diagnostics
- [Node.js Diagnostics: Memory](https://nodejs.org/en/learn/diagnostics/memory) — official overview of memory debugging tools and techniques
- [Backpressuring in Streams](https://nodejs.org/en/learn/modules/backpressuring-in-streams) — official guide to how `highWaterMark`, `write()` return value, and `'drain'` work together

### Heap Snapshot Analysis

- [Chrome DevTools: Memory panel](https://developer.chrome.com/docs/devtools/memory) — using allocation timelines, heap snapshots, and retainer views
- [memlab documentation](https://facebook.github.io/memlab/) — automated heap snapshot diffing, retainer trace analysis, and React-specific leak detection

### FinalizationRegistry and WeakRef

- [MDN: FinalizationRegistry](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/FinalizationRegistry) — API reference with caveats about non-deterministic cleanup timing
- [MDN: WeakRef](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WeakRef) — API reference with guidance on when (and when not) to use weak references
- [TC39 WeakRefs proposal](https://github.com/tc39/proposal-weakrefs) — the specification rationale, including why cleanup callbacks are intentionally non-deterministic
