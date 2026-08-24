import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_BRUSH_SIZE,
  MAX_MASK_BLUR,
  MIN_BRUSH_SIZE,
  binaryEraseMaskCanvas,
  clampBrushSize,
  clampMaskBlur,
  clearEraseMask,
  createEraseMaskCanvas,
  eraseMaskHasPaint,
  maskCanvasDimensions,
  normalizedStrokePoints,
  opacityMapCanvas,
  paintEraseStroke,
  surfaceUvToSourceUv,
} from "../../app/src/core/erase-mask.js";

class TestContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.data = new Uint8ClampedArray(canvas.width * canvas.height * 4);
    this.filter = "none";
    this.path = null;
  }

  save() {}
  restore() {}
  beginPath() { this.path = null; }
  arc(x, y, radius) { this.path = { x, y, radius }; }

  fill() {
    if (!this.path) return;
    const { x, y, radius } = this.path;
    for (let row = Math.max(0, Math.floor(y - radius)); row < Math.min(this.canvas.height, Math.ceil(y + radius)); row += 1) {
      for (let column = Math.max(0, Math.floor(x - radius)); column < Math.min(this.canvas.width, Math.ceil(x + radius)); column += 1) {
        if (Math.hypot(column + 0.5 - x, row + 0.5 - y) <= radius) {
          const index = (row * this.canvas.width + column) * 4;
          this.data[index] = 255;
          this.data[index + 1] = 255;
          this.data[index + 2] = 255;
          this.data[index + 3] = 255;
        }
      }
    }
  }

  clearRect() { this.data.fill(0); }

  drawImage(source) {
    const sourceData = source.getContext("2d").data;
    const blur = Number(this.filter.match(/blur\((\d+)px\)/)?.[1] ?? 0);
    for (let row = 0; row < this.canvas.height; row += 1) {
      for (let column = 0; column < this.canvas.width; column += 1) {
        const index = (row * this.canvas.width + column) * 4;
        if (!blur) {
          this.data.set(sourceData.slice(index, index + 4), index);
          continue;
        }
        let alpha = 0;
        let samples = 0;
        for (let y = Math.max(0, row - blur); y <= Math.min(this.canvas.height - 1, row + blur); y += 1) {
          for (let x = Math.max(0, column - blur); x <= Math.min(this.canvas.width - 1, column + blur); x += 1) {
            alpha += sourceData[(y * this.canvas.width + x) * 4 + 3];
            samples += 1;
          }
        }
        this.data[index] = 255;
        this.data[index + 1] = 255;
        this.data[index + 2] = 255;
        this.data[index + 3] = alpha / samples;
      }
    }
  }

  getImageData() { return { data: new Uint8ClampedArray(this.data) }; }
  createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4) }; }
  putImageData(imageData) { this.data.set(imageData.data); }
}

class TestCanvas {
  constructor() {
    this.width = 300;
    this.height = 150;
    this.context = new TestContext(this);
  }

  getContext() { return this.context; }
}

const pixel = (canvas, x, y) => canvas.getContext("2d").data[(y * canvas.width + x) * 4];
const alpha = (canvas, x, y) => canvas.getContext("2d").data[(y * canvas.width + x) * 4 + 3];

