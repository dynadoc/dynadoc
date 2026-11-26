<script lang="ts">
  // import { nodeApi } from '../../../../../utils/shims/node'
  import { _ } from 'svelte-i18n'
  import { onMount, onDestroy } from 'svelte'
  import CanvasKitInit, { type CanvasKit } from 'canvaskit-wasm'
  // The wasm must come from the same canvaskit-wasm install as the JS glue
  // above: the glue's import table changes between releases, and a mismatched
  // binary aborts with a LinkError at instantiate (issue #66). Importing it
  // with ?url lets Vite serve and emit the package's own copy on every target.
  import canvasKitWasmUrl from 'canvaskit-wasm/bin/canvaskit.wasm?url'

  import * as Y from 'yjs'
  import ImageEditorUI from '../DesignStudioUI.svelte'
  import SkiaTextShape from './SkiaTextShape.svelte'
  import { _$_wysiwygEditorsList } from '../../../../../stores/editor.store'
  import { CustomDesignExtension } from '../../CustomDesignExtension'
  import { CustomDesignExtensionProps } from '../../utils/common.utils'
  import { ShapeType, type Shape } from '../../../../../utils/canvas.utils'
  import { _$_canvasCommands } from '../../../../../stores/canvas.store'
  import {
    ImageEditingToolCursorMap,
    ImageEditingTools,
    ImageEditingToolsDrawingShape,
    isImageEditingDrawingTool
  } from '../../utils/utils'
  import type { CanvasCommands } from '../../../../../commands/canvasCommands'
  import { parseColor } from '../../utils/design.utils'
  import {
    createCanvasSurface,
    isWebGLAvailable,
    type CanvasRenderMode
  } from '../../utils/canvasSurface'
  /* let {
    __canvaPath,
    __shapes,
    __texts,
    __awareness,
    __provider,
    __onSelect,
    __onCreate,
    __canvaHeight = null,
    __canvaWidth = null,
    __maxPageHeight = null,
    __maxPageWidth = null,
    __wysiwygEditorIdToUpdate = null
  }: {
    __canvaPath: any
    __shapes: Y.Map<any>
    __texts: Y.Map<any>
    __awareness: any
    __provider: any
    __onSelect: any
    __onCreate: any
    __canvaHeight?: number
    __canvaWidth?: number
    __maxPageHeight?: number
    __maxPageWidth?: number
    __wysiwygEditorIdToUpdate?: string
  } = $props() */

  //  export let __canvaId
  //   export let __onSelect
  //   export let __canvaWidth = 800
  //   export let __canvaHeight = 450

  interface Props {
    __canvaCommands: CanvasCommands
    __canvaId: string
    __canvaPath: string
    __shapes: Y.Map<any>
    __texts: Y.Map<any>

    __awareness: any
    __provider: any

    __onSelect?: (id: string, evt?: MouseEvent) => void
    __onCreate?: (w: number, h: number) => void

    __canvaHeight?: number | null
    __canvaWidth?: number | null
    __maxPageHeight?: number | null
    __maxPageWidth?: number | null
    __wysiwygEditorIdToUpdate?: string | null
  }

  const {
    __canvaCommands = $bindable(),
    __canvaId,
    __canvaPath,
    __shapes,
    __texts,

    __awareness,
    __provider,

    __onSelect,
    __onCreate,

    __canvaHeight = null,
    __canvaWidth = null,
    __maxPageHeight = null,
    __maxPageWidth = null,
    __wysiwygEditorIdToUpdate = null
  }: Props = $props()

  // let __canvaCommands = _$_canvasCommands.get(__canvaId)

  let activeShapeId: string | null = $state(null)

  // Controls
  let blur = $state(0)
  let opacity = $state(1)
  let blend = $state('SrcOver')

  // Drag state
  let dragging = $state(false)
  let dragShapeId: string | null = $state(null)
  let dragOffset = $state({ x: 0, y: 0 })
  let dragAnimationFrame: number | null = null
  let dragStart = $state({ x: 0, y: 0 })
  let dragStartPositions = new Map<string, { x: number; y: number }>()

  // Device pixel ratio
  const DPR = window.devicePixelRatio || 1

  let _canvasEl: HTMLCanvasElement
  // How the canvas renders: WebGL, CanvasKit's software surface, or not at all
  // (then the canvas shows why instead of staying blank).
  let _renderMode = $state<CanvasRenderMode | 'pending'>('pending')
  let _renderError = $state('')
  let _CanvasKit: CanvasKit
  let _surface: any
  let _canvas: any

  let _shapeList: Shape[] = $state([])
  let _syncTick = $state(0)

  let _isDrawing = false

  let _currentTool = $state<ImageEditingTools | null>(null)
  let _shapeToDraw = $derived(ImageEditingToolsDrawingShape[_currentTool])
  let _drawingCursor = $derived(ImageEditingToolCursorMap[_currentTool] || 'default')

  let _drawingInteraction = $derived(
    _shapeToDraw && __canvaCommands ? __canvaCommands.drawShape(_shapeToDraw) : null
  )

  let unsubscribeTool: (() => void) | null = null

  $effect(() => {
    if (!__canvaCommands?.selectedToolStore) return
    unsubscribeTool?.()
    if (__canvaCommands.getSelectedTool() == null) {
      __canvaCommands.setSelectedTool(ImageEditingTools.Move)
    }
    unsubscribeTool = __canvaCommands.selectedToolStore.subscribe((tool) => {
      _currentTool = tool
      updateCursor()
    })
    return () => {
      unsubscribeTool?.()
      unsubscribeTool = null
    }
  })

  /* $effect(() => {
        console.log('effecteffect()',{_shapeToDraw,_drawingInteraction}, __canvaCommands.getSelectedTool())

    if (_shapeToDraw) {
      _drawingInteraction = __canvaCommands.drawShape(_shapeToDraw)
      // _drawingCursor = __canvaCommands.getSelectedToolCursor()
    }
  }) */

  function getCanvasPos(e: MouseEvent, canvasElement: HTMLCanvasElement) {
    const rect = canvasElement.getBoundingClientRect()

    // Calculate how many CSS pixels are represented by one pixel on the screen
    const scaleX = canvasElement.width / (rect.width * DPR)
    const scaleY = canvasElement.height / (rect.height * DPR)

    return {
      // Return values in logical coordinates that match your Yjs Shape data
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    }
  }

  /* 
  function handleMouseDown(e) {
    if (__canvaCommands.getSelectedTool() !== ImageEditingTools.Rectangle) return
    isDrawing = true
    // const pos = e.target.getStage().getPointerPosition() // For Konva

    drawingInteraction.onStart(pos.x, pos.y)
  }

  function handleMouseMove(e) {
    if (!isDrawing) return
    const pos = e.target.getStage().getPointerPosition()
    drawingInteraction.onMove(pos.x, pos.y)
  } */
  function handleMouseDown(e: MouseEvent | PointerEvent) {
    console.log('__canvaCommandsgetSelectedTool()', __canvaCommands.getSelectedTool())
    // if (__canvaCommands.getSelectedTool() !== ImageEditingTools.Rectangle) return

    const tool = __canvaCommands.getSelectedTool()
    if (!isImageEditingDrawingTool(tool)) return

    _isDrawing = true
    const pos = getCanvasPos(e, _canvasEl)
    _drawingInteraction.onStart(pos.x, pos.y)
    // drawingInteraction.onStart(30, 30)
  }

  function handleMouseMove(e: MouseEvent | PointerEvent) {
    if (!_isDrawing) return

    const pos = getCanvasPos(e, _canvasEl)
    // drawingInteraction.onMove(0, 0)
    // drawingInteraction.onMove(190, 190)
    _drawingInteraction.onMove(pos.x, pos.y)
    return
  }

  function handleMouseUp() {
    if (!_isDrawing) return
    _isDrawing = false
    _drawingInteraction.onEnd()
    return
  }

  function sync() {
    console.log('syncPosition sync1', { _syncTick })

    _shapeList = Array.from(__shapes.entries()).map(([id, data]) => ({
      // id,
      ...data,
      id // put id LAST so it always wins
    }))
    console.log('syncPosition Syncing shapes _shapeList...', {
      shapeList: _shapeList.length,
      __shapes
    })

    _syncTick++ // SIGNAL CHILDREN to sync shapee positions
    draw()
  }

  /* async function render() {
    if (!_canvas) return
    _canvas.clear(_CanvasKit.TRANSPARENT)
    const layers = _shapeList
    draw()

    for (const shape of layers) {
      await drawShape(shape, _canvas, _CanvasKit)
      // Draw active shape border
      if (shape.id === activeShapeId) {
        const border = new _CanvasKit.Paint()
        border.setStyle(_CanvasKit.PaintStyle.Stroke)
        border.setStrokeWidth(2)
        border.setColor(_CanvasKit.Color(0, 120, 215, 1))
        _canvas.drawRect(
          _CanvasKit.LTRBRect(shape.x, shape.y, shape.x + shape.width, shape.y + shape.height),
          border
        )
        border.delete()
      }
    }
    _surface.flush()
  } */

  function draw() {
    if (!_canvas) return
    _canvas.clear(_CanvasKit.TRANSPARENT)

    // _canvas.clear(_CanvasKit.Color(255, 255, 255, 1))

    _shapeList.sort((a, b) => (a.z ?? 0) - (b.z ?? 0)).forEach(drawShape)

    _surface.flush()
  }

  function drawShape2(shape: Shape) {
    const paint = new _CanvasKit.Paint()
    paint.setColor(_CanvasKit.Color(0, 0, 0, 1))

    // measure width/height in CSS pixels (divide by DPR)
    const width = Math.round(shape.w * DPR)
    const height = Math.round(shape.h * DPR)

    if (shape.type === 'rect') {
      _canvas.drawRect(_CanvasKit.XYWHRect(shape.x, shape.y, shape.w, shape.h), paint)
    }

    if (shape.type === 'text') {
      // draw placeholder (actual editing via DOM overlay)
      paint.setStyle(_CanvasKit.PaintStyle.Stroke)
      _canvas.drawRect(_CanvasKit.XYWHRect(shape.x, shape.y, width, height), paint)
      // _canvas.drawRect(_CanvasKit.XYWHRect(shape.x, shape.y, shape.w, shape.h), paint)
    }

    console.log('drawShape activeShapeId', { id: shape.id, activeShapeId })
    // Draw active shape border
    if (shape.id === activeShapeId) {
      console.log('drawShape activeShapeId en', { id: shape.id, shape, activeShapeId })
      const border = new _CanvasKit.Paint()
      border.setStyle(_CanvasKit.PaintStyle.Stroke)
      border.setStrokeWidth(2)
      border.setColor(_CanvasKit.Color(0, 120, 215, 1))
      _canvas.drawRect(
        _CanvasKit.LTRBRect(shape.x, shape.y, shape.x + shape.width, shape.y + shape.height),
        border
      )
      border.delete()
    }
  }

  function drawShape11(shape: Shape) {
    if (!shape.visible) return // draw only visible shapes

    const paint = new _CanvasKit.Paint()
    paint.setColor(_CanvasKit.Color(110, 110, 110, 1))
    // paint.setColor(_CanvasKit.Color(0, 0, 0, 1))

    // Convert to device pixels
    const x = shape.x * DPR
    const y = shape.y * DPR
    const w = shape.w * DPR
    const h = shape.h * DPR

    if (shape.type === 'rect') {
      _canvas.drawRect(_CanvasKit.XYWHRect(x, y, w, h), paint)
    }

    if (shape.type === 'text') {
      paint.setStyle(_CanvasKit.PaintStyle.Stroke)
      _canvas.drawRect(_CanvasKit.XYWHRect(x, y, w, h), paint)
    }

    // ✅ Active border
    if (shape.id === activeShapeId) {
      const border = new _CanvasKit.Paint()
      border.setStyle(_CanvasKit.PaintStyle.Stroke)
      border.setStrokeWidth(2 * DPR) // IMPORTANT
      border.setColor(_CanvasKit.Color(0, 120, 215, 1))

      _canvas.drawRect(_CanvasKit.XYWHRect(x, y, w, h), border)

      border.delete()
    }

    paint.delete()
  }

  function drawShape(shape: Shape) {
    if (!shape.visible) return

    const x = shape.x * DPR
    const y = shape.y * DPR
    const w = shape.w * DPR
    const h = shape.h * DPR
    const rect = _CanvasKit.XYWHRect(x, y, w, h)

    // --- 1. SET UP FILL PAINT ---
    // If no fill is provided, we default to a "transparent" look or "no fill"
    if (shape.fill) {
      const fillPaint = new _CanvasKit.Paint()
      fillPaint.setAntiAlias(true)
      fillPaint.setStyle(_CanvasKit.PaintStyle.Fill)
      fillPaint.setColor(parseColor(_CanvasKit, shape.fill, shape.opacity ?? 1))

      renderPrimitive(shape, rect, fillPaint)
      fillPaint.delete()
    }

    // --- 2. SET UP STROKE PAINT (Photoshop Path Look) ---
    // If it's a new shape or has a stroke defined, draw the outline
    const strokePaint = new _CanvasKit.Paint()
    strokePaint.setAntiAlias(true)
    strokePaint.setStyle(_CanvasKit.PaintStyle.Stroke)

    // Photoshop-style "Path" outline: 1px neutral if no stroke defined
    const strokeWidth = (shape.strokeWidth ?? 1) * DPR
    const strokeColor = shape.stroke
      ? parseColor(_CanvasKit, shape.stroke)
      : _CanvasKit.Color4f(0.6, 0.6, 0.6, 0.8)

    strokePaint.setStrokeWidth(strokeWidth)
    strokePaint.setColor(strokeColor)

    renderPrimitive(shape, rect, strokePaint)
    strokePaint.delete()

    // --- 3. ACTIVE SELECTION BORDER (The Blue Box) ---
    /* if (shape.id === activeShapeId) {
    const activePaint = new _CanvasKit.Paint();
    activePaint.setStyle(_CanvasKit.PaintStyle.Stroke);
    activePaint.setStrokeWidth(1.5 * DPR);
    activePaint.setColor(_CanvasKit.Color(0, 0.47, 0.84, 1)); // Adobe Blue
    _canvas.drawRect(rect, activePaint);
    activePaint.delete();
  } */

    // The selection lives in the shared shape map (a shape drawn or picked from
    // the Layers panel is selected there), not only in the local drag state.
    if (shape.selected || shape.id === activeShapeId) {
      const x = shape.x * DPR
      const y = shape.y * DPR
      const w = shape.w * DPR
      const h = shape.h * DPR

      // 1. Draw the "Bounding Box" path (Adobe Blue)
      const boxPaint = new _CanvasKit.Paint()
      boxPaint.setStyle(_CanvasKit.PaintStyle.Stroke)
      boxPaint.setStrokeWidth(1 * DPR)
      boxPaint.setColor(_CanvasKit.Color4f(0, 0.47, 0.84, 1))
      _canvas.drawRect(_CanvasKit.XYWHRect(x, y, w, h), boxPaint)
      boxPaint.delete()

      // 2. Draw the 8 Handles
      const handleSize = 6 * DPR
      const half = handleSize / 2

      const handlePaint = new _CanvasKit.Paint()
      handlePaint.setStyle(_CanvasKit.PaintStyle.Fill)
      handlePaint.setColor(_CanvasKit.Color4f(1, 1, 1, 1)) // White fill

      const handleStroke = new _CanvasKit.Paint()
      handleStroke.setStyle(_CanvasKit.PaintStyle.Stroke)
      handleStroke.setStrokeWidth(1 * DPR)
      handleStroke.setColor(_CanvasKit.Color4f(0, 0.47, 0.84, 1)) // Blue border

      // Define positions: [x, y] for each handle
      const positions = [
        [x, y],
        [x + w / 2, y],
        [x + w, y], // Top row
        [x, y + h / 2],
        [x + w, y + h / 2], // Middle row
        [x, y + h],
        [x + w / 2, y + h],
        [x + w, y + h] // Bottom row
      ]

      positions.forEach(([px, py]) => {
        const rect = _CanvasKit.XYWHRect(px - half, py - half, handleSize, handleSize)
        _canvas.drawRect(rect, handlePaint)
        _canvas.drawRect(rect, handleStroke)
      })

      handlePaint.delete()
      handleStroke.delete()
    }
  }

  /**
   * Helper to draw the actual geometry based on type
   */
  function renderPrimitive(shape: Shape, rect: Float32Array, paint: any) {
    switch (shape.type) {
      case ShapeType.Rect:
        if (shape.cornerRadius) {
          const r = shape.cornerRadius * DPR
          const rrect = _CanvasKit.RRectXY(rect, r, r)
          _canvas.drawRRect(rrect, paint)
        } else {
          _canvas.drawRect(rect, paint)
        }
        break

      case ShapeType.Ellipse:
      case ShapeType.Circle:
        _canvas.drawOval(rect, paint)
        break

      case ShapeType.Triangle: {
        // Paths are immutable in this CanvasKit (Path has no moveTo, the
        // draw threw); they are built with PathBuilder. `rect` is LTRB.
        const [left, top, right, bottom] = rect
        const builder = new _CanvasKit.PathBuilder()
        builder.addPolygon([(left + right) / 2, top, right, bottom, left, bottom], true)
        const path = builder.detachAndDelete()
        _canvas.drawPath(path, paint)
        path.delete()
        break
      }

      case ShapeType.Text:
        // Text logic usually handled by Tiptap overlay,
        // but we draw a dashed boundary for the "layer"

        // paint.setDashPathEffect([4 * DPR, 4 * DPR])
        // _canvas.drawRect(rect, paint)

        paint.setStyle(_CanvasKit.PaintStyle.Stroke)
        _canvas.drawRect(_CanvasKit.XYWHRect(shape.x, shape.y, 300, 300), paint)
        break
    }
  }

  function hitTest(x: number, y: number) {
    const ordered = [..._shapeList]
      .filter((s) => s.visible !== false)
      .sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
    return ordered.reverse().find((s) => {
      const width = Math.max(0, s.w ?? 0)
      const height = Math.max(0, s.h ?? 0)
      return x >= s.x && x <= s.x + width && y >= s.y && y <= s.y + height
    })
  }

  function canvasPointFromEvent(ev: PointerEvent | MouseEvent) {
    // function canvasPointFromEvent(ev: PointerEvent) {
    const rect = _canvasEl.getBoundingClientRect()
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top }
  }

  function onPointerDown2(e: PointerEvent) {
    //  _canvasEl.focus()
    const rect = _canvasEl.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    const hit = hitTest(x, y)
    __onSelect?.(hit?.id)
  }

  function getShapeOrActiveShape(id?: string) {
    const layers = _shapeList
    return layers.find((l) => l.id === (id ?? activeShapeId)) || null
  }

  function setActiveShape(id: string) {
    activeShapeId = id
    const shape = getShapeOrActiveShape(id)
    if (!shape) return

    blur = shape.blur
    opacity = shape.opacity
    blend = shape.blend

    // If it’s a shape shape, update Pickr colors
    // if (shape.type === 'shape') {
    //   if (fillColorPickr) fillColorPickr.setColor(shape.fillColor || '#ff0000')
    //   if (strokeColorPickr) strokeColorPickr.setColor(shape.strokeColor || '#000000')
    // }

    console.log('setActiveShape , ', id, shape, activeShapeId)
    // render()
  }

  /* function toggleVisibility(id: string) {
    const shape = getShapeOrActiveShape(id)
    if (shape) {
      updateShape(shape.id, { visible: !shape.visible })
      render()
    }
  }


  function updateShapeProps() {
    const shape = getShapeOrActiveShape()
    if (shape) {
      updateShape(shape.id, { blur, opacity, blend })
      // shape.blur = blur
      // shape.opacity = opacity
      // shape.blend = blend
      render()
    }
  } */

  function setupCanvasSize(cssWidth: number, cssHeight: number, element?: HTMLCanvasElement) {
    const pxW = cssWidth + 'px'
    const pxH = cssHeight + 'px'
    const w = Math.round(cssWidth * DPR)
    const h = Math.round(cssHeight * DPR)

    // always update the main canvas
    Object.assign(_canvasEl.style, { width: pxW, height: pxH })
    Object.assign(_canvasEl, { width: w, height: h })

    // mirror into element if provided
    if (element) {
      Object.assign(element.style, { width: pxW, height: pxH })
      Object.assign(element, { width: w, height: h })
    }
  }

  function getOrCreateTextFragment(texts: Y.Map<any>, id: string): Y.XmlFragment {
    let frag = texts.get(id)
    // return frag

    if (!frag || !(frag instanceof Y.XmlFragment)) {
      frag = new Y.XmlFragment()
      texts.set(id, frag)
    }

    return frag
  }

  function onPointerDownLastWorking(e: PointerEvent) {
    const rect = _canvasEl.getBoundingClientRect()
    // const pt = canvasPointFromEvent(e)
    const pos = getCanvasPos(e, _canvasEl)

    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    handleMouseDown(e)

    const hit = hitTest(pos.x * DPR, pos.y * DPR) // Hit test needs physical px
    __onSelect?.(hit?.id)

    if (hit) {
      dragShapeId = hit.id
      dragging = true
      dragOffset.x = pos.x - hit.x
      dragOffset.y = pos.y - hit.y
      setActiveShape(hit.id)
      _canvasEl.setPointerCapture(e.pointerId)
    } else {
      activeShapeId = null
    }

    /*  const hit = hitTest(x, y)
    __onSelect?.(hit?.id)
    if (hit) {
      dragShapeId = hit.id
      dragging = true
      dragOffset.x = pt.x - hit.x
      dragOffset.y = pt.y - hit.y
      setActiveShape(hit.id)
      console.log('onPointer onPointerDown , ', { pt, hit, activeShapeId })
      _canvasEl.style.cursor = 'grabbing'
      try {
        ;(e.target as Element).setPointerCapture?.(e.pointerId)
      } catch {}
    } else {
      activeShapeId = null
      // render()
    } */
  }

  function onPointerMoveLastWorking(ev: PointerEvent) {
    /* if (!dragging || !dragShapeId) return
    const pt = canvasPointFromEvent(ev)
    const shape = getShapeOrActiveShape(dragShapeId)
    if (!shape) return
    shape.x = pt.x - dragOffset.x
    shape.y = pt.y - dragOffset.y
    render() */
    handleMouseMove(ev)

    if (!dragging || !dragShapeId) return

    // const pt = canvasPointFromEvent(ev)
    const pt = getCanvasPos(ev, _canvasEl)

    const localShape = getShapeOrActiveShape(dragShapeId)
    console.log('onPointer onPointerMove , ', pt, dragShapeId, localShape, activeShapeId)

    // if (!localShape) return
    // sync()
    // localShape.x = pt.x - dragOffset.x
    // localShape.y = pt.y - dragOffset.y
    // draw() // redraw Skia immediately

    // _$_canvasCommands.get(__canvaId).updateShape(localShape.id, {
    __canvaCommands.updateShape(localShape.id, {
      // ...localShape
      x: pt.x,
      y: pt.y
      // x: pt.x - dragOffset.x,
      // y: pt.y - dragOffset.y
    })

    // updateShape(localShape.id, { x: pt.x - dragOffset.x, y: pt.y - dragOffset.y })

    // --- Update local cache immediately ---
    // localShape.x = pt.x - dragOffset.x
    // localShape.y = pt.y - dragOffset.y
    // render()

    // --- Throttle Yjs updates ---
    /* if (dragAnimationFrame) cancelAnimationFrame(dragAnimationFrame)
    dragAnimationFrame = requestAnimationFrame(() => {
      moveShapeInYjs(dragShapeId!, pt.x - dragOffset.x, pt.y - dragOffset.y)
      // moveShapeInYjs(dragShapeId!, localShape.x, localShape.y)
    }) */
  }

  function onPointerUpLastWorking(ev: PointerEvent) {
    console.log('onPointer onPointerUp , ', ev, dragShapeId, dragging, activeShapeId)

    handleMouseUp()

    if (!dragging) return
    dragging = false
    dragShapeId = null
    _canvasEl.style.cursor = 'default'
    // render()

    if (dragAnimationFrame) {
      cancelAnimationFrame(dragAnimationFrame)
      dragAnimationFrame = null
    }
  }

  function onPointerEnter() {
    _canvasEl.style.cursor = _drawingCursor
  }

  function updateCursor() {
    if (!_canvasEl) return
    _canvasEl.style.cursor = _drawingCursor || 'default'
  }

  function onPointerUp() {
    if (_isDrawing) {
      _isDrawing = false
      _drawingInteraction.onEnd()
    }
    dragging = false
    dragShapeId = null
    _canvasEl.style.cursor = 'default'
  }

  function onPointerDown(e: PointerEvent) {
    _canvasEl?.focus()
    // console.log('onPointer onPointerDown , ', { e, dragShapeId, dragging, activeShapeId })

    const pos = getCanvasPos(e, _canvasEl)

    // A secondary button only picks what the context menu acts on: it never
    // draws, types or starts a drag. An object already in the selection keeps
    // the whole selection.
    if (e.button !== 0) {
      const hit = hitTest(pos.x, pos.y)
      if (!hit || !__canvaCommands.getSelectedIds().includes(hit.id)) __onSelect?.(hit?.id)
      return
    }

    // 1. PRIORITIZE TOOL: If drawing a rectangle, don't try to drag
    const tool = __canvaCommands.getSelectedTool()
    if (tool === ImageEditingTools.Type) {
      __canvaCommands.addText({
        x: pos.x,
        y: pos.y,
        w: 260,
        h: 80
      })
      __canvaCommands.setSelectedTool(ImageEditingTools.Move)
      updateCursor()
      return
    }
    if (isImageEditingDrawingTool(tool)) {
      // if (__canvaCommands.getSelectedTool() === ImageEditingTools.Rectangle) {
      _isDrawing = true
      _drawingInteraction?.onStart(pos.x, pos.y)
      return // Stop here!
    }

    // 2. SELECTION/DRAG LOGIC
    // Hit test uses physical pixels (DPR), but shape properties are logical
    // console.log(
    //   'onPointer onPointerDown , ',
    //   { e, dragShapeId, dragging, __canvaCommands },
    //   __canvaCommands.getSelectedIds(),
    //   __canvaCommands.getSelectedIds()[0]
    // )

    // Automatic selection
    const hit = hitTest(pos.x, pos.y)
    __onSelect?.(hit?.id, e)

    if (hit) {
      dragShapeId = hit.id
      dragging = true

      dragStart = { x: pos.x, y: pos.y }
      dragStartPositions = new Map()
      const ids = __canvaCommands.getSelectedIds()
      const selectedIds = ids.length ? ids : [hit.id]
      selectedIds.forEach((id) => {
        const shape = _shapeList.find((s) => s.id === id)
        if (shape) dragStartPositions.set(id, { x: shape.x, y: shape.y })
      })

      setActiveShape(hit.id)
      _canvasEl.setPointerCapture(e.pointerId)
      _canvasEl.style.cursor = 'grabbing'
      _canvasEl.style.cursor = 'grabbing'
    } else {
      activeShapeId = null
    }
  }

  function onPointerMove(e: PointerEvent) {
    const pos = getCanvasPos(e, _canvasEl)

    // 1. Handle Rectangle Drawing
    if (_isDrawing) {
      _drawingInteraction.onMove(pos.x, pos.y)
      return
    }

    // 2. Handle Dragging
    if (dragging && dragShapeId) {
      const dx = pos.x - dragStart.x
      const dy = pos.y - dragStart.y
      dragStartPositions.forEach((origin, id) => {
        __canvaCommands.updateShape(id, {
          x: origin.x + dx,
          y: origin.y + dy
        })
      })
    }
    updateCursor()
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!__canvaCommands) return
    const selected = __canvaCommands.getSelectedIds()
    if (!selected.length) return

    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      __canvaCommands.deleteSelected()
      return
    }

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      selected.forEach((id) => __canvaCommands.duplicateShape(id))
      return
    }

    if ((e.metaKey || e.ctrlKey) && e.key === ']') {
      e.preventDefault()
      __canvaCommands.bringForward()
      return
    }

    if ((e.metaKey || e.ctrlKey) && e.key === '[') {
      e.preventDefault()
      __canvaCommands.sendBackward()
      return
    }

    const delta = e.shiftKey ? 10 : 1
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault()
      selected.forEach((id) => {
        const shape = _shapeList.find((s) => s.id === id)
        if (!shape) return
        let x = shape.x
        let y = shape.y
        if (e.key === 'ArrowUp') y -= delta
        if (e.key === 'ArrowDown') y += delta
        if (e.key === 'ArrowLeft') x -= delta
        if (e.key === 'ArrowRight') x += delta
        __canvaCommands.updateShape(id, { x, y })
      })
    }
  }

  /* function onDoubleClick(ev: MouseEvent) {
    console.log('onDoubleClick ')
    const pt = canvasPointFromEvent(ev)
    const hit = hitTestShapes(pt.x, pt.y)
    console.log('onDoubleClick hit ..', hit)

    if (hit) {
      if (hit.type === 'html') {
        console.log('onDoubleClick hit html ..', pt, hit)
        openHtmlEditor(hit.id)
        return
      } else if (hit.text) {
        console.log('onDoubleClick hit yes ..', pt, hit)
        _editingTextShapeId = hit.id
        _textInputValue = hit.text
        _textInputPos = { x: hit.x, y: hit.y - (hit.fontSize ?? 32) }
        console.log('onDoubleClick hit textInputPos ..', _textInputPos)
        setTimeout(() => _textInputEl?.focus(), 0)
      }
    }
  } */

  onMount(async () => {
    console.log('syncPosition onMount', { _syncTick })

    // const CanvasKitInit = (await import('canvaskit-wasm')).default

    try {
      _CanvasKit = await CanvasKitInit({
        locateFile: () => canvasKitWasmUrl
      })
    } catch (error) {
      _renderMode = 'none'
      _renderError = error instanceof Error ? error.message : String(error)
      console.error('[design] CanvasKit failed to load', error)
      return
    }
    setupCanvasSize(__canvaWidth || 500, __canvaHeight || 500)
    // WebGL where the device has it, a software surface where it has not
    // (#101); never an exception out of onMount that leaves a blank canvas.
    const created = createCanvasSurface(_CanvasKit, _canvasEl, { webgl: isWebGLAvailable() })
    _renderMode = created.mode
    _renderError = created.error ?? ''
    _canvasEl = created.canvas
    if (!created.surface) {
      console.error('[design] no drawing surface:', created.error)
      return
    }
    if (created.mode === 'software') {
      console.info('[design] rendering in software:', created.error)
    }
    _surface = created.surface
    _canvas = _surface.getCanvas()

    // _CanvasKit = await CanvasKitInit({
    //   locateFile: (f) => `/canvaskit/${f}`
    // })

    // setupCanvasSize(__canvaWidth || 500, __canvaHeight || 500)
    // setupCanvasSize(500, 500)
    // _surface = _CanvasKit.MakeCanvasSurface(_canvasEl)
    // _canvas = _surface.getCanvas()

    sync()
    __shapes.observe(sync)

    _canvasEl?.addEventListener('pointerdown', onPointerDown)
    _canvasEl?.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    _canvasEl?.addEventListener('pointermove', onPointerEnter)

    /*  // Register the nodeview
    _$_wysiwygEditorsList.registerNodeview(__wysiwygEditorIdToUpdate, {
      id: __canvaId,
      type: CustomDesignExtensionProps.name,
      isActive: false
    })
    // Set only this to active, desactive others
    _$_wysiwygEditorsList.setActiveNodeview(__wysiwygEditorIdToUpdate, __canvaId)

    console.log(
      'yes focus registerNodeview',
      __wysiwygEditorIdToUpdate,
      _$_wysiwygEditorsList.getList(),
      _$_wysiwygEditorsList.getEntry(__wysiwygEditorIdToUpdate)
    ) */

    // _canvasEl.addEventListener('pointerdown', onPointerDown)

    // Make the canvas element focusable
    /* _canvasEl.tabIndex = 0
    _canvasEl.addEventListener('pointerdown', (e) => {
      _canvasEl.focus()
      onPointerDown(e)
    })
    _canvasEl.addEventListener('focus', (e) => {
      // console.log('yes focus _canvasEl', e)
      // Set this nodeview as active
      /* _$_wysiwygEditorsList.setActiveNodeview(
        __wysiwygEditorIdToUpdate,
        // _$_wysiwygEditorsList.getActiveEntry().id
        __canvaId
      ) +/
      // console.log('yes focus active', _$_wysiwygEditorsList.getActiveEntry())
    })
    _canvasEl.addEventListener('blur', (e) => {
      console.log('yes blur _canvasEl', e)
      // Unset this slide
      // _$_wysiwygEditorsList.unsetActiveNodeview(__wysiwygEditorIdToUpdate, __slideId)
    }) */
  })

  onDestroy(() => {
    __shapes.unobserve(sync)
    _surface?.delete()
    _canvasEl?.removeEventListener('pointerdown', onPointerDown)
    _canvasEl?.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    // window.removeEventListener('pointerenter', onPointerEnter)
    _canvasEl?.removeEventListener('pointermove', onPointerEnter)
  })
