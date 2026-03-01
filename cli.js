#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises"
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import { homedir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import fg from "fast-glob"
import { Resvg } from "@resvg/resvg-js"

const home = homedir()
const toDate = (ms) => new Date(ms).toISOString().slice(0, 10)
const isoToDate = (iso) => iso.slice(0, 10)

function add(map, date, n) {
  map.set(date, (map.get(date) || 0) + n)
}

async function collectClaude() {
  const counts = new Map()
  const dir = join(home, ".claude", "projects")
  for (const path of await fg("*/*.jsonl", { cwd: dir })) {
    if (path.includes("/subagents/")) continue
    const text = await readFile(join(dir, path), "utf-8")
    for (const line of text.split("\n")) {
      if (!line.includes('"assistant"') || !line.includes('"usage"')) continue
      try {
        const obj = JSON.parse(line)
        if (obj.type !== "assistant" || obj.isSidechain) continue
        const u = obj.message?.usage
        if (!u || !obj.timestamp) continue
        if (obj.message.model === "<synthetic>") continue
        const tokens = (u.input_tokens || 0) + (u.output_tokens || 0) +
          (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
        if (tokens > 0) add(counts, isoToDate(obj.timestamp), tokens)
      } catch {}
    }
  }
  return counts
}

async function collectCodex() {
  const counts = new Map()
  const dir = join(home, ".codex", "sessions")
  for (const path of await fg("**/*.jsonl", { cwd: dir })) {
    try {
      const rl = createInterface({ input: createReadStream(join(dir, path)), crlfDelay: Infinity })
      let prevCumulative = null
      for await (const line of rl) {
        if (!line.includes('"token_count"')) continue
        try {
          const obj = JSON.parse(line)
          if (obj.payload?.type !== "token_count") continue
          const cumTotal = obj.payload.info?.total_token_usage?.total_tokens
          if (cumTotal != null && cumTotal === prevCumulative) continue
          let tokens = obj.payload.info?.last_token_usage?.total_tokens
          if (!tokens && cumTotal != null && prevCumulative != null) tokens = cumTotal - prevCumulative
          if (cumTotal != null) prevCumulative = cumTotal
          if (tokens > 0 && obj.timestamp) add(counts, isoToDate(obj.timestamp), tokens)
        } catch {}
      }
    } catch {}
  }
  return counts
}

async function collectOpenCode() {
  const counts = new Map()
  const dirs = [
    join(home, ".local", "share", "opencode", "storage", "message"),
    ...(process.platform === "darwin" ? [join(home, "Library", "Application Support", "opencode", "storage", "message")] : []),
  ]
  for (const dir of dirs)
  for (const path of await fg("ses_*/msg_*.json", { cwd: dir, suppressErrors: true })) {
    try {
      const obj = JSON.parse(await readFile(join(dir, path), "utf-8"))
      if (obj.role !== "assistant") continue
      const t = obj.tokens
      if (!t) continue
      const tokens = (t.input || 0) + (t.output || 0) + (t.reasoning || 0) +
        (t.cache?.read || 0) + (t.cache?.write || 0)
      if (tokens > 0 && obj.time?.created) add(counts, toDate(obj.time.created), tokens)
    } catch {}
  }
  return counts
}

async function collectGemini() {
  const counts = new Map()
  const dir = join(home, ".gemini", "tmp")
  for (const path of await fg("*/chats/*.json", { cwd: dir })) {
    try {
      const obj = JSON.parse(await readFile(join(dir, path), "utf-8"))
      if (!obj.messages) continue
      for (const msg of obj.messages) {
        if (msg.type !== "gemini") continue
        const t = msg.tokens
        const tk = t?.total || ((t?.input || 0) + (t?.tool || 0) + (t?.output || 0) + (t?.thoughts || 0) + (t?.cached || 0))
        if (tk > 0 && msg.timestamp) add(counts, isoToDate(msg.timestamp), tk)
      }
    } catch {}
  }
  return counts
}

async function collectAmp() {
  const counts = new Map()
  const dir = join(home, ".local", "share", "amp", "threads")
  for (const path of await fg("T-*.json", { cwd: dir })) {
    try {
      const obj = JSON.parse(await readFile(join(dir, path), "utf-8"))
      if (!obj.messages) continue
      const date = obj.created ? toDate(obj.created) : null
      if (!date) continue
      for (const msg of obj.messages) {
        const u = msg.usage
        if (!u) continue
        const tokens = (u.totalInputTokens || 0) + (u.outputTokens || 0)
        if (tokens > 0) add(counts, date, tokens)
      }
    } catch {}
  }
  return counts
}

async function collectPi() {
  const counts = new Map()
  const dir = join(home, ".pi", "agent", "sessions")
  for (const path of await fg("**/*.jsonl", { cwd: dir })) {
    const text = await readFile(join(dir, path), "utf-8")
    for (const line of text.split("\n")) {
      if (!line.includes('"usage"')) continue
      try {
        const obj = JSON.parse(line)
        if (obj.type !== "message") continue
        const u = obj.message?.usage || obj.usage
        const tokens = u?.totalTokens || ((u?.input || 0) + (u?.output || 0) + (u?.reasoning || 0) + (u?.cacheRead || 0) + (u?.cacheWrite || 0))
        if (tokens > 0 && obj.timestamp) add(counts, isoToDate(obj.timestamp), tokens)
      } catch {}
    }
  }
  return counts
}

const tools = [
  { name: "Claude Code", collect: collectClaude, color: "#f97316" },
  { name: "Codex", collect: collectCodex, color: "#22c55e" },
  { name: "OpenCode", collect: collectOpenCode, color: "#3b82f6" },
  { name: "Gemini CLI", collect: collectGemini, color: "#eab308" },
  { name: "Amp", collect: collectAmp, color: "#a855f7" },
  { name: "Pi", collect: collectPi, color: "#ec4899" },
]

function catmullRomPath(points, tension = 0.3, yFloor) {
  if (points.length < 2) return ""
  const clampY = (y) => yFloor !== undefined ? Math.min(y, yFloor) : y
  let d = `M${points[0].x},${points[0].y}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[Math.min(points.length - 1, i + 2)]
    const cp1y = clampY(p1.y + (p2.y - p0.y) * tension / 3)
    const cp2y = clampY(p2.y - (p3.y - p1.y) * tension / 3)
    d += ` C${p1.x + (p2.x - p0.x) * tension / 3},${cp1y} ${p2.x - (p3.x - p1.x) * tension / 3},${cp2y} ${p2.x},${p2.y}`
  }
  return d
}

function formatTotal(n) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "B"
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k"
  return String(n)
}

function renderChart(allDays, results, total) {
  const W = 1500, H = 560
  const pad = { top: 130, right: 50, bottom: 60, left: 50 }
  const chartW = W - pad.left - pad.right
  const chartH = H - pad.top - pad.bottom
  const font = `'Berkeley Mono', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
  const mono = `'Berkeley Mono', 'SF Mono', 'Fira Code', monospace`

  const numWeeks = Math.ceil(allDays.length / 7)
  const toolWeekly = results.map(r => {
    const weeks = []
    for (let i = 0; i < allDays.length; i += 7) {
      let sum = 0
      for (let j = i; j < Math.min(i + 7, allDays.length); j++) sum += r.counts.get(allDays[j]) || 0
      weeks.push(sum)
    }
    return weeks
  })

  const stacked = []
  for (let t = 0; t < results.length; t++) {
    stacked.push(Array.from({ length: numWeeks }, (_, w) => {
      let sum = 0
      for (let ti = 0; ti <= t; ti++) sum += toolWeekly[ti][w]
      return sum
    }))
  }

  const maxY = (Math.max(...stacked[stacked.length - 1]) || 1) * 1.08

  const toX = (w) => pad.left + (w / (numWeeks - 1)) * chartW
  const toY = (val) => pad.top + chartH - (val / maxY) * chartH
  const baseline = pad.top + chartH

  let areas = ""
  for (let t = results.length - 1; t >= 0; t--) {
    const topPoints = Array.from({ length: numWeeks }, (_, w) => ({ x: toX(w), y: toY(stacked[t][w]) }))
    const botPoints = t === 0
      ? [{ x: toX(0), y: baseline }, { x: toX(numWeeks - 1), y: baseline }]
      : Array.from({ length: numWeeks }, (_, w) => ({ x: toX(w), y: toY(stacked[t - 1][w]) }))

    const topPath = catmullRomPath(topPoints, 0.3, baseline)
    const botReversed = [...botPoints].reverse()
    const botPath = t === 0
      ? `L${toX(numWeeks - 1)},${baseline} L${toX(0)},${baseline}`
      : catmullRomPath(botReversed, 0.3, baseline).replace("M", "L")

    areas += `<path d="${topPath} ${botPath} Z" fill="${results[t].color}" opacity="0.55" clip-path="url(#chart-clip)"/>\n`
  }

  const totalPoints = Array.from({ length: numWeeks }, (_, w) => ({ x: toX(w), y: toY(stacked[stacked.length - 1][w]) }))
  const totalPath = catmullRomPath(totalPoints, 0.3, baseline)

  const gridCount = 4
  let gridLines = ""
  for (let i = 1; i <= gridCount; i++) {
    const val = (maxY / gridCount) * i
    const y = pad.top + chartH - (i / gridCount) * chartH
    gridLines += `<line x1="${pad.left}" y1="${y}" x2="${pad.left + chartW}" y2="${y}" stroke="#21262d" stroke-width="1"/>\n`
    gridLines += `<text x="${pad.left + chartW + 8}" y="${y + 4}" fill="#3b434b" font-family="${font}" font-size="11">${formatTotal(val)}</text>\n`
  }

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  let labels = ""
  const seenLabels = new Set()
  const startDate = new Date(allDays[0] + "T00:00:00")
  const endDate = new Date(allDays[allDays.length - 1] + "T00:00:00")
  let cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1)
  while (cursor <= endDate) {
    const iso = cursor.toISOString().slice(0, 10)
    const dayIndex = allDays.indexOf(iso)
    const effectiveIndex = dayIndex >= 0 ? dayIndex : allDays.findIndex(d => d >= iso)
    if (effectiveIndex >= 0) {
      const x = pad.left + (effectiveIndex / (allDays.length - 1)) * chartW
      const label = `${monthNames[cursor.getMonth()]} '${String(cursor.getFullYear()).slice(2)}`
      if (!seenLabels.has(label) && x >= pad.left + 20 && x <= pad.left + chartW - 20) {
        seenLabels.add(label)
        labels += `<text x="${x}" y="${H - 18}" text-anchor="middle" fill="#484f58" font-family="${font}" font-size="13">${label}</text>\n`
      }
    }
    cursor.setMonth(cursor.getMonth() + 1)
  }

  const visible = results.filter(r => [...r.counts.values()].reduce((a, b) => a + b, 0) > 0)
  const legendItemW = 145
  const legendStartX = pad.left + 8
  const legendEndX = legendStartX + visible.length * legendItemW
  const totalStartX = W - pad.right - 160
  const midX = (legendEndX + totalStartX) / 2 - 30
  const vcenter = pad.top / 2
  let legend = ""
  for (let i = 0; i < visible.length; i++) {
    const x = legendStartX + i * legendItemW
    const count = [...visible[i].counts.values()].reduce((a, b) => a + b, 0)
    legend += `<rect x="${x}" y="${vcenter - 14}" width="14" height="14" rx="3" fill="${visible[i].color}" opacity="0.8"/>`
    legend += `<text x="${x + 20}" y="${vcenter}" fill="#8b949e" font-family="${font}" font-size="18">${visible[i].name}</text>`
    legend += `<text x="${x + 20}" y="${vcenter + 20}" fill="#8b949e" font-family="${font}" font-size="17">${formatTotal(count)}</text>\n`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <clipPath id="chart-clip">
    <rect x="${pad.left}" y="${pad.top - 4}" width="${chartW}" height="${chartH + 8}"/>
  </clipPath>
</defs>
<rect width="${W}" height="${H}" fill="#0d1117"/>
<text x="${W - pad.right}" y="${vcenter + 6}" text-anchor="end" fill="#f0f6fc" font-family="${font}" font-size="48" font-weight="800">${formatTotal(total)}</text>
<text x="${W - pad.right}" y="${vcenter + 26}" text-anchor="end" fill="#484f58" font-family="${font}" font-size="16" letter-spacing="2" font-weight="600">TOKENS</text>
<rect x="${midX - 170}" y="${vcenter - 20}" width="340" height="40" rx="8" fill="#161b22"/>
<text x="${midX}" y="${vcenter + 5}" text-anchor="middle" fill="#8b949e" font-family="${mono}" font-size="22">npx clanker-stats --share</text>
${legend}
${gridLines}
${areas}
<path d="${totalPath}" fill="none" stroke="#e6edf3" stroke-width="1.5" stroke-opacity="0.4" stroke-linejoin="round" stroke-linecap="round" clip-path="url(#chart-clip)"/>
${labels}
</svg>`
}

function openPath(target) {
  try {
    if (process.platform === "darwin") execFileSync("open", [target])
    else if (process.platform === "win32") execFileSync("cmd", ["/c", "start", "", target])
    else execFileSync("xdg-open", [target])
  } catch {}
}

async function main() {
  const share = process.argv.includes("--share")
  const results = []
  for (const tool of tools) {
    try {
      const counts = await tool.collect()
      results.push({ name: tool.name, color: tool.color, counts })
      const t = [...counts.values()].reduce((a, b) => a + b, 0)
      console.log(`${tool.name}: ${formatTotal(t)} tokens`)
    } catch (e) {
      console.warn(`${tool.name}: skipped (${e?.message || e})`)
      results.push({ name: tool.name, color: tool.color, counts: new Map() })
    }
  }

  const allDates = new Set()
  for (const r of results) for (const d of r.counts.keys()) allDates.add(d)
  const dates = [...allDates].sort()

  if (dates.length === 0) {
    console.error("No data found.")
    process.exit(1)
  }

  const start = new Date(dates[0])
  const end = new Date(dates[dates.length - 1])
  const allDays = []
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    allDays.push(d.toISOString().slice(0, 10))
  }

  const total = results.reduce((sum, r) => sum + [...r.counts.values()].reduce((a, b) => a + b, 0), 0)
  console.log(`\n${allDays.length} days, ${formatTotal(total)} total tokens`)

  const svg = renderChart(allDays, results, total)
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1500 } })
  const png = resvg.render().asPng()

  const outPath = join(process.cwd(), "chart.png")
  await writeFile(outPath, png)
  console.log(`Wrote ${outPath}`)

  if (share) {
    if (process.platform === "darwin") {
      const escaped = outPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
      execFileSync("osascript", ["-e", `set the clipboard to (read (POSIX file "${escaped}") as \u00ABclass PNGf\u00BB)`])
      console.log("Image copied to clipboard")
    } else {
      console.log("Copy the image manually: " + outPath)
    }
    const visible = results.filter(r => [...r.counts.values()].reduce((a, b) => a + b, 0) > 0)
    const text = `${formatTotal(total)} tokens across ${visible.length} AI coding tools\n\nnpx clanker-stats`
    openPath(`https://x.com/intent/post?text=${encodeURIComponent(text)}`)
    console.log("Paste the image from your clipboard into the post")
  } else {
    openPath(outPath)
  }
}

main()