describe("erase mask helpers", () => {
  const originalDocument = globalThis.document;

  beforeEach(() => {
    globalThis.document = { createElement: () => new TestCanvas() };
  });

  afterEach(() => {
    globalThis.document = originalDocument;
  });

  it("maps surface UVs through cropped texture repeat and offset without escaping source bounds", () => {
    expect(surfaceUvToSourceUv({ x: 0, y: 1 }, {
      repeat: { x: 0.5, y: 0.75 },
      offset: { x: 0.25, y: 0.1 },
    })).toEqual({ x: 0.25, y: 0.85 });
    expect(surfaceUvToSourceUv({ x: -2, y: 4 }, {
      repeat: { x: 0.5, y: 0.5 },
      offset: { x: 0.75, y: 0.75 },
    })).toEqual({ x: 0, y: 1 });
  });

  it("clamps brush size and blur to stable editor bounds", () => {
    expect(clampBrushSize(-1)).toBe(MIN_BRUSH_SIZE);
    expect(clampBrushSize("not-a-number")).toBe(MIN_BRUSH_SIZE);
    expect(clampBrushSize(9)).toBe(MAX_BRUSH_SIZE);
    expect(clampMaskBlur(-2)).toBe(0);
    expect(clampMaskBlur(1.6)).toBe(2);
    expect(clampMaskBlur(999)).toBe(MAX_MASK_BLUR);
  });

  it("interpolates continuous strokes densely enough that the painted line has no gaps", () => {
    const points = normalizedStrokePoints({ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }, 0.02);
    expect(points).toHaveLength(116);
    expect(points[0]).toEqual({ x: 0.1, y: 0.5 });
    expect(points.at(-1)).toEqual({ x: 0.9, y: 0.5 });

    const canvas = createEraseMaskCanvas(100, 100);
    paintEraseStroke(canvas, points[0], points.at(-1), 0.02);
    for (let x = 10; x <= 90; x += 1) {
      expect(alpha(canvas, x, 50), `stroke gap at x=${x}`).toBeGreaterThan(0);
    }
  });

  it("caps working canvas dimensions while retaining the source aspect ratio", () => {
    expect(maskCanvasDimensions(4000, 2000)).toEqual({ width: 1024, height: 512 });
    expect(maskCanvasDimensions(800, 1600)).toEqual({ width: 512, height: 1024 });
    expect(maskCanvasDimensions(0, Number.NaN)).toEqual({ width: 1, height: 1 });
  });

  it("inverts painted coverage into grayscale opacity, with transparent erase paint and white untouched areas", () => {
    const canvas = createEraseMaskCanvas(9, 9);
    paintEraseStroke(canvas, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, 0.2);
    expect(eraseMaskHasPaint(canvas)).toBe(true);

    const opacity = opacityMapCanvas(canvas);
    expect(pixel(opacity, 4, 4)).toBe(0);
    expect(pixel(opacity, 0, 0)).toBe(255);
    expect(alpha(opacity, 4, 4)).toBe(255);
    clearEraseMask(canvas);
    expect(eraseMaskHasPaint(canvas)).toBe(false);
  });

  it("normalizes saved mask pixels to a binary transparent-or-erased field", () => {
    const canvas = createEraseMaskCanvas(3, 1);
    const source = canvas.getContext("2d");
    source.data[3] = 127;
    source.data[7] = 128;
    source.data[11] = 255;

    const binary = binaryEraseMaskCanvas(canvas);
    expect(alpha(binary, 0, 0)).toBe(0);
    expect(alpha(binary, 1, 0)).toBe(255);
    expect(alpha(binary, 2, 0)).toBe(255);
  });

  it("feathers only outside the binary mask while preserving full erase opacity inside", () => {
    const canvas = createEraseMaskCanvas(9, 9);
    paintEraseStroke(canvas, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, 0.01);
    const opacity = opacityMapCanvas(canvas, 1);
    expect(pixel(opacity, 4, 4)).toBe(0);
    expect(pixel(opacity, 3, 4)).toBeGreaterThan(0);
    expect(pixel(opacity, 3, 4)).toBeLessThan(255);
    expect(pixel(opacity, 0, 0)).toBe(255);
  });

  it("thresholds partial source alpha before applying whole-mask edge blur", () => {
    const canvas = createEraseMaskCanvas(3, 1);
    const context = canvas.getContext("2d");
    context.data[3] = 127;
    context.data[7] = 128;
    const opacity = opacityMapCanvas(canvas);
    expect(pixel(opacity, 0, 0)).toBe(255);
    expect(pixel(opacity, 1, 0)).toBe(0);
  });
});