</script>

<!-- <canvas bind:this={_canvasEl} width={__canvaWidth} height={__canvaHeight} class="border rounded" /> -->

<ImageEditorUI {__canvaWidth} {__canvaHeight} {__maxPageWidth} {__maxPageHeight}>
  <svelte:fragment slot="editor-canvas">
    <!-- <div
      class="workspace relative node-view-{CustomDesignExtensionProps.name}-content node-view-content"
      onmousedown={handleMouseDown}
      onmousemove={handleMouseMove}
      onmouseup={handleMouseUp}
    > -->
    <div
      class="workspace relative node-view-{CustomDesignExtensionProps.name}-content node-view-content"
    >
      <canvas
        tabindex="0"
        bind:this={_canvasEl}
        class="skia-canvas bg-[color-mix(in_srgb,var(--color-base-white)_100%,transparent)]"
        width={__canvaWidth}
        height={__canvaHeight}
      ></canvas>

      {#if _renderMode === 'none'}
        <div class="design-canvas-unavailable" role="alert">
          <i class="ph-light ph-warning-circle text-[28px]" aria-hidden="true"></i>
          <p class="font-semibold">{$_('The Design canvas cannot be displayed')}</p>
          <p>
            {$_(
              'This device provides no WebGL and the software renderer could not start. Your design is saved and will show where graphics are available.'
            )}
          </p>
          {#if _renderError}
            <p class="design-canvas-unavailable-detail">{_renderError}</p>
          {/if}
        </div>
      {/if}

      {#each _shapeList as shape (shape.id)}
        {#if shape.type == 'text'}
          <SkiaTextShape
            {__canvaId}
            {__canvaPath}
            __shape={shape}
            __syncTick={_syncTick}
            {__provider}
            __yText={getOrCreateTextFragment(__texts, shape.id)}
            {__awareness}
            __onSelect={(id, ev) => __onSelect?.(id || shape.id, ev)}
          />
        {/if}
      {/each}
      <!-- <canvas bind:this={overlayEl} width="800" height="600"></canvas> -->
      <!-- <div id="cursor-overlay-{_cursorId}" class="cursor-overlay"></div> -->
      <!-- <div class="hidden-tools">
        <input
          bind:this={_textInputEl}
          class="text-edit-input"
          type="text"
          bind:value={_textInputValue}
          style="top:{_textInputPos.y}px; left:{_textInputPos.x}px; display:{_editingTextShapeId
            ? 'block'
            : 'none'};"
          on:keydown={handleTextInputKey}
          on:blur={commitTextEdit}
        />
      </div> -->
    </div>
  </svelte:fragment>
</ImageEditorUI>

<style>
  .design-canvas-unavailable {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 24px;
    text-align: center;
    font-size: 13px;
    line-height: 1.4;
    color: var(--color-base-content, #374151);
    background: var(--color-base-100, #f9fafb);
    border: 1px dashed rgba(0, 0, 0, 0.2);
  }

  .design-canvas-unavailable p {
    margin: 0;
    max-width: 420px;
  }

  .design-canvas-unavailable-detail {
    font-size: 11px;
    opacity: 0.6;
  }
</style>
