import Konva from 'konva'

// A slide element's `z` is its place in the stacking order, the same order
// the thumbnails, the slideshow and the .pptx export draw. Konva's
// zIndex(n) is instead a position among the layer's current children
// (transformers included), clamped to how many there are, so elements that
// mount or load at different times end up out of order. Each element's group
// records its z, and the layer's elements are restacked by it.

const Z_ATTR = 'slideZ'

/** Records `z` on an element's group and restacks its layer by z. */
export function applySlideZOrder(group: Konva.Node, z: number): void {
  group.setAttr(Z_ATTR, Number(z) || 0)
  const layer = group.getLayer()
  if (!layer) return
  const elements = layer.getChildren((node) => typeof node.getAttr(Z_ATTR) === 'number')
  // Array.prototype.sort is stable: equal z keep their current order.
  const ordered = [...elements].sort((a, b) => a.getAttr(Z_ATTR) - b.getAttr(Z_ATTR))
  for (const node of ordered) node.moveToTop()
  for (const node of layer.getChildren((n) => n instanceof Konva.Transformer)) node.moveToTop()
  layer.batchDraw()
}
