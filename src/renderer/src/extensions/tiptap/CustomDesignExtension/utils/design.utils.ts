import type { CanvasKit } from "canvaskit-wasm";

// CanvasKit.Color takes 0-255 channels; the channels here are 0-1 floats, so
// they go through Color4f (through Color they all came out near black).

export const parseColor = (ck: CanvasKit, hex: string, alpha: number = 1) => {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return ck.Color4f(r, g, b, alpha);
};