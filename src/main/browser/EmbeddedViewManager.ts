import { BrowserWindow, WebContentsView, type Rectangle } from 'electron'
import { fileURLToPath } from 'url'

type EmbeddedViewConfig = {
  id: string
  url: string
  preloadPath?: string
  partition?: string
  userAgent?: string
  backgroundColor?: string
  permissions?: string[]
}

type EmbeddedEventPayload = {
  id: string
  type: string
  data?: any
}

type EmbeddedViewManagerOptions = {
  onEvent?: (payload: EmbeddedEventPayload) => void
}

export class EmbeddedViewManager {
  private window: BrowserWindow
  private views = new Map<string, WebContentsView>()
  private viewPermissions = new Map<string, Set<string>>()
  private viewZIndex = new Map<string, number>()
  private webContentsToId = new Map<number, string>()
  private overlayView: WebContentsView | null = null
  private overlayVisible = false
  private options: EmbeddedViewManagerOptions

  constructor(window: BrowserWindow, options: EmbeddedViewManagerOptions = {}) {
    this.window = window
    this.options = options
  }

  createOrUpdate(config: EmbeddedViewConfig) {
    if (!config?.id) return
    const existing = this.views.get(config.id)
    if (existing) {
      if (config.permissions) {
        this.viewPermissions.set(config.id, new Set(config.permissions))
      }
      if (config.url && existing.webContents.getURL() !== config.url) {
        this.recordAllowedOrigin(config.id, config.url)
        existing.webContents.loadURL(config.url).catch(() => undefined)
      }
      return
    }

    this.recordAllowedOrigin(config.id, config.url)

    const preloadPath =
      config.preloadPath?.startsWith('file://') ? fileURLToPath(config.preloadPath) : config.preloadPath

    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: preloadPath,
        partition: config.partition,
        backgroundThrottling: true
      }
    })

    if (config.userAgent) {
      view.webContents.setUserAgent(config.userAgent)
    }
    if (config.backgroundColor) {
      view.setBackgroundColor?.(config.backgroundColor)
    }

    this.attachEvents(config.id, view)
    this.window.contentView.addChildView(view)
    this.views.set(config.id, view)
    this.webContentsToId.set(view.webContents.id, config.id)
    if (config.permissions) {
      this.viewPermissions.set(config.id, new Set(config.permissions))
    }

    if (config.url) {
      view.webContents.loadURL(config.url).catch(() => undefined)
    }
  }

  setBounds(id: string, bounds: Rectangle) {
    const view = this.views.get(id)
    if (!view) return
    if (view.webContents.isDestroyed()) return
    view.setBounds(bounds)
  }

  setVisible(id: string, visible: boolean) {
    const view = this.views.get(id)
    if (!view) return
    if (visible) {
      if (!this.window.contentView.children.includes(view)) {
        this.window.contentView.addChildView(view)
      }
      return
    }
    if (this.window.contentView.children.includes(view)) {
      this.window.contentView.removeChildView(view)
    }
  }

  /**
   * An embedded view keeps the preload it was given at construction for its
   * whole life, because web preferences are fixed per WebContents. With no
   * navigation control the page could walk itself to any origin and take that
   * preload along -- so a link in hosted content, a vendor redirect or an XSS
   * on a vendor origin handed the channel to arbitrary remote content. The tab
   * manager already does this; this one did not.
   */
  private allowedOrigins = new Map<string, Set<string>>()

  private recordAllowedOrigin(id: string, url?: string) {
    if (!url) return
    try {
      const origin = new URL(url).origin
      const set = this.allowedOrigins.get(id) ?? new Set<string>()
      set.add(origin)
      this.allowedOrigins.set(id, set)
    } catch {
      // an unparseable creating URL grants nothing
    }
  }

  private isAllowedForView(id: string, url: string): boolean {
    if (!url) return false
    if (url === 'about:blank') return true
    const allowed = this.allowedOrigins.get(id)
    if (!allowed || allowed.size === 0) return false
    try {
      return allowed.has(new URL(url).origin)
    } catch {
      return false
    }
  }

  navigate(id: string, url: string) {
    const view = this.views.get(id)
    if (!view) return
    if (!this.isAllowedForView(id, url)) {
      console.warn(`[embedded-view] refused navigation to ${url} for view ${id}`)
      return
    }
    view.webContents.loadURL(url).catch(() => undefined)
  }

  executeJavaScript(id: string, script: string) {
    const view = this.views.get(id)
    if (!view) return
    // `true` here marked every injection as a user gesture, satisfying
    // gesture-gated browser APIs in whatever origin the view holds. Nothing
    // validated the script or the target, and the surface is reachable from
    // the renderer, so a document-content injection became script execution
    // inside a third-party origin. The gesture claim is withdrawn.
    return view.webContents.executeJavaScript(script, false)
  }

  insertCSS(id: string, css: string) {
    const view = this.views.get(id)
    if (!view) return
    return view.webContents.insertCSS(css)
  }

  openDevTools(id: string) {
    const view = this.views.get(id)
    if (!view) return
    view.webContents.openDevTools({ mode: 'detach' })
  }

  focus(id: string) {
    const view = this.views.get(id)
    if (!view) return
    view.webContents.focus()
  }

  destroy(id: string) {
    const view = this.views.get(id)
    if (!view) return
    const wcId = view.webContents.id
    if (!this.window.isDestroyed()) {
      try {
        if (this.window.contentView.children.includes(view)) {
          this.window.contentView.removeChildView(view)
        }
      } catch {
        // ignore
      }
    }
    try {
      if (!view.webContents.isDestroyed()) {
        view.webContents.destroy()
      }
    } catch {
      // ignore
    }
    this.views.delete(id)
    this.viewPermissions.delete(id)
    this.viewZIndex.delete(id)
    this.webContentsToId.delete(wcId)
  }

  getViewIdByWebContentsId(webContentsId: number): string | null {
    return this.webContentsToId.get(webContentsId) || null
  }

  sendToView(id: string, channel: string, payload: any) {
    const view = this.views.get(id)
    if (!view) return
    if (view.webContents.isDestroyed()) return
    view.webContents.send(channel, payload)
  }

  setZIndex(id: string, zIndex: number) {
    if (!this.views.has(id)) return
    this.viewZIndex.set(id, zIndex)
    this.reorderViews()
  }

  setOverlayView(view: WebContentsView | null) {
    this.overlayView = view
    this.reorderViews()
  }

  setOverlayVisibility(visible: boolean) {
    this.overlayVisible = visible
    this.reorderViews()
  }

  private reorderViews() {
    const entries = Array.from(this.views.entries())
      .map(([id, view]) => ({ id, view, z: this.viewZIndex.get(id) ?? 0 }))
      .sort((a, b) => a.z - b.z)

    for (const item of entries) {
      if (this.window.contentView.children.includes(item.view)) {
        this.window.contentView.removeChildView(item.view)
      }
    }
    for (const item of entries) {
      if (this.window.contentView.children.includes(item.view)) continue
      this.window.contentView.addChildView(item.view)
    }
    if (this.overlayView && this.overlayVisible) {
      if (this.window.contentView.children.includes(this.overlayView)) {
        this.window.contentView.removeChildView(this.overlayView)
      }
      this.window.contentView.addChildView(this.overlayView)
    }
  }

  destroyAllViews() {
    if (!this.window || this.window.isDestroyed()) {
      this.views.clear()
      this.viewPermissions.clear()
      this.viewZIndex.clear()
      this.webContentsToId.clear()
      return
    }
    for (const id of Array.from(this.views.keys())) {
      this.destroy(id)
    }
  }

  private attachEvents(id: string, view: WebContentsView) {
    const emit = (type: string, data?: any) => {
      this.options.onEvent?.({ id, type, data })
    }

    view.webContents.on('dom-ready', () => emit('dom-ready'))
    view.webContents.on('did-finish-load', () => emit('did-finish-load'))
    view.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) =>
      emit('did-fail-load', { errorCode, errorDescription, validatedURL })
    )
    view.webContents.on('page-title-updated', (_e, title) => emit('page-title-updated', { title }))
    view.webContents.on('console-message', (_e, level, message, line, sourceId) =>
      emit('console-message', { level, message, line, sourceId })
    )

    const refuseForeign = (event: { preventDefault: () => void }, url: string) => {
      if (!this.isAllowedForView(id, url)) {
        event.preventDefault()
        console.warn(`[embedded-view] blocked navigation to ${url} for view ${id}`)
      }
    }
    view.webContents.on('will-navigate', (event, url) => refuseForeign(event, url))
    view.webContents.on('will-redirect', (event, url) => refuseForeign(event, url))
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    view.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
      if (wc.id !== view.webContents.id) return callback(false)
      const allowed = this.viewPermissions.get(id)
      if (!allowed || allowed.size === 0) return callback(false)
      callback(allowed.has(permission))
    })
  }
}
