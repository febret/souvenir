export const MIN_BRUSH_SIZE = 0.01;
export const MAX_BRUSH_SIZE = 0.2;
export const MAX_MASK_BLUR = 64;
export const MAX_MASK_DIMENSION = 1024;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function clampBrushSize(value) {
  return clamp(Number(value) || MIN_BRUSH_SIZE, MIN_BRUSH_SIZE, MAX_BRUSH_SIZE);
}

export function clampMaskBlur(value) {
  return Math.round(clamp(Number(value) || 0, 0, MAX_MASK_BLUR));
}

export function maskCanvasDimensions(width, height, maxDimension = MAX_MASK_DIMENSION) {
  const sourceWidth = Math.max(1, Math.round(Number(width) || 1));
  const sourceHeight = Math.max(1, Math.round(Number(height) || 1));
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

export function createEraseMaskCanvas(width, height) {
  const dimensions = maskCanvasDimensions(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  return canvas;
}

export function cloneEraseMaskCanvas(source) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  canvas.getContext("2d").drawImage(source, 0, 0);
  return canvas;
}

export function normalizedStrokePoints(from, to, diameter) {
  const start = from ?? to;
  const end = to ?? from;
  if (!start || !end) return [];
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const spacing = Math.max(clampBrushSize(diameter) * 0.35, 0.0025);
  const steps = Math.max(1, Math.ceil(distance / spacing));
  return Array.from({ length: steps + 1 }, (_, index) => ({
    x: start.x + ((end.x - start.x) * index) / steps,
    y: start.y + ((end.y - start.y) * index) / steps,
  }));
}

export function paintEraseStroke(canvas, from, to, diameter) {
  const context = canvas.getContext("2d");
  const mode = arguments[4] ?? "erase";
  const erasingBackground = mode !== "restore";
  const points = normalizedStrokePoints(from, to, diameter);
  if (!points.length) return;
  const radius = (clampBrushSize(diameter) * Math.min(canvas.width, canvas.height)) / 2;
  context.save();
  context.globalCompositeOperation = erasingBackground ? "source-over" : "destination-out";
  context.fillStyle = "#fff";
  for (const point of points) {
    context.beginPath();
    context.arc(
      clamp(point.x, 0, 1) * canvas.width,
      clamp(1 - point.y, 0, 1) * canvas.height,
      radius,
      0,
      Math.PI * 2,
    );
    context.fill();
  }
  context.restore();
}

export function clearEraseMask(canvas) {
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
}

export function eraseMaskHasPaint(canvas) {
  const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] !== 0) return true;
  }
  return false;
}

export function binaryEraseMaskCanvas(maskCanvas) {
  const binary = document.createElement("canvas");
  binary.width = maskCanvas.width;
  binary.height = maskCanvas.height;
  const binaryContext = binary.getContext("2d", { willReadFrequently: true });
  binaryContext.drawImage(maskCanvas, 0, 0);
  const source = binaryContext.getImageData(0, 0, binary.width, binary.height);
  for (let index = 0; index < source.data.length; index += 4) {
    const erased = source.data[index + 3] >= 128;
    source.data[index] = 255;
    source.data[index + 1] = 255;
    source.data[index + 2] = 255;
    source.data[index + 3] = erased ? 255 : 0;
  }
  binaryContext.putImageData(source, 0, 0);
  return binary;
}

export function opacityMapCanvas(maskCanvas, blur = 0) {
  const binary = binaryEraseMaskCanvas(maskCanvas);
  const binaryContext = binary.getContext("2d", { willReadFrequently: true });
  const source = binaryContext.getImageData(0, 0, binary.width, binary.height);
  const width = maskCanvas.width;
  const height = maskCanvas.height;
  const coverage = softEdgeCoverage(source.data, width, height, clampMaskBlur(blur));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const output = context.createImageData(width, height);
  for (let index = 0; index < coverage.data.length; index += 4) {
    const eraseCoverage = source.data[index + 3] === 255
      ? 255
      : coverage.data[index + 3];
    const opacity = 255 - eraseCoverage;
    output.data[index] = opacity;
    output.data[index + 1] = opacity;
    output.data[index + 2] = opacity;
    output.data[index + 3] = 255;
  }
  context.putImageData(output, 0, 0);
  return canvas;
}

function softEdgeCoverage(binaryRgba, width, height, blurRadius) {
  const radius = Math.max(0, Math.round(blurRadius));
  const alpha = new Uint8ClampedArray(width * height);
  for (let index = 0; index < alpha.length; index += 1) {
    alpha[index] = binaryRgba[index * 4 + 3];
  }
  if (radius <= 0) return alphaImage(alpha, width, height);
  const horizontal = boxBlurAlpha(alpha, width, height, radius, true);
  const vertical = boxBlurAlpha(horizontal, width, height, radius, false);
  return alphaImage(vertical, width, height);
}

function boxBlurAlpha(alpha, width, height, radius, horizontal) {
  const output = new Uint8ClampedArray(alpha.length);
  const span = radius * 2 + 1;
  if (horizontal) {
    for (let y = 0; y < height; y += 1) {
      let sum = 0;
      for (let x = -radius; x <= radius; x += 1) {
        const sampleX = Math.max(0, Math.min(width - 1, x));
        sum += alpha[y * width + sampleX];
      }
      for (let x = 0; x < width; x += 1) {
        output[y * width + x] = Math.round(sum / span);
        const removeX = Math.max(0, x - radius);
        const addX = Math.min(width - 1, x + radius + 1);
        sum += alpha[y * width + addX] - alpha[y * width + removeX];
      }
    }
    return output;
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) {
      const sampleY = Math.max(0, Math.min(height - 1, y));
      sum += alpha[sampleY * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      output[y * width + x] = Math.round(sum / span);
      const removeY = Math.max(0, y - radius);
      const addY = Math.min(height - 1, y + radius + 1);
      sum += alpha[addY * width + x] - alpha[removeY * width + x];
    }
  }
  return output;
}

function alphaImage(alpha, width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < alpha.length; index += 1) {
    const offset = index * 4;
    data[offset + 3] = alpha[index];
  }
  return { data };
}

export function surfaceUvToSourceUv(uv, textureTransform = {}) {
  const repeat = textureTransform.repeat ?? { x: 1, y: 1 };
  const offset = textureTransform.offset ?? { x: 0, y: 0 };
  return {
    x: clamp((uv?.x ?? 0.5) * repeat.x + offset.x, 0, 1),
    y: clamp((uv?.y ?? 0.5) * repeat.y + offset.y, 0, 1),
  };
}

export function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The erase mask could not be encoded as PNG."));
    }, "image/png");
  });
}
