/** Fast phone-width swipe diagnostic: does the page see the touches, and what does the hook do with them? */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { chromium, expect, type Page, test } from '@playwright/test'

import { composer, createCoreSandbox, freePort, sandboxProcesses, webappLaunchLink, writeProviderHome } from './harness'
import { startScriptedProvider } from './provider'

const OUT = process.env.PHONE_PROBE_OUT || '/tmp/phone-probe'

test('phone swipe diagnostic', async () => {
  test.setTimeout(150_000)
  fs.mkdirSync(OUT, { recursive: true })
  const provider = await startScriptedProvider()
  const sandbox = createCoreSandbox('phoneswipe')
  writeProviderHome(sandbox.hermesHome, provider.url)
  const port = await freePort()
  fs.appendFileSync(path.join(sandbox.hermesHome, 'config.yaml'), `\nwebapp:\n  enabled: true\n  port: ${port}\n`)
  const report: Record<string, unknown> = {}
  const browser = await chromium.launch({ executablePath: process.env.HERMES_E2E_CHROMIUM || undefined, args: ['--no-sandbox'] })

  try {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36'
    })
    const page: Page = await ctx.newPage()
    page.setDefaultTimeout(8000)
    const errs: string[] = []
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 200)))
    page.on('console', m => { if (['error', 'warning'].includes(m.type())) errs.push(m.type() + ': ' + m.text().slice(0, 160)) })
    report.errs = errs
    await page.addInitScript(() => {
      try {
        const say = (m: string) => console.log('NAVDBG ' + m)
        for (const fn of ['back', 'forward', 'go', 'pushState', 'replaceState'] as const) {
          const orig = (history as any)[fn].bind(history)
          ;(history as any)[fn] = (...a: unknown[]) => { say(`history.${fn}(${a.map(String).join(',').slice(0, 40)}) ` + (new Error().stack ?? '').split('\n').slice(2, 5).join(' | ').slice(0, 300)); return orig(...a) }
        }
        ;(window as any).navigation?.addEventListener('navigate', (e: any) => say(`navigate type=${e.navigationType} userInit=${e.userInitiated} to=${String(e.destination?.url).slice(0, 40)} src=${e.sourceElement?.tagName}`))
        window.addEventListener('popstate', () => say('popstate'))
        window.addEventListener('pagehide', () => say('pagehide'))
      } catch (err) { console.log('NAVDBG install failed ' + String(err)) }

      const w = window as unknown as { __rv: string[]; __ev: string[] }
      w.__rv = []
      w.__ev = []
      const origAdd = window.addEventListener.bind(window)
      window.addEventListener = ((type: string, handler: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
        if (/^touch(start|move|end|cancel)$/.test(type) && typeof handler === 'function') {
          const wrapped = function (this: unknown, ev: Event) {
            try {
              const r = (handler as (e: Event) => unknown).call(this, ev)
              w.__ev.push(`      hook ${type} ok`)
              return r
            } catch (err) {
              w.__ev.push(`      hook ${type} THREW ${String(err).slice(0, 120)}`)
              throw err
            }
          }
          return origAdd(type, wrapped as EventListener, opts)
        }
        return origAdd(type, handler as EventListener, opts)
      }) as typeof window.addEventListener
      const t0 = performance.now()
      ;(window as unknown as { __vw: string[] }).__vw = []
      const vw = () => (window as unknown as { __vw: string[] }).__vw.push(`${Math.round(performance.now() - t0)}ms inner=${innerWidth} meta=${document.querySelector('meta[name=viewport]')?.getAttribute('content')}`)
      window.addEventListener('resize', vw)
      document.addEventListener('DOMContentLoaded', () => { vw(); new MutationObserver(vw).observe(document.head, { attributes: true, childList: true, subtree: true }) })
      const stamp = () => String(Math.round(performance.now() - t0)).padStart(5)
      window.addEventListener('hermes:pane-toggle-reveal', e => { const m = (e as CustomEvent).detail.mode as string; w.__rv.push(m); w.__ev.push(`${stamp()} REVEAL ${m}`) }, true)
      for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) {
        window.addEventListener(type, e => {
          const te = e as TouchEvent
          const x = Math.round((te.changedTouches[0] ?? te.touches[0])?.clientX ?? -1)
          w.__ev.push(`${stamp()} ${type} n=${te.touches.length} x=${x} target=${(e.target as Element)?.nodeName} cancelable=${te.cancelable}`)
        }, { capture: true, passive: true })
      }
      document.addEventListener('DOMContentLoaded', () => {
        new MutationObserver(() => w.__ev.push(`${stamp()} DRAG ${document.documentElement.hasAttribute('data-drawer-drag') ? document.documentElement.style.getPropertyValue('--drawer-drag') : 'released'}`))
          .observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-drawer-drag'] })
      })
    })
    if (process.env.INJECT_INIT) await page.addInitScript(process.env.INJECT_INIT)
    await page.goto(webappLaunchLink(sandbox))
    await expect(composer(page)).toBeVisible({ timeout: 120_000 })
    await page.waitForTimeout(800)

    report.media = await page.evaluate(() => ({
      coarse: matchMedia('(pointer: coarse)').matches,
      hoverNone: matchMedia('(hover: none)').matches,
      anyCoarse: matchMedia('(any-pointer: coarse)').matches,
      maxTouchPoints: navigator.maxTouchPoints,
      ontouchstart: 'ontouchstart' in window,
      width: innerWidth
    }))

    // The hook's own guard, replicated verbatim, at the swipe start point: who owns the drag?
    report.guards = await page.evaluate(() => {
      const OWN = "input, textarea, select, pre, [contenteditable='true'], [data-slot='composer-root']"
      const chain: string[] = []
      let owner: string | null = null
      let node: Element | null = document.elementFromPoint(120, 300)
      while (node && node !== document.body) {
        const cs = getComputedStyle(node)
        const sw = node.scrollWidth > node.clientWidth + 4 && (cs.overflowX === 'auto' || cs.overflowX === 'scroll')
        const own = node.matches(OWN)
        chain.push(`${node.tagName.toLowerCase()}[sw=${node.scrollWidth},cw=${node.clientWidth},ox=${cs.overflowX}]${own ? ' OWN' : ''}${sw ? ' SIDEWAYS' : ''}`)
        if ((own || sw) && !owner) owner = chain[chain.length - 1]
        node = node.parentElement
      }
      return { owner, chain }
    })

    const cdp = await ctx.newCDPSession(page)
    const send = (type: string, x?: number, y?: number) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: x!, y: y!, id: 1 }] } as never)
    const state = () => page.evaluate(() => {
      const el = document.querySelector('[data-narrow-overlay]') as HTMLElement | null
      const r = el?.getBoundingClientRect()
      const w = window as unknown as { __rv: string[] }
      const out = {
        drawer: r ? `${Math.round(r.left)}..${Math.round(r.right)}` : 'none',
        drag: document.documentElement.style.getPropertyValue('--drawer-drag') || '-',
        attr: document.documentElement.hasAttribute('data-drawer-drag'),
        reveals: w.__rv.join(',')
      }
      w.__rv.length = 0
      return out
    })
    const trace: string[] = []
    page.on('console', m => { if (m.text().startsWith('NAVDBG')) trace.push(m.text().slice(0, 420)) })
    await page.evaluate(() => console.log('NAVDBG canary'))
    const navCdp = await page.context().newCDPSession(page)
    await navCdp.send('Page.enable')
    for (const ev of ['Page.frameRequestedNavigation', 'Page.frameStartedNavigating', 'Page.frameStartedLoading'] as const) {
      navCdp.on(ev as never, (e: any) => trace.push(`CDP ${ev.slice(5)} ${JSON.stringify(e).slice(0, 260)}`))
    }
    const histBefore = await navCdp.send('Page.getNavigationHistory')
    trace.push('HISTORY before: ' + histBefore.entries.map((e: any) => e.url.slice(0, 40)).join(' , ') + ' cur=' + histBefore.currentIndex)
    page.on('framenavigated', f => { if (f === page.mainFrame()) trace.push(`NAV -> ${f.url().slice(0, 40)}`) })
    const probe = (label: string) =>
      page.evaluate(() => `${location.href.slice(0, 30)} drawerAttr=${document.documentElement.hasAttribute('data-drawer-drag')}`).then(v => trace.push(`${label}: ${v}`)).catch(e => trace.push(`${label}: ERR ${String(e).slice(0, 60)}`))
    const gesture = async (sx: number, sy: number, dx: number, steps: number, gap = 16) => {
      await send('touchStart', sx, sy)
      await probe(`start x=${sx}`)
      for (let i = 1; i <= steps; i++) {
        await send('touchMove', sx + (dx * i) / steps, sy + 2)
        await page.waitForTimeout(gap)
        await probe(`  move ${i}`)
      }
      await send('touchEnd')
      await probe('  end')
    }
    const vvInfo = () => page.evaluate(() => {
      let widest = ''
      let wmax = 0
      for (const el of Array.from(document.querySelectorAll('body *')) as HTMLElement[]) {
        const r = el.getBoundingClientRect()
        if (r.right > wmax) { wmax = r.right; widest = `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 70)} right=${Math.round(r.right)} pos=${getComputedStyle(el).position}` }
      }
      return { inner: innerWidth, vv: window.visualViewport?.width, scale: window.visualViewport?.scale, docScrollW: document.documentElement.scrollWidth, bodyScrollW: document.body.scrollWidth, widest }
    })
    report.vvBefore = await vvInfo()
    if (process.env.INJECT_CSS) await page.addStyleTag({ content: process.env.INJECT_CSS })
    const attempts: unknown[] = []
    // The probe's order: toggle tap -> Escape, THEN swipes.
    const toggle = process.env.SWIPE_ONLY ? page.locator('#nope') : page.locator('[aria-label*="sidebar" i], [aria-label*="sessions" i]').first()
    if (!process.env.SWIPE_ONLY) {
    const chainAt = (x: number, y: number) =>
      page.evaluate(([px, py]) => {
        const out: string[] = []
        let el = document.elementFromPoint(px, py) as HTMLElement | null
        while (el) {
          const cs = getComputedStyle(el)
          const scrollable = /(auto|scroll|hidden|clip)/.test(cs.overflowX + cs.overflowY)
          if (scrollable || el === document.documentElement || el === document.body || cs.overscrollBehaviorX !== 'auto')
            out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className).split(' ').slice(0, 3).join('.').slice(0, 40)} ov=${cs.overflowX}/${cs.overflowY} osb=${cs.overscrollBehaviorX} sw=${el.scrollWidth}/${el.clientWidth} pos=${cs.position} ta=${cs.touchAction}`)
          el = el.parentElement
        }
        return out
      }, [x, y])
    report.chainBefore = await chainAt(40, 300)
    const tb = await toggle.boundingBox()
    if (process.env.TAP_MODE === 'cdp' && tb) {
      await send('touchStart', tb.x + tb.width / 2, tb.y + tb.height / 2)
      await page.waitForTimeout(50)
      await send('touchEnd')
    } else {
      await toggle.tap({ timeout: 4000 }).catch(() => undefined)
    }
    await page.waitForTimeout(600)
    attempts.push({ step: 'after toggle tap', ...(await state()) })
    const post = process.env.POST ?? 'escape'
    if (post === 'backdrop') {
      await send('touchStart', 350, 420)
      await page.waitForTimeout(60)
      await send('touchEnd')
    } else if (post === 'toggle2') {
      await toggle.tap({ timeout: 4000 }).catch(() => undefined)
    } else {
      await page.keyboard.press('Escape')
      if (post === 'blur') await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      if (post === 'tapbody') {
        await send('touchStart', 200, 150)
        await page.waitForTimeout(60)
        await send('touchEnd')
      }
      if (post === 'wait3s') await page.waitForTimeout(3000)
    }
    await page.waitForTimeout(500)
    attempts.push({ step: 'after Escape', url: page.url().slice(0, 50), inner: await page.evaluate(() => innerWidth + 'x' + innerHeight + ' scale=' + window.visualViewport?.scale + ' hist=' + history.length), ...(await state()) })
    report.chainAfter = await chainAt(40, 300)
    report.afterEscapeEnv = await page.evaluate(() => ({
      ovX: getComputedStyle(document.documentElement).overscrollBehaviorX + '/' + getComputedStyle(document.body).overscrollBehaviorX,
      scrollingEl: document.scrollingElement?.tagName, scrollY: document.scrollingElement?.scrollTop, docH: document.documentElement.scrollHeight,
      touchAction: getComputedStyle(document.documentElement).touchAction + '/' + getComputedStyle(document.body).touchAction,
      inner: innerWidth, vvScale: window.visualViewport?.scale, vvW: window.visualViewport?.width,
      narrowMq: matchMedia('(max-width: 1023.98px)').matches,
      allMq: Object.fromEntries([500, 639.98, 767.98, 899.98, 1023.98, 1279.98].map(w => [w, matchMedia(`(max-width: ${w}px)`).matches])),
      coarse: matchMedia('(pointer: coarse)').matches,
      active: document.activeElement ? document.activeElement.tagName + '.' + String(document.activeElement.className).slice(0, 40) : null,
      htmlAttrs: Array.from(document.documentElement.attributes).map(a => a.name + '=' + a.value.slice(0, 40)),
      bodyStyle: document.body.getAttribute('style'),
      htmlStyle: document.documentElement.getAttribute('style')
    }))
    }
    for (const sx of (process.env.START_XS ?? '40,120,250').split(',').map(Number)) {
      report[`inner-before-${sx}`] = await page.evaluate(() => innerWidth)
      await page.evaluate(() => ((window as unknown as { __ev: string[] }).__ev.length = 0))
      await gesture(sx, 300, 230, 10)
      await page.waitForTimeout(700)
      report[`vv-after-${sx}`] = await vvInfo()
      report[`url-after-${sx}`] = page.url().slice(0, 60)
      const st = await state()
      const ev = await page.evaluate(() => (window as unknown as { __ev: string[] }).__ev)
      attempts.push({ startX: sx, url: page.url().slice(0, 50), inner: await page.evaluate(() => innerWidth + 'x' + innerHeight + ' scale=' + window.visualViewport?.scale + ' hist=' + history.length), ...st, eventCount: ev.length, events: ev.slice(0, 30) })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(500)
      await state()
    }
    // Does a synthetic gesture still work AFTER real ones were swallowed?  And what do DRAG lines look like?
    await page.evaluate(() => ((window as unknown as { __ev: string[] }).__ev.length = 0))
    await page.evaluate(async () => {
      const mk = (type: string, x: number, y: number) => {
        const t = new Touch({ identifier: 1, target: document.body, clientX: x, clientY: y })
        return new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t], changedTouches: [t] })
      }
      document.body.dispatchEvent(mk('touchstart', 120, 300))
      for (let i = 1; i <= 8; i++) { document.body.dispatchEvent(mk('touchmove', 120 + i * 30, 303)); await new Promise(r => setTimeout(r, 16)) }
      document.body.dispatchEvent(mk('touchend', 360, 303))
    })
    await page.waitForTimeout(600)
    report.syntheticAfterCdp = { ...(await state()), events: (await page.evaluate(() => (window as unknown as { __ev: string[] }).__ev)).filter(e => !/hook|touchmove/.test(e)).slice(0, 20) }
    report.vwLog = await page.evaluate(() => (window as unknown as { __vw: string[] }).__vw)
    report.mql = await page.evaluate(() => ({ narrow: matchMedia('(max-width: 767px)').matches, w: innerWidth, vv: window.visualViewport?.width, outer: outerWidth }))
    if (process.env.CYCLE) {
      const tap = async (x: number, y: number) => { await send('touchStart', x, y); await page.waitForTimeout(60); await send('touchEnd') }
      for (let i = 1; i <= 4; i++) {
        await gesture(6, 300, 230, 10)
        await page.waitForTimeout(500)
        attempts.push({ step: `cycle ${i} open (swipe)`, ...(await state()) })
        if (i % 2) await gesture(240, 300, -220, 10) // close by dragging back
        else await tap(350, 420) // close by tapping the backdrop
        await page.waitForTimeout(700)
        attempts.push({ step: `cycle ${i} close (${i % 2 ? 'drag' : 'backdrop tap'})`, ...(await state()) })
      }
    }
    report.trace = trace
    report.attempts = attempts
    // Regression: a rightward drag on the transcript, from clear of the OS edge zone (x>=40), must
    // open the drawer and must not be taken as Chrome's history swipe (see styles.css touch-action).
    if (!process.env.INJECT_CSS && !process.env.INJECT_INIT && !process.env.POST) {
      expect(trace.filter(t => t.startsWith('NAV -> about:blank')), 'history swipe took the page back to about:blank').toEqual([])
      for (const a of attempts.filter(x => typeof x.startX === 'number' && x.startX >= 40)) {
        expect(a.reveals, `swipe from x=${a.startX} did not reveal the drawer`).toContain('open')
      }
    }
  } finally {
    fs.writeFileSync(path.join(OUT, 'swipe.json'), JSON.stringify(report, null, 2))
    await browser.close().catch(() => undefined)
    for (const proc of sandboxProcesses(sandbox)) {
      try { process.kill(proc.pid, 'SIGKILL') } catch {}
    }
  }
})
