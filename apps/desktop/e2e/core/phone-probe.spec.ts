/**
 * Phone-width probe of the Webapp: layout overflow, drawer geometry, real touch swipes and render cost.
 * Runs against the e2e sandbox gateway (its own home + scripted provider), never the live gateway.
 * Output: JSON at $PHONE_PROBE_OUT plus screenshots next to it.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { chromium, expect, type Page, test } from '@playwright/test'

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

const drawer = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-narrow-overlay]') as HTMLElement | null
    if (!el) return null
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
      try {
        new PerformanceObserver(list => {
          for (const e of list.getEntries()) (window as unknown as { __long: number[] }).__long.push(Math.round(e.duration))
        }).observe({ entryTypes: ['longtask'] })
      } catch {}
    })
    const t0 = Date.now()
    await page.goto(link)
    await expect(composer(page)).toBeVisible({ timeout: 240_000 })
    report.bootToComposerMs = Date.now() - t0

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

    await page.waitForTimeout(1500)
    await page.screenshot({ path: path.join(OUT, '01-chat.png') })

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
            if (o !== 'visible' && p.getBoundingClientRect().right <= vw + 1) { clipped = true; break }
            p = p.parentElement
          }
          if (!clipped && cs.visibility !== 'hidden') wide.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} right=${Math.round(r.right)}`)
        }
        if (wide.length > 15) break
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

    // Drawer by titlebar toggle.
    const toggle = page.locator('[aria-label*="sidebar" i], [aria-label*="sessions" i]').first()
    report.toggleFound = (await toggle.count()) > 0
    if (report.toggleFound) {
      await toggle.tap({ timeout: 4000 }).catch(() => undefined)
      await page.waitForTimeout(600)
      report.drawerAfterTap = await drawer(page)
      await page.screenshot({ path: path.join(OUT, '02-drawer-tap.png') })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(500)
      report.drawerAfterEscape = await drawer(page)
    }

    // Drawer by real touch swipes: several start points (edge / middle, over text / over a code block / empty area).
    const underTouch = (x: number, y: number) =>
      page.evaluate(([px, py]) => {
        const el = document.elementFromPoint(px, py) as HTMLElement | null
        let sideways = false
        for (let n: HTMLElement | null = el; n && n !== document.body; n = n.parentElement) {
          const cs = getComputedStyle(n)
          if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && n.scrollWidth > n.clientWidth + 1) { sideways = true; break }
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
      await swipe(page, [sx, sy], [sx + dx, sy + 4], steps)
      await page.waitForTimeout(700)
      const opened = await drawer(page)
      if (label === 'edge-slow') await page.screenshot({ path: path.join(OUT, '03-swipe-open.png') })
      if (opened) await swipe(page, [Math.max(30, opened.right - 20), 500], [10, 500], 6)
      await page.waitForTimeout(700)
      swipes.push({ label, from: [sx, sy], where, opened, afterClose: await drawer(page) })
    }
    report.swipes = swipes

    // Rapid open/close cycles: does it ever strand?
    for (let i = 0; i < 6; i++) {
      await swipe(page, [40, 300], [280, 304], 6)
      await page.waitForTimeout(120)
      await swipe(page, [240, 500], [10, 500], 4)
      await page.waitForTimeout(60)
    }
    await page.waitForTimeout(800)
    report.afterRapid = await drawer(page)

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
          if (++n < 90) requestAnimationFrame(tick)
          else resolve()
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
      try { process.kill(proc.pid, 'SIGKILL') } catch {}
    }
    await provider.close?.().catch(() => undefined)
  }
})
