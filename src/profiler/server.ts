/**
 * Memory profiling HTTP service.
 *
 * Runs user-registered workloads in-process and streams memory metrics as NDJSON.
 * Generalized from json-river's bench/memory-profiler/server.ts.
 *
 * Endpoints:
 *   POST /profile  — Body: { approach, filePath, multi?, path?, sampleIntervalMs? }
 *                    Response: NDJSON stream of MemorySample, final line is ProfileSummary
 *   GET /approaches — Returns available approach names
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { stat } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

import { collectMemorySample, forceGC } from '../heap-monitor.ts'
import type { ApproachFn, MemorySample, ProfileRequest, ProfileSummary, ProfileServerOptions } from '../types.ts'

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

async function handleProfile(
  req: IncomingMessage,
  res: ServerResponse,
  approaches: Map<string, ApproachFn>,
): Promise<void> {
  const body = await readBody(req)

  let request: ProfileRequest
  try {
    request = JSON.parse(body)
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid JSON body' }))
    return
  }

  const { approach, filePath, multi = false, path, sampleIntervalMs = 20 } = request

  const fn = approaches.get(approach)
  if (!fn) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        error: `Unknown approach: ${approach}. Available: ${[...approaches.keys()].join(', ')}`,
      }),
    )
    return
  }

  let fileSizeMB: number
  try {
    const s = await stat(filePath)
    fileSizeMB = s.size / (1024 * 1024)
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `File not found: ${filePath}` }))
    return
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Transfer-Encoding': 'chunked',
  })

  const samples: MemorySample[] = []
  let peakSample: MemorySample | null = null

  const onSample = (sample: MemorySample) => {
    samples.push(sample)
    if (!peakSample || sample.heapUsed > peakSample.heapUsed) {
      peakSample = sample
    }
    res.write(JSON.stringify(sample) + '\n')
  }

  // Timer-based sampling for approaches that don't call onSample frequently
  let timerStopped = false
  const timerLoop = (async () => {
    while (!timerStopped) {
      await sleep(sampleIntervalMs)
      if (!timerStopped) onSample(collectMemorySample())
    }
  })()

  forceGC()
  const baseline = collectMemorySample()
  onSample(baseline)

  const start = performance.now()

  try {
    await fn(filePath, multi, onSample, path)
  } catch (err: unknown) {
    timerStopped = true
    await timerLoop
    const message = err instanceof Error ? err.message : String(err)
    res.write(JSON.stringify({ error: message }) + '\n')
    res.end()
    return
  }

  const elapsed = performance.now() - start

  timerStopped = true
  await timerLoop

  // Final samples
  onSample(collectMemorySample())
  forceGC()
  onSample(collectMemorySample())

  // peakSample is guaranteed non-null: onSample(baseline) was called above
  const peak = peakSample ?? baseline

  const summary: ProfileSummary = {
    summary: true,
    approach,
    file: filePath,
    fileSizeMB: Math.round(fileSizeMB * 10) / 10,
    baseline,
    peak,
    peakHeapUsedMB: Math.round((peak.heapUsed / (1024 * 1024)) * 10) / 10,
    baselineHeapUsedMB: Math.round((baseline.heapUsed / (1024 * 1024)) * 10) / 10,
    deltaHeapUsedMB:
      Math.round(((peak.heapUsed - baseline.heapUsed) / (1024 * 1024)) * 10) / 10,
    totalSamples: samples.length,
    elapsedMs: Math.round(elapsed),
  }

  res.write(JSON.stringify(summary) + '\n')
  res.end()
}

/**
 * Create a memory profiling HTTP server with user-registered approaches.
 *
 * @example
 * ```ts
 * const server = createProfileServer({
 *   approaches: new Map([
 *     ['my-approach', async (filePath, multi, onSample) => {
 *       // process file, call onSample(collectMemorySample()) periodically
 *     }],
 *   ]),
 *   port: 3847,
 * })
 * ```
 */
export function createProfileServer(options: ProfileServerOptions): Server {
  const { approaches, port = 3847 } = options

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/approaches') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify([...approaches.keys()]))
      return
    }

    if (req.method === 'POST' && req.url === '/profile') {
      try {
        await handleProfile(req, res, approaches)
      } catch (err: unknown) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
        }
        const message = err instanceof Error ? err.message : String(err)
        res.end(JSON.stringify({ error: message }))
      }
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })

  server.listen(port, () => {
    console.log(`Memory profiler server listening on http://localhost:${port}`)
    console.log(`Available approaches: ${[...approaches.keys()].join(', ')}`)
  })

  return server
}
