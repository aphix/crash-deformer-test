import * as THREE from "three";

/**
 * One face atlas for every dummy: a multiplier (1 = the slot's skin colour) sampled by UV on the skull. Four rows, the slot
 * index picks one. 64² a row, stacked to 256 tall, so the GPU can mip it; linear filtering, no sparkle. Not sRGB: it
 * multiplies a colour the palette already converted.
 */

/** Texels on a side of one face. 128 keeps a brow and a lip readable in a close shot; 64 smeared into blocks. */
const FACE_W = 128;
const FACE_H = 128;
export const FACE_ROWS = 4;
const SKIN: readonly [number, number, number] = [255, 255, 255];
const CHEEK: readonly [number, number, number] = [236, 196, 186];
const SHADE: readonly [number, number, number] = [214, 176, 162];
const EYE: readonly [number, number, number] = [36, 28, 24];
const WHITE: readonly [number, number, number] = [246, 240, 234];
const BROW: readonly [number, number, number] = [72, 52, 40];
const LIP: readonly [number, number, number] = [196, 112, 108];

type Rgb = readonly [number, number, number];

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function put(px: Uint8Array, row: number, x: number, y: number, rgb: Rgb, cover = 1): void {
  if (x < 0 || y < 0 || x >= FACE_W || y >= FACE_H) return;
  const i = ((row * FACE_H + y) * FACE_W + x) * 4;
  px[i] = px[i]! + (rgb[0] - px[i]!) * cover;
  px[i + 1] = px[i + 1]! + (rgb[1] - px[i + 1]!) * cover;
  px[i + 2] = px[i + 2]! + (rgb[2] - px[i + 2]!) * cover;
  px[i + 3] = 255;
}

function disc(px: Uint8Array, row: number, cx: number, cy: number, rx: number, ry: number, rgb: Rgb): void {
  for (let y = Math.floor(cy - ry - 1); y <= cy + ry + 1; y++) {
    for (let x = Math.floor(cx - rx - 1); x <= cx + rx + 1; x++) {
      const u = (x + 0.5 - cx) / rx;
      const v = (y + 0.5 - cy) / ry;
      const d = u * u + v * v;
      if (d < 1.4) put(px, row, x, y, rgb, d < 0.7 ? 1 : Math.max(0, 1.4 - d));
    }
  }
}

function stroke(px: Uint8Array, row: number, x0: number, x1: number, y: number, lift: number, rgb: Rgb): void {
  const n = x1 - x0;
  for (let i = 0; i <= n; i++) {
    const at = y + Math.round((lift * i) / Math.max(1, n));
    put(px, row, x0 + i, at, rgb, 1);
    put(px, row, x0 + i, at + 1, rgb, 0.85);
    put(px, row, x0 + i, at - 1, rgb, 0.35);
  }
}

function face(px: Uint8Array, row: number, smile: number, browLift: number): void {
  for (let y = 0; y < FACE_H; y++) for (let x = 0; x < FACE_W; x++) put(px, row, x, y, SKIN);
  disc(px, row, 40, 52, 12, 8, CHEEK);
  disc(px, row, 88, 52, 12, 8, CHEEK);
  disc(px, row, 45, 78, 7, 4, WHITE);
  disc(px, row, 83, 78, 7, 4, WHITE);
  disc(px, row, 45, 78, 2.2, 2.4, EYE);
  disc(px, row, 83, 78, 2.2, 2.4, EYE);
  stroke(px, row, 36, 54, 88, browLift, BROW);
  stroke(px, row, 74, 92, 88, -browLift, BROW);
  disc(px, row, 64, 58, 3, 4, SHADE);
  for (let x = 54; x <= 74; x++) {
    const curve = Math.round(smile * (1 - Math.abs(x - 64) / 10));
    put(px, row, x, 28 + curve, LIP, 1);
    put(px, row, x, 27 + curve, mix(LIP, SKIN, 0.4), 0.6);
  }
}

let atlas: THREE.DataTexture | undefined;

/** The shared face atlas. One texture for every slot; the shader picks the row. */
export function faceMap(): THREE.DataTexture {
  if (atlas) return atlas;
  const px = new Uint8Array(FACE_W * FACE_H * FACE_ROWS * 4);
  const moods = [
    [1, 0],
    [2, 1],
    [0, -1],
    [1, 2],
  ] as const;
  for (let row = 0; row < FACE_ROWS; row++) face(px, row, moods[row]![0], moods[row]![1]);
  atlas = new THREE.DataTexture(px, FACE_W, FACE_H * FACE_ROWS);
  atlas.flipY = false;
  atlas.colorSpace = THREE.NoColorSpace;
  atlas.magFilter = THREE.LinearFilter;
  atlas.minFilter = THREE.LinearMipmapLinearFilter;
  atlas.generateMipmaps = true;
  atlas.needsUpdate = true;
  return atlas;
}
