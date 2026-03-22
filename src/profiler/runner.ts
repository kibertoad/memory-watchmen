/**
 * Batch profiling runner.
 *
 * Connects to a running profile server, runs approaches against files,
 * and produces consolidated reports.
 *
 * Generalized from json-river's bench/memory-profiler/run-profile.ts.
 */
import { fork, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import type { MemorySample, ProfileResult, ProfileSummary, RunProfilesConfig } from '../types.ts'

const DEFAULT_URL = 'http://localhost:3847'

/**
 * Run a single profile against the server.
 */
export async function runProfile(
  approach: string,
  filePath: string,
  multi: boolean,
  serverUrl = DEFAULT_URL,
  sampleIntervalMs = 200,
  path?: string,
): Promise<ProfileResult> {
  const res = await fetch(`${serverUrl}/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approach, filePath, multi, path, sampleIntervalMs }),
  })

  if (!res.ok) {
    throw new Error(`Profile request failed: ${res.status} ${await res.text()}`)
  }

  const text = await res.text()
  const lines = text.trim().split('\n').map((l) => JSON.parse(l))

  const samples: MemorySample[] = []
  let summary: ProfileSummary | undefined

  for (const line of lines) {
    if (line.summary) {
      summary = line
    } else if (line.error) {
      throw new Error(`Profile error: ${line.error}`)
    } else {
      samples.push(line)
    }
  }

  if (!summary) throw new Error('No summary received')

  return { approach, file: filePath, samples, summary }
}

/**
 * Run multiple profiles and save results to an output directory.
 */
export async function runProfiles(config: RunProfilesConfig): Promise<ProfileResult[]> {
  const { serverUrl = DEFAULT_URL, approaches, files, outputDir, sampleIntervalMs = 200 } = config

  await mkdir(join(outputDir, 'samples'), { recursive: true })

  const results: ProfileResult[] = []

  for (const file of files) {
    for (const approach of approaches) {
      console.log(`  Profiling: ${approach} + ${file.path}...`)

      try {
        const result = await runProfile(
          approach,
          file.path,
          file.multi ?? false,
          serverUrl,
          sampleIntervalMs,
          file.jsonPath,
        )
        results.push(result)

        const sampleFile = join(
          outputDir,
          'samples',
          `${approach}_${file.path.split(/[\\/]/).pop()?.replace(/\./g, '_') ?? 'file'}.ndjson`,
        )
        await writeFile(sampleFile, result.samples.map((s) => JSON.stringify(s)).join('\n') + '\n')

        console.log(
          `    Peak: ${result.summary.peakHeapUsedMB} MB, ` +
            `Delta: ${result.summary.deltaHeapUsedMB} MB, ` +
            `Time: ${result.summary.elapsedMs}ms`,
        )
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`    Error: ${message}`)
      }

      // Brief pause between profiles for GC to settle
      await sleep(1000)
    }
  }

  // Write consolidated output
  await writeFile(
    join(outputDir, 'summary.json'),
    JSON.stringify(
      results.map((r) => r.summary),
      null,
      2,
    ),
  )

  await writeFile(join(outputDir, 'chart-data.json'), JSON.stringify(buildChartData(results), null, 2))

  const report = formatTable(results)
  await writeFile(join(outputDir, 'report.txt'), report)

  console.log('\n' + report)
  console.log(`\nResults saved to: ${outputDir}`)

  return results
}

/**
 * Format results into an ASCII comparison table.
 */
export function formatTable(results: ProfileResult[]): string {
  if (results.length === 0) return '(no results)'

  const rows = results.map((r) => ({
    Approach: r.summary.approach,
    File: r.summary.file.split(/[\\/]/).pop() || r.summary.file,
    'Size (MB)': r.summary.fileSizeMB.toFixed(1),
    'Baseline (MB)': r.summary.baselineHeapUsedMB.toFixed(1),
    'Peak (MB)': r.summary.peakHeapUsedMB.toFixed(1),
    'Delta (MB)': r.summary.deltaHeapUsedMB.toFixed(1),
    'Time (ms)': String(r.summary.elapsedMs),
    Samples: String(r.summary.totalSamples),
  }))

  const headers = Object.keys(rows[0])
  const widths = headers.map((h) =>
    Math.max(h.length, ...rows.map((r) => String(r[h as keyof (typeof rows)[0]]).length)),
  )

  const sep = widths.map((w) => '-'.repeat(w + 2)).join('+')
  const headerLine = headers.map((h, i) => ` ${h.padEnd(widths[i])} `).join('|')
  const dataLines = rows.map((r) =>
    headers.map((h, i) => ` ${String(r[h as keyof typeof r]).padEnd(widths[i])} `).join('|'),
  )

  return [sep, headerLine, sep, ...dataLines, sep].join('\n')
}

/**
 * Build chart-compatible time-series data with normalized timestamps.
 */
export function buildChartData(
  results: ProfileResult[],
): { approach: string; file: string; series: { t: number; heapUsedMB: number; rssMB: number }[] }[] {
  return results.map((r) => {
    const t0 = r.samples[0]?.timestamp ?? 0
    return {
      approach: r.summary.approach,
      file: r.summary.file.split(/[\\/]/).pop() ?? r.summary.file,
      series: r.samples.map((s) => ({
        t: s.timestamp - t0,
        heapUsedMB: Math.round((s.heapUsed / (1024 * 1024)) * 100) / 100,
        rssMB: Math.round((s.rss / (1024 * 1024)) * 100) / 100,
      })),
    }
  })
}

/**
 * Fork a profile server as a child process.
 */
export async function startServer(serverPath: string, port = 3847): Promise<ChildProcess> {
  const child = fork(serverPath, [String(port)], {
    execArgv: ['--expose-gc'],
    stdio: 'pipe',
  })

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10_000)
    child.stdout?.on('data', (data: Buffer) => {
      if (data.toString().includes('listening')) {
        clearTimeout(timeout)
        resolve()
      }
    })
    child.stderr?.on('data', (data: Buffer) => {
      console.error('[server stderr]', data.toString())
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      clearTimeout(timeout)
      if (code !== 0) reject(new Error(`Server exited with code ${code}`))
    })
  })

  return child
}
