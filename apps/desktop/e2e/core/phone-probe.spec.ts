/**
 * Phone-width probe of the Webapp: layout overflow, drawer geometry, real touch swipes and render cost.
 * Runs against the e2e sandbox gateway (its own home + scripted provider), never the live gateway.
 * Output: JSON at $PHONE_PROBE_OUT plus screenshots next to it.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { type BrowserContext, chromium, expect, type Page, test } from '@playwright/test'

import {
  composer,
  createCoreSandbox,
  DESKTOP_ROOT,
  freePort,
  recordWebSockets,
  sandboxProcesses,
  waitForInteractive,
  webappLaunchLink,
  writeProviderHome
} from './harness'
import { startScriptedProvider } from './provider'

const OUT = process.env.PHONE_PROBE_OUT || '/tmp/phone-probe'
const W = Number(process.env.PHONE_W || 390)
const H = Number(process.env.PHONE_H || 844)

const sessions = new WeakMap<Page, Promise<CDPSession>>()

/** One touch-emulation session per page: re-attaching per gesture drops and hangs touches. */
function touchSession(page: Page) {
  let session = sessions.get(page)

  if (!session) {
    session = page.context().newCDPSession(page)
    sessions.set(page, session)
  }

  return session
}

async function swipe(page: Page, from: [number, number], to: [number, number], steps = 8) {
  const cdp = await touchSession(page)
  const pt = (x: number, y: number) => [{ x, y, id: 1 }]

  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(...from) })

  for (let i = 1; i <= steps; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / steps
    const y = from[1] + ((to[1] - from[1]) * i) / steps
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x, y) })
    await page.waitForTimeout(16)
  }

  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

// CDP Performance counters, for "what did this gesture cost the main thread".
async function perfSession(ctx: BrowserContext, page: Page) {
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Performance.enable')

  return async () => {
    const m = (await cdp.send('Performance.getMetrics')).metrics as { name: string; value: number }[]
    const g = (n: string) => m.find(x => x.name === n)?.value ?? 0

    return { style: g('RecalcStyleDuration'), styleN: g('RecalcStyleCount'), task: g('TaskDuration') }
  }
}

const drawer = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-narrow-overlay]') as HTMLElement | null

    if (!el) {return null}
    const r = el.getBoundingClientRect()
    const root = document.documentElement

    return {
      left: Math.round(r.left),
      right: Math.round(r.right),
      width: Math.round(r.width),
      height: Math.round(r.height),
      visibleWidth: Math.round(Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0))),
      dragVar: root.style.getPropertyValue('--drawer-drag') || null,
      dragAttr: root.hasAttribute('data-drawer-drag'),
      transform: getComputedStyle(el).transform
    }
  })

