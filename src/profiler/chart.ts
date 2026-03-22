/**
 * HTML chart generator for memory profile comparisons.
 *
 * Produces self-contained HTML with inline canvas-based charts
 * comparing heap usage over time across multiple approaches.
 *
 * Extracted and generalized from json-river's bench/memory-profiler/chart.ts.
 */
import type { ProfileResult } from '../types.ts'

export interface ChartOptions {
  /** Chart title (default: "Memory Profile Comparison") */
  title?: string
}

/**
 * Generate a self-contained HTML page comparing memory profiles.
 */
export function generateChart(results: ProfileResult[], options?: ChartOptions): string {
  const title = options?.title ?? 'Memory Profile Comparison'
  const fileName =
    results.length > 0
      ? results[0].file.split(/[\\/]/).pop() ?? 'unknown'
      : 'unknown'

  const series = results.map((r) => {
    const t0 = r.samples[0]?.timestamp ?? 0
    return {
      label: r.approach,
      peakMB: r.summary.peakHeapUsedMB,
      deltaMB: r.summary.deltaHeapUsedMB,
      elapsedMs: r.summary.elapsedMs,
      points: r.samples.map((s) => ({
        t: s.timestamp - t0,
        heapMB: Math.round((s.heapUsed / (1024 * 1024)) * 100) / 100,
        rssMB: Math.round((s.rss / (1024 * 1024)) * 100) / 100,
      })),
    }
  })

  const colors = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c']

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}: ${fileName}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; background: #f8fafc; color: #1e293b; padding: 24px; }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  .subtitle { color: #64748b; margin-bottom: 24px; }
  .chart-container { background: white; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 24px; }
  canvas { width: 100%; height: 400px; }
  .legend { display: flex; gap: 24px; flex-wrap: wrap; margin-top: 16px; }
  .legend-item { display: flex; align-items: center; gap: 8px; font-size: 0.875rem; }
  .legend-color { width: 16px; height: 3px; border-radius: 2px; }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #e2e8f0; }
  th { background: #f1f5f9; font-weight: 600; font-size: 0.875rem; color: #475569; }
  td { font-size: 0.875rem; font-variant-numeric: tabular-nums; }
  tr:last-child td { border-bottom: none; }
</style>
</head>
<body>
<h1>${title}</h1>
<p class="subtitle">File: ${fileName}${results[0] ? ` (${results[0].summary.fileSizeMB} MB)` : ''}</p>

<div class="chart-container">
  <canvas id="heapChart"></canvas>
  <div class="legend" id="legend"></div>
</div>

<table>
  <thead>
    <tr>
      <th>Approach</th>
      <th>Baseline (MB)</th>
      <th>Peak (MB)</th>
      <th>Delta (MB)</th>
      <th>Duration (ms)</th>
      <th>Samples</th>
    </tr>
  </thead>
  <tbody>
    ${results
      .map(
        (r) => `<tr>
      <td>${r.approach}</td>
      <td>${r.summary.baselineHeapUsedMB.toFixed(1)}</td>
      <td>${r.summary.peakHeapUsedMB.toFixed(1)}</td>
      <td>${r.summary.deltaHeapUsedMB.toFixed(1)}</td>
      <td>${r.summary.elapsedMs}</td>
      <td>${r.summary.totalSamples}</td>
    </tr>`,
      )
      .join('\n    ')}
  </tbody>
</table>

<script>
const series = ${JSON.stringify(series)};
const colors = ${JSON.stringify(colors)};

const canvas = document.getElementById('heapChart');
const ctx = canvas.getContext('2d');
const dpr = window.devicePixelRatio || 1;

function draw() {
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;
  const pad = { top: 20, right: 20, bottom: 40, left: 60 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  let maxT = 0, minMB = Infinity, maxMB = 0;
  for (const s of series) {
    for (const p of s.points) {
      if (p.t > maxT) maxT = p.t;
      if (p.heapMB < minMB) minMB = p.heapMB;
      if (p.heapMB > maxMB) maxMB = p.heapMB;
    }
  }
  const rangeMB = maxMB - minMB || 1;
  minMB = Math.max(0, minMB - rangeMB * 0.1);
  maxMB = maxMB + rangeMB * 0.1;
  maxT = maxT || 1000;

  const scaleX = (t) => pad.left + (t / maxT) * plotW;
  const scaleY = (mb) => pad.top + plotH - ((mb - minMB) / (maxMB - minMB)) * plotH;

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const mb = minMB + (maxMB - minMB) * (i / yTicks);
    const y = scaleY(mb);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    ctx.fillStyle = '#94a3b8'; ctx.font = '11px system-ui'; ctx.textAlign = 'right';
    ctx.fillText(mb.toFixed(1) + ' MB', pad.left - 8, y + 4);
  }

  const xTicks = 6;
  for (let i = 0; i <= xTicks; i++) {
    const t = maxT * (i / xTicks);
    const x = scaleX(t);
    ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, h - pad.bottom); ctx.stroke();
    ctx.fillStyle = '#94a3b8'; ctx.font = '11px system-ui'; ctx.textAlign = 'center';
    ctx.fillText((t / 1000).toFixed(1) + 's', x, h - pad.bottom + 16);
  }

  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    const color = colors[i % colors.length];
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    for (let j = 0; j < s.points.length; j++) {
      const p = s.points[j];
      const x = scaleX(p.t); const y = scaleY(p.heapMB);
      if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  const legendEl = document.getElementById('legend');
  legendEl.innerHTML = series.map((s, i) =>
    '<div class="legend-item">' +
    '<div class="legend-color" style="background:' + colors[i % colors.length] + '"></div>' +
    '<span>' + s.label + ' (peak: ' + s.peakMB.toFixed(1) + ' MB, delta: ' + s.deltaMB.toFixed(1) + ' MB)</span>' +
    '</div>'
  ).join('');
}

draw();
window.addEventListener('resize', draw);
</script>
</body>
</html>`
}
