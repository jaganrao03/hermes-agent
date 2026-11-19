import { installBrowserDesktopBridge } from './browser-desktop-bridge'
import { installBrowserViewport } from './browser-viewport'
import { registerNotificationWorker } from './service-worker'

if (typeof window !== 'undefined' && installBrowserDesktopBridge()) {
  installBrowserViewport()
  // Browser host only: Electron has no use for a worker, and registration failure is silent.
  void registerNotificationWorker()
}