test('phone-width probe', async () => {
  test.setTimeout(600_000)
  fs.mkdirSync(OUT, { recursive: true })
  const provider = await startScriptedProvider()
  const sandbox = createCoreSandbox('phone')
  writeProviderHome(sandbox.hermesHome, provider.url)
  const port = await freePort()
  fs.appendFileSync(path.join(sandbox.hermesHome, 'config.yaml'), `\nwebapp:\n  enabled: true\n  port: ${port}\n`)
  const report: Record<string, unknown> = { viewport: [W, H] }

  const browser = await chromium.launch({
    executablePath: process.env.HERMES_E2E_CHROMIUM || undefined,
    args: ['--no-sandbox']
  })

  try {
    if (process.env.PROBE_SEED) {
      // Realistic sidebar volume: the live DB has ~1,600 sessions, the bare sandbox has none.
      const py = process.env.PROBE_PYTHON || path.join(os.homedir(), 'dev/hermes-agent-fork/.venv/bin/python')
      execFileSync(py, [path.join(DESKTOP_ROOT, 'e2e/core/seed-sessions.py'), sandbox.hermesHome, process.env.PROBE_SEED], { stdio: 'inherit', timeout: 240_000 })
      report.seeded = Number(process.env.PROBE_SEED)
    }

    const link = webappLaunchLink(sandbox)

    const ctx = await browser.newContext({
      viewport: { width: W, height: H },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36'
    })

    const page = await ctx.newPage()
    const ws = recordWebSockets(page)
    await page.addInitScript(() => {
      ;(window as unknown as { __long: number[] }).__long = []
      ;(window as unknown as { __longAt: number[] }).__longAt = []

      try {
        new PerformanceObserver(list => {
          for (const e of list.getEntries()) { (window as unknown as { __long: number[] }).__long.push(Math.round(e.duration)); ;(window as unknown as { __longAt: number[] }).__longAt.push(Math.round(e.startTime)) }
        }).observe({ entryTypes: ['longtask'] })
      } catch {
      // already gone
    }
    })
    // PROBE_CPU=4 PROBE_NET=4g reproduces a mid-range phone on mobile data.
    const throttle = await ctx.newCDPSession(page)

    if (process.env.PROBE_CPU) {await throttle.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.PROBE_CPU) })}

    if (process.env.PROBE_NET === '4g') {
      await throttle.send('Network.enable')
      await throttle.send('Network.emulateNetworkConditions', { offline: false, latency: 70, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (4 * 1024 * 1024) / 8 })
    }

    report.throttle = { cpu: process.env.PROBE_CPU ?? null, net: process.env.PROBE_NET ?? null }
    // PROBE_BOOTPROF=1: self-time per file during boot (module evaluation shows up under the file that ran).
    const bootProf = process.env.PROBE_BOOTPROF ? await ctx.newCDPSession(page) : null

    if (bootProf) {
      await bootProf.send('Profiler.enable')
      await bootProf.send('Profiler.setSamplingInterval', { interval: 200 })
      await bootProf.send('Profiler.start')
    }

    // PROBE_COVERAGE=1: bytes of each JS file that actually ran before the composer appeared.
    if (process.env.PROBE_COVERAGE) {await page.coverage.startJSCoverage({ resetOnNavigation: false })}
    const t0 = Date.now()
    await page.goto(link)
    await expect(composer(page)).toBeVisible({ timeout: 240_000 })
    report.bootToComposerMs = Date.now() - t0

    if (bootProf) {
      const { profile } = (await bootProf.send('Profiler.stop')) as { profile: { nodes: { id: number; callFrame: { functionName: string; url: string } }[]; samples: number[]; timeDeltas: number[] } }
      const self = new Map<number, number>()
      profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)))
      const byFile = new Map<string, number>()

      for (const n of profile.nodes) {
        const t = self.get(n.id) ?? 0

        if (!t) {continue}
        const f = n.callFrame.functionName === '(idle)' ? '(idle)' : n.callFrame.functionName === '(program)' ? '(program: parse/compile/gc/native)' : n.callFrame.url.split('/').pop() || '(native)'
        byFile.set(f, (byFile.get(f) ?? 0) + t)
      }

      report.bootProfile = { cpu: process.env.PROBE_CPU ?? null, composerMs: Date.now() - t0, byFileMs: [...byFile].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([n, t]) => `${Math.round(t / 1000)}ms ${n}`) }
    }

    if (process.env.PROBE_COVERAGE) {
      const entries = await page.coverage.stopJSCoverage()

      const rows = entries
        .filter(e => /\/assets\/.*\.js/.test(e.url))
        .map(e => {
          const total = e.source?.length ?? 0
          // block coverage can nest ranges; merge before summing
          const rs = (e.functions ?? []).flatMap(f => f.ranges.map(r => ({ s: r.startOffset, e: r.endOffset, c: r.count })))
          const used = new Uint8Array(total)

          for (const r of rs.sort((x, y) => (x.e - x.s) - (y.e - y.s) === 0 ? 0 : (y.e - y.s) - (x.e - x.s))) {used.fill(r.c > 0 ? 1 : 0, r.s, Math.min(r.e, total))}
          let u = 0

          for (let i = 0; i < total; i++) {u += used[i]}

          return { file: e.url.split('/').pop() ?? e.url, total, used: u }
        })

      const sum = (k: 'total' | 'used') => Math.round(rows.reduce((t, r) => t + r[k], 0) / 1024)
      report.coverage = {
        files: rows.length,
        totalKB: sum('total'),
        usedKB: sum('used'),
        filesWithNoUse: rows.filter(r => r.used < 200).length,
        neverRunKB: Math.round(rows.filter(r => r.used < 200).reduce((t, r) => t + r.total, 0) / 1024),
        top: rows.sort((x, y) => y.total - x.total).slice(0, 12).map(r => `${r.file} total=${Math.round(r.total / 1024)}KB used=${Math.round(r.used / 1024)}KB (${Math.round((100 * r.used) / Math.max(1, r.total))}%)`)
      }
    }

    report.boot = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
      const fcp = performance.getEntriesByName('first-contentful-paint')[0]
      const res = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter(r => /\.(js|css)$/.test(r.name.split('?')[0]))
      const kb = (n: number) => Math.round(n / 1024)

      return {
        fcpMs: fcp ? Math.round(fcp.startTime) : null,
        navDoneMs: nav ? Math.round(nav.loadEventEnd) : null,
        resources: res.length,
        decodedKB: kb(res.reduce((a, r) => a + r.decodedBodySize, 0)),
        transferKB: kb(res.reduce((a, r) => a + r.transferSize, 0)),
        lastResponseEndMs: Math.round(Math.max(...res.map(r => r.responseEnd))),
        top: res
          .sort((a, b) => b.decodedBodySize - a.decodedBodySize)
          .slice(0, 12)
          .map(r => `${r.name.split('/').pop()} ${kb(r.decodedBodySize)}KB start=${Math.round(r.startTime)} end=${Math.round(r.responseEnd)}`)
      }
    })

    // PROBE_WARM=1: a returning visit (assets in the HTTP cache) is what a phone does day to day.
    if (process.env.PROBE_WARM) {
      const w0 = Date.now()
      await page.reload()
      await expect(composer(page)).toBeVisible({ timeout: 240_000 })
      const warmMs = Date.now() - w0
      const fcp = await page.evaluate(() => Math.round(performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? -1))

      const cached = await page.evaluate(() => {
        const r = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter(x => /\.js$/.test(x.name.split('?')[0]))

        return { js: r.length, fromCache: r.filter(x => x.transferSize === 0).length, transferKB: Math.round(r.reduce((t, x) => t + x.transferSize, 0) / 1024) }
      })

      report.warmBoot = { composerMs: warmMs, fcpMs: fcp, ...cached }
    }

    // PROBE_PROFILE=1: main-thread split + JS self-time for the streaming turns below.
    const prof = process.env.PROBE_PROFILE ? await ctx.newCDPSession(page) : null

    const metric = async () => {
      const m = (await prof!.send('Performance.getMetrics')).metrics as { name: string; value: number }[]
      const g = (n: string) => m.find(x => x.name === n)?.value ?? 0

      return { task: g('TaskDuration'), script: g('ScriptDuration'), layout: g('LayoutDuration'), style: g('RecalcStyleDuration'), layoutCount: g('LayoutCount'), styleCount: g('RecalcStyleCount'), nodes: g('Nodes') }
    }

    let m0: Awaited<ReturnType<typeof metric>> | null = null

    if (prof) {
      await prof.send('Performance.enable')
      await prof.send('Profiler.enable')
      await prof.send('Profiler.setSamplingInterval', { interval: 500 })
      await prof.send('Profiler.start')
      m0 = await metric()
    }

    const marks: Record<string, number> = {}

    const mark = async (n: string) => { marks[n] = await page.evaluate(() => Math.round(performance.now())) }
    await mark('turnsStart')
    const tTurns = Date.now()

    // A few turns so the sidebar and transcript have content.
    for (let i = 1; i <= 3; i++) {
      const marker = `U${i}-phone${Date.now().toString(36)}`
      provider.script(marker, [{ text: [`Reply ${i}: `, 'x '.repeat(400), '\n\n```\n' + 'long_code_line_'.repeat(20) + '\n```\n\n| a | b |\n|---|---|\n| 1 | ' + 'wide '.repeat(30) + ' |\n'] }])
      const box = composer(page)
      await box.click()
      await box.fill(`${marker} question ${i}`)
      const btn = page.locator('button[type=submit], button[aria-label*="Send" i]').last()
      report[`sendBtn${i}`] = { count: await page.locator('button[type=submit]').count(), enabled: await btn.isEnabled().catch(() => null), box: await btn.boundingBox().catch(() => null) }
      await btn.tap()
      await page.waitForTimeout(2500)
      report[`afterTap${i}`] = { draft: (await box.textContent().catch(() => ''))?.slice(0, 40), sent: ws.sent.length, completions: provider.completions.length }
      await page.screenshot({ path: path.join(OUT, `00-after-tap-${i}.png`) })
      await expect
        .poll(() => provider.completions.some(c => c.marker === marker && c.finished), { timeout: 120_000 })
        .toBe(true)
    }

    if (prof && m0) {
      const wallMs = Date.now() - tTurns
      const m1 = await metric()
      const { profile } = (await prof.send('Profiler.stop')) as { profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]; samples: number[]; timeDeltas: number[] } }
      const self = new Map<number, number>()
      profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)))
      const byFn = new Map<string, number>()
      const byFile = new Map<string, number>()

      for (const n of profile.nodes) {
        const t = self.get(n.id) ?? 0

        if (!t) {continue}
        const file = n.callFrame.url.split('/').pop() || '(native)'
        const key = `${n.callFrame.functionName || '(anon)'} ${file}:${n.callFrame.lineNumber}`
        byFn.set(key, (byFn.get(key) ?? 0) + t)
        byFile.set(file, (byFile.get(file) ?? 0) + t)
      }

      const top = (m: Map<string, number>, k: number) => [...m].sort((x, y) => y[1] - x[1]).slice(0, k).map(([n, t]) => `${Math.round(t / 1000)}ms ${n}`)
      const d = (k: keyof typeof m1) => Math.round((m1[k] - m0![k]) * 1000)
      report.turnsProfile = { cpuThrottle: process.env.PROBE_CPU ?? null, wallMs, mainThreadMs: { task: d('task'), script: d('script'), layout: d('layout'), style: d('style') }, layouts: m1.layoutCount - m0.layoutCount, styleRecalcs: m1.styleCount - m0.styleCount, domNodes: m1.nodes, topFunctions: top(byFn, 14), topFiles: top(byFile, 8) }
    }

    await mark('turnsEnd')
    await page.waitForTimeout(1500)
    await page.screenshot({ path: path.join(OUT, '01-chat.png') })

    await mark('layoutScanStart')
    report.layout = await page.evaluate(() => {
      const vw = innerWidth
      const wide: string[] = []

      for (const el of Array.from(document.querySelectorAll('body *')) as HTMLElement[]) {
        const r = el.getBoundingClientRect()

        if (r.width > 0 && r.right > vw + 1 && getComputedStyle(el).position !== 'fixed') {
          const cs = getComputedStyle(el)
          // ignore things clipped by an overflow ancestor
          let p: HTMLElement | null = el.parentElement
          let clipped = false

          while (p && p !== document.body) {
            const o = getComputedStyle(p).overflowX

            if (o !== 'visible' && p.getBoundingClientRect().right <= vw + 1) { clipped = true;

 break }

            p = p.parentElement
          }

          if (!clipped && cs.visibility !== 'hidden') {wide.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} right=${Math.round(r.right)}`)}
        }

        if (wide.length > 15) {break}
      }

      const small: string[] = []

      for (const el of Array.from(document.querySelectorAll('button, a, [role=button], [role=tab]')) as HTMLElement[]) {
        const r = el.getBoundingClientRect()

        if (r.width > 0 && r.height > 0 && r.right > 0 && r.left < vw && (r.width < 36 || r.height < 36)) {
          small.push(`${el.tagName.toLowerCase()} ${Math.round(r.width)}x${Math.round(r.height)} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24)}"`)
        }
      }

      const meta = document.querySelector('meta[name=viewport]')?.getAttribute('content')

      const blur = Array.from(document.querySelectorAll('*')).filter(e => {
        const c = getComputedStyle(e as Element)

        return (c.backdropFilter && c.backdropFilter !== 'none') || ((c as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter ?? 'none') !== 'none'
      }).length

      const composerEl = document.querySelector('[data-slot="composer-root"]') as HTMLElement | null
      const cr = composerEl?.getBoundingClientRect()

      return {
        viewportMeta: meta,
        docScrollWidth: document.documentElement.scrollWidth,
        innerWidth: vw,
        horizontalScroll: document.documentElement.scrollWidth > vw,
        overflowingElements: wide,
        smallTapTargets: small.slice(0, 25),
        smallTapTargetCount: small.length,
        backdropFilterElements: blur,
        domNodes: document.getElementsByTagName('*').length,
        composer: cr ? { top: Math.round(cr.top), bottom: Math.round(cr.bottom), height: Math.round(cr.height), innerHeight } : null,
        bodyOverscroll: getComputedStyle(document.body).overscrollBehaviorY,
        htmlHeight: Math.round(document.documentElement.getBoundingClientRect().height),
        dvhSupport: CSS.supports('height', '100dvh')
      }
    })

    await mark('toggleStart')
    // Drawer by titlebar toggle.
    const toggle = page.locator('[aria-label*="sidebar" i], [aria-label*="sessions" i]').first()
    report.toggleFound = (await toggle.count()) > 0

    if (report.toggleFound) {
      await toggle.tap({ timeout: 4000 }).catch(() => undefined)
      await page.waitForTimeout(600)
      report.drawerAfterTap = await drawer(page)
      await page.screenshot({ path: path.join(OUT, '02-drawer-tap.png') })

      if (process.env.PROBE_DRAGAB) {
        // A/B: where the drag variable is written decides how much of the page restyles per touchmove.
        const cdp = await ctx.newCDPSession(page)
        await cdp.send('Performance.enable')

        const snap = async () => {
          const m = (await cdp.send('Performance.getMetrics')).metrics as { name: string; value: number }[]
          const g = (n: string) => m.find(x => x.name === n)?.value ?? 0

          return { style: g('RecalcStyleDuration'), styleN: g('RecalcStyleCount'), layout: g('LayoutDuration'), task: g('TaskDuration') }
        }

        const run = async (where: 'root' | 'overlay' | 'overlay-np') => {
          if (where === 'overlay-np') {await page.addStyleTag({ content: '@property --drawer-drag { syntax: "<number>"; inherits: false; initial-value: 1; }' })}
          await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(0))))
          const before = await snap()

          const wall = await page.evaluate(async ([w, frames]) => {
            const root = document.documentElement
            const ov = document.querySelector('[data-narrow-overlay]') as HTMLElement
            const t0 = performance.now()
            root.setAttribute('data-drawer-drag', '')

            for (let i = 0; i < (frames as number); i++) {
              const v = (0.5 + 0.5 * Math.sin(i / 5)).toFixed(3)

              ;(w !== 'root' ? ov : root).style.setProperty('--drawer-drag', v)
              await new Promise(r => requestAnimationFrame(() => r(0)))
            }

            ;(w !== 'root' ? ov : root).style.removeProperty('--drawer-drag')
            root.removeAttribute('data-drawer-drag')

            return performance.now() - t0
          }, [where, 90] as const)

          const after = await snap()

          return { where, frames: 90, wallMs: Math.round(wall), styleMs: Math.round((after.style - before.style) * 1000), styleRecalcs: after.styleN - before.styleN, layoutMs: Math.round((after.layout - before.layout) * 1000), taskMs: Math.round((after.task - before.task) * 1000) }
        }

        const out = []

        for (const w of ['root', 'overlay', 'overlay-np', 'root', 'overlay', 'overlay-np'] as const) {out.push(await run(w))}
        report.dragAB = { cpu: process.env.PROBE_CPU ?? null, seeded: process.env.PROBE_SEED ?? 0, domNodes: await page.evaluate(() => document.getElementsByTagName('*').length), runs: out }
      }

      await page.keyboard.press('Escape')
      await page.waitForTimeout(500)
      report.drawerAfterEscape = await drawer(page)
    }

    await mark('swipesStart')

    // Drawer by real touch swipes: several start points (edge / middle, over text / over a code block / empty area).
    const underTouch = (x: number, y: number) =>
      page.evaluate(([px, py]) => {
        const el = document.elementFromPoint(px, py) as HTMLElement | null
        let sideways = false

        for (let n: HTMLElement | null = el; n && n !== document.body; n = n.parentElement) {
          const cs = getComputedStyle(n)

          if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && n.scrollWidth > n.clientWidth + 1) { sideways = true;

 break }
        }

        return { tag: el ? el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 40) : null, insideSidewaysScroller: sideways }
      }, [x, y])

    const swipes: unknown[] = []

    for (const [label, sx, sy, dx, steps] of [
      ['edge-slow', 40, 300, 230, 20],
      ['edge-fast', 40, 300, 230, 4],
      ['mid-y150', 120, 150, 200, 10],
      ['mid-y300', 120, 300, 200, 10],
      ['mid-y450', 120, 450, 200, 10],
      ['mid-y620', 120, 620, 200, 10],
      ['short-y300', 40, 300, 80, 6],
      ['tiny-y300', 40, 300, 40, 3]
    ] as const) {
      const where = await underTouch(sx, sy)
      const cost = process.env.PROBE_SWIPECOST ? await perfSession(ctx, page) : null
      const before = cost ? await cost() : null
      await swipe(page, [sx, sy], [sx + dx, sy + 4], steps)

      if (cost && before) {
        const after = await cost()
        ;(report.swipeCost ??= [] as unknown[]) // eslint-disable-line
        ;(report.swipeCost as unknown[]).push({ label, moves: steps, styleMsPerMove: +(((after.style - before.style) * 1000) / steps).toFixed(1), styleRecalcs: after.styleN - before.styleN, taskMsPerMove: +(((after.task - before.task) * 1000) / steps).toFixed(1) })
      }

      await page.waitForTimeout(700)
      const opened = await drawer(page)

      if (label === 'edge-slow') {await page.screenshot({ path: path.join(OUT, '03-swipe-open.png') })}

      if (opened) {await swipe(page, [Math.max(30, opened.right - 20), 500], [10, 500], 6)}
      await page.waitForTimeout(700)
      swipes.push({ label, from: [sx, sy], where, opened, afterClose: await drawer(page) })
    }

    report.swipes = swipes

    await mark('rapidStart')
    // PROBE_PROFILE_DRAWER=1: JS self-time for the rapid open/close block + how many sidebar rows exist.
    const dProf = process.env.PROBE_PROFILE_DRAWER ? await ctx.newCDPSession(page) : null

    if (dProf) {
      await dProf.send('Profiler.enable')
      await dProf.send('Profiler.setSamplingInterval', { interval: 300 })
      await dProf.send('Profiler.start')
    }

    // Rapid open/close cycles: does it ever strand?
    for (let i = 0; i < 6; i++) {
      await swipe(page, [40, 300], [280, 304], 6)
      await page.waitForTimeout(120)
      await swipe(page, [240, 500], [10, 500], 4)
      await page.waitForTimeout(60)
    }

    await page.waitForTimeout(800)
    report.afterRapid = await drawer(page)

    if (dProf) {
      const { profile } = (await dProf.send('Profiler.stop')) as { profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]; samples: number[]; timeDeltas: number[] } }
      const self = new Map<number, number>()
      profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)))
      const byFn = new Map<string, number>()

      for (const n of profile.nodes) {
        const t = self.get(n.id) ?? 0

        if (!t || n.callFrame.functionName === '(idle)') {continue}
        const key = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop() || '(native)'}:${n.callFrame.lineNumber}`
        byFn.set(key, (byFn.get(key) ?? 0) + t)
      }

      report.drawerProfile = {
        topFunctions: [...byFn].sort((x, y) => y[1] - x[1]).slice(0, 16).map(([n, t]) => `${Math.round(t / 1000)}ms ${n}`),
        dom: await page.evaluate(() => ({
          nodes: document.getElementsByTagName('*').length,
          sidebarLinks: document.querySelectorAll('[data-narrow-overlay] a, [data-narrow-overlay] [role=button], [data-narrow-overlay] button').length,
          overlayNodes: document.querySelector('[data-narrow-overlay]')?.getElementsByTagName('*').length ?? 0
        }))
      }
    }

    await mark('toggleAfterRapid')

    // What sits over the toggle now? Tap with a short timeout so a covered toggle is reported, not hung on.
    if (report.toggleFound) {
      const tb = await toggle.boundingBox()
      report.toggleBox = tb

      if (tb) {
        report.coveredBy = await page.evaluate(([x, y]) => {
          const el = document.elementFromPoint(x, y) as HTMLElement | null

          return el ? el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 80) + ' ' + (el.getAttribute('aria-label') || '') : null
        }, [tb.x + tb.width / 2, tb.y + tb.height / 2])
      }

      report.toggleTap = await toggle.tap({ timeout: 4000 }).then(() => 'ok', e => String(e).split('\n')[0].slice(0, 160))
      await page.waitForTimeout(700)
      report.drawerOpenAfterRapid = await drawer(page)
      await page.screenshot({ path: path.join(OUT, '04-after-rapid.png') })
    }

    await mark('scrollStart')

    // Scroll jank on the transcript.
    const scrollStats = await page.evaluate(async () => {
      const el = (document.querySelector('[data-slot="transcript"], [data-testid="transcript"], main [class*="overflow-y"]') as HTMLElement) || document.scrollingElement!
      const frames: number[] = []
      let last = performance.now()
      let n = 0
      await new Promise<void>(resolve => {
        const tick = (t: number) => {
          frames.push(t - last)
          last = t
          el.scrollTop = (el.scrollTop + 40) % Math.max(1, el.scrollHeight - el.clientHeight)

          if (++n < 90) {requestAnimationFrame(tick)}
          else {resolve()}
        }

        requestAnimationFrame(tick)
      })
      const sorted = [...frames].sort((a, b) => a - b)

      return {
        frames: frames.length,
        medianMs: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10,
        p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10,
        over34ms: frames.filter(f => f > 34).length,
        scroller: el.tagName + '.' + String(el.className).slice(0, 50)
      }
    })

    report.scroll = scrollStats
    await mark('end')
    report.longTasksMs = await page.evaluate(() => (window as unknown as { __long: number[] }).__long)

    {
      const at = await page.evaluate(() => (window as unknown as { __longAt: number[] }).__longAt)
      const dur = report.longTasksMs as number[]
      const order = Object.entries(marks).sort((x, y) => x[1] - y[1])

      const phase = (t: number) => {
        let name = 'boot'

        for (const [n, v] of order) {if (t >= v) {name = n}}

        return name
      }

      const agg: Record<string, { n: number; ms: number; max: number }> = {}
      at.forEach((t, i) => { const a = (agg[phase(t)] ??= { n: 0, ms: 0, max: 0 }); a.n++; a.ms += dur[i]; a.max = Math.max(a.max, dur[i]) })
      report.longTasksByPhase = { marks, ...agg }
    }

    report.longTasksMs = await page.evaluate(() => (window as unknown as { __long: number[] }).__long)

    const perf = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
      const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
      const js = res.filter(r => r.name.endsWith('.js'))

      return {
        domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        jsFiles: js.length,
        jsTransferKB: Math.round(js.reduce((a, r) => a + (r.transferSize || 0), 0) / 1024),
        jsDecodedKB: Math.round(js.reduce((a, r) => a + (r.decodedBodySize || 0), 0) / 1024),
        biggest: js.sort((a, b) => b.decodedBodySize - a.decodedBodySize).slice(0, 5).map(r => `${r.name.split('/').pop()} ${Math.round(r.decodedBodySize / 1024)}KB`)
      }
    })

    report.load = perf
    await waitForInteractive(page).catch(() => undefined)
  } finally {
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
    await browser.close().catch(() => undefined)

    for (const proc of sandboxProcesses(sandbox)) {
      try { process.kill(proc.pid, 'SIGKILL') } catch {
      // already gone
    }
    }

    await provider.close?.().catch(() => undefined)
  }
})
