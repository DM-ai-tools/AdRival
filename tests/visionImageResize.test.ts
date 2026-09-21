import assert from "node:assert/strict";
import { test } from "node:test";
import { PNG } from "pngjs";
import { prepareVisionImage } from "../src/lib/pipeline/competitorScreenshots";

function makeTallPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (width * y + x) << 2;
      png.data[i] = (x * 3) % 255;
      png.data[i + 1] = (y * 5) % 255;
      png.data[i + 2] = 120;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

test("prepareVisionImage downscales sides over Anthropic 8000px limit", async () => {
  const tall = makeTallPng(1200, 9000);
  const prepared = await prepareVisionImage(tall);
  assert.ok(prepared);
  assert.equal(prepared.mediaType, "image/jpeg");
  // Decode JPEG header SOF for height — sharp can re-read
  const sharp = (await import("sharp")).default;
  const meta = await sharp(Buffer.from(prepared.data, "base64")).metadata();
  assert.ok((meta.height || 0) <= 7500);
  assert.ok((meta.width || 0) <= 7500);
});
