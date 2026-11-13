import type { TestProjectConfiguration } from 'vitest/config'
import { defineConfig } from 'vitest/config'

const reactUi: TestProjectConfiguration = {
  extends: './vite.config.ts',
  test: {
    name: 'ui',
    environment: 'jsdom',
    // Keep padding regressions observable instead of mocking the stylesheet away.
    css: { include: [/status-stack\.css$/] },
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    globals: true,
    // React 19.1+ stubs `react`.act to undefined in the production build;
    // @testing-library/react's act() delegates to it and throws
    // "React.act is not a function" when NODE_ENV=production. Force the
    // development build for the test worker so `act` resolves to a real
    // function, regardless of any ambient NODE_ENV (e.g. a shell that
    // inherited NODE_ENV=production from a desktop launch).
    env: { NODE_ENV: 'development' },
    // The first test in each file pays jsdom env init + full module transform,
    // which can exceed vitest's 5000ms default under CI/load. Hooks pay the
    // same cold cost when a beforeEach does `vi.resetModules()` + `await
    // import(...)` (65 files).
    //
    // 45s, not 15s: a full 32-worker run of this project is 1500+ files on one
    // machine, and the first test in a file can wait minutes of CPU behind
    // other workers' module transforms — 15s aborted healthy tests that pass
    // alone in ~1s. The same headroom applies to hooks for the same reason.
    testTimeout: 45_000,
    hookTimeout: 60_000
  }
}

const electronNative: TestProjectConfiguration = {
  test: {
    name: 'electron',
    environment: 'node',
    // `e2e/**/*.unit.test.ts` is the e2e HELPERS, not the specs: plain node
    // modules that should be provable without booting Electron. Playwright
    // ignores the same pattern so they run in exactly one runner.
    include: ['electron/**/*.test.ts', 'scripts/**.test.{ts,mjs}', 'e2e/**/*.unit.test.ts'],
    // Tests here shell out to real interpreters (python3, pwsh) over a 40+
    // case corpus; pwsh alone takes several seconds to start on a loaded CI
    // runner, so vitest's 5s default timed the Windows marker judge out.
    testTimeout: 30_000,
    // Only these contracts need the Hermes test interpreter; resolving it may
    // sync the Python environment, which UI-only runs must not wait for.
    globalSetup: ['./vitest.hermes-python.ts']
  }
}

export default defineConfig({
  test: {
    globalSetup: ['./vitest.run-tmp.ts'],
    projects: [reactUi, electronNative]
  }
})
