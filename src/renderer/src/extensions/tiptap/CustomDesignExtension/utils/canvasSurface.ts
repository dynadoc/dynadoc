/**
 * The CanvasKit surface the Design canvas draws on.
 *
 * `MakeCanvasSurface` is `MakeWebGLCanvasSurface` in this build of CanvasKit,
 * and it throws when the canvas cannot get a WebGL context (GPU disabled or
 * blocklisted, some VMs and remote desktops). That exception used to escape
 * the canvas' onMount, which left an empty canvas and no word about why
 * (#101). WebGL is now tried only where it exists, a CPU raster surface
 * (`MakeSWCanvasSurface`, pixels copied to the canvas with putImageData) takes
 * over where it does not or where it fails, and when neither works the caller
 * gets a reason to show instead of a blank area.
 *
 * Imports only types, so tests/smoke/design-canvas.test.mjs runs it with a
 * stand-in CanvasKit.
 */

import type { CanvasKit, Surface } from 'canvaskit-wasm'

export type CanvasRenderMode = 'webgl' | 'software' | 'none'

export type CanvasSurfaceResult = {
  surface: Surface | null
  /** The canvas the surface draws to: CanvasKit swaps the element in one case. */
  canvas: HTMLCanvasElement
  mode: CanvasRenderMode
  /** Why WebGL, then the software surface, could not be used. */
  error?: string
}

type SurfaceFactory = Pick<CanvasKit, 'MakeWebGLCanvasSurface' | 'MakeSWCanvasSurface'>

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error ?? 'unknown error')

/**
 * Whether WebGL is there at all. Asked on a throwaway canvas: once a canvas
 * has a WebGL context it can no longer give the 2D context the software
 * surface needs.
 */
export function isWebGLAvailable(
  createCanvas: () => { getContext: (id: string) => unknown } = () =>
    document.createElement('canvas')
): boolean {
  try {
    const probe = createCanvas()
    return Boolean(probe.getContext('webgl2') || probe.getContext('webgl'))
  } catch {
    return false
  }
}

export function createCanvasSurface(
  ck: SurfaceFactory,
  canvas: HTMLCanvasElement,
  options: { webgl: boolean }
): CanvasSurfaceResult {
  const reasons: string[] = []

  if (options.webgl) {
    try {
      const parent = canvas.parentNode as ParentNode | null
      const surface = ck.MakeWebGLCanvasSurface(canvas)
      if (surface) {
        // With a context but no GPU surface, CanvasKit replaces the canvas by
        // a clone (class ck-replaced) and returns a software surface on it.
        if (!canvas.isConnected && parent) {
          const replaced = parent.querySelector<HTMLCanvasElement>('canvas.ck-replaced')
          if (replaced) return { surface, canvas: replaced, mode: 'software' }
        }
        return { surface, canvas, mode: 'webgl' }
      }
      reasons.push('WebGL surface could not be created')
    } catch (error) {
      reasons.push(`WebGL: ${describe(error)}`)
    }
  } else {
    reasons.push('WebGL is not available')
  }

  try {
    const surface = ck.MakeSWCanvasSurface(canvas)
    if (surface) return { surface, canvas, mode: 'software', error: reasons.join('; ') }
    reasons.push('software surface could not be created')
  } catch (error) {
    reasons.push(`software: ${describe(error)}`)
  }

  return { surface: null, canvas, mode: 'none', error: reasons.join('; ') }
}
