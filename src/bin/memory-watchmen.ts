#!/usr/bin/env node

/**
 * memory-watchmen CLI
 *
 * Commands:
 *   serve   — Start profiler server (requires --config pointing to an approaches module)
 *   profile — Run a single profile against a running server
 *   chart   — Generate an HTML chart from profile results
 */
import { parseArgs } from 'node:util'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import type { ApproachFn } from '../types.ts'
import { resolve, join } from 'node:path'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', default: '3847' },
    config: { type: 'string' },
    approach: { type: 'string' },
    file: { type: 'string' },
    multi: { type: 'boolean', default: false },
    path: { type: 'string' },
    interval: { type: 'string', default: '200' },
    input: { type: 'string' },
    output: { type: 'string', default: 'results' },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

const command = positionals[0]

if (values.help || !command) {
  console.log(`memory-watchmen — Lightweight memory leak detection for Node.js

Commands:
  serve    Start the profiler HTTP server
           --config <path>   Path to module exporting approaches Map
           --port <number>   Port to listen on (default: 3847)

  profile  Run a single profile against a running server
           --approach <name> Approach to profile
           --file <path>     File to process
           --multi           Enable multi-document mode
           --path <jsonpath> JSON path for pick operations
           --interval <ms>   Sample interval (default: 200)

  chart    Generate an HTML chart from summary data
           --input <dir>     Directory containing summary.json and chart-data.json
           --output <path>   Output HTML file path (default: results)

Usage:
  memory-watchmen serve --config ./my-approaches.ts
  memory-watchmen profile --approach my-approach --file data.json
  memory-watchmen chart --input ./profile-results --output ./report`)
  process.exit(0)
}

async function main() {
  switch (command) {
    case 'serve': {
      const configPath = values.config
      if (!configPath) {
        console.error('Error: --config is required for serve command')
        process.exit(1)
      }
      const port = parseInt(values.port!, 10)
      const configModule = await import(resolve(configPath))
      const approaches: Map<string, unknown> = configModule.default ?? configModule.approaches
      if (!(approaches instanceof Map)) {
        console.error('Config must export a Map<string, ApproachFn> as default or "approaches"')
        process.exit(1)
      }
      const { createProfileServer } = await import('../profiler/server.ts')
      // Validated as Map above — ApproachFn signature is enforced at runtime by the server
      createProfileServer({ approaches: approaches as Map<string, ApproachFn>, port })
      break
    }

    case 'profile': {
      if (!values.approach || !values.file) {
        console.error('Error: --approach and --file are required for profile command')
        process.exit(1)
      }
      const { runProfile } = await import('../profiler/runner.ts')
      const serverUrl = `http://localhost:${values.port}`
      const result = await runProfile(
        values.approach,
        resolve(values.file),
        values.multi!,
        serverUrl,
        parseInt(values.interval!, 10),
        values.path,
      )
      console.log(`Peak: ${result.summary.peakHeapUsedMB} MB`)
      console.log(`Delta: ${result.summary.deltaHeapUsedMB} MB`)
      console.log(`Time: ${result.summary.elapsedMs}ms`)
      console.log(`Samples: ${result.summary.totalSamples}`)
      break
    }

    case 'chart': {
      if (!values.input) {
        console.error('Error: --input is required for chart command')
        process.exit(1)
      }
      const inputDir = resolve(values.input)
      const summaryData = JSON.parse(await readFile(join(inputDir, 'summary.json'), 'utf-8'))
      const chartDataRaw = JSON.parse(await readFile(join(inputDir, 'chart-data.json'), 'utf-8'))

      // Reconstruct ProfileResult[] from summary + chart-data
      const results = summaryData.map((summary: Record<string, unknown>, i: number) => ({
        approach: summary.approach,
        file: summary.file,
        samples: (chartDataRaw[i]?.series ?? []).map((s: Record<string, number>) => ({
          timestamp: s.t,
          heapUsed: s.heapUsedMB * 1024 * 1024,
          heapTotal: 0,
          rss: (s.rssMB ?? 0) * 1024 * 1024,
          external: 0,
        })),
        summary,
      }))

      const { generateChart } = await import('../profiler/chart.ts')
      const html = generateChart(results)

      const outputPath = resolve(values.output!)
      await mkdir(outputPath, { recursive: true })
      await writeFile(join(outputPath, 'chart.html'), html)
      console.log(`Chart written to: ${join(outputPath, 'chart.html')}`)
      break
    }

    default:
      console.error(`Unknown command: ${command}. Run with --help for usage.`)
      process.exit(1)
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
