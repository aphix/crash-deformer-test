/**
 * Minimal QR Code encoder for invite links: byte mode, error correction level M, versions 1–10
 * (up to 213 bytes). Follows ISO/IEC 18004 as laid out in Nayuki's reference encoder
 * (https://www.nayuki.io/page/qr-code-generator-library). Mask choice scores penalty rules 1, 2 and
 * 4; any mask decodes, the score only picks the cleanest.
 */

/** Level M, versions 1–10: EC codewords per block, and block count. */
const EC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const EC_BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
/** Format-information EC-level bits for M. */
const LEVEL_M = 0;

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const out = new Array<number>(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j]!, root);
      if (j + 1 < degree) out[j]! ^= out[j + 1]!;
    }
    root = gfMul(root, 2);
  }
  return out;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const out = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ out.shift()!;
    out.push(0);
    for (let i = 0; i < divisor.length; i++) out[i]! ^= gfMul(divisor[i]!, factor);
  }
  return out;
}

/** Data modules of a version: everything but function patterns. */
function rawModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

function dataCodewords(ver: number): number {
  return Math.floor(rawModules(ver) / 8) - EC_PER_BLOCK[ver - 1]! * EC_BLOCKS[ver - 1]!;
}

function alignmentPositions(ver: number, size: number): number[] {
  if (ver === 1) return [];
  const count = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

/** The QR symbol for `text` (UTF-8): `size × size` modules, row-major, true = dark. */
export function encodeQr(text: string): { size: number; dark: boolean[] } {
  const bytes = [...new TextEncoder().encode(text)];
  let ver = 1;
  for (; ver <= 10; ver++) if (4 + (ver < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords(ver) * 8) break;
  if (ver > 10) throw new Error("text too long for a version-10 QR code");

  // Bit stream: byte mode, count, data, terminator, byte padding, pad codewords.
  const bits: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(4, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(ver) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  // Error correction per block, then interleave.
  const blocks = EC_BLOCKS[ver - 1]!;
  const ecLen = EC_PER_BLOCK[ver - 1]!;
  const raw = Math.floor(rawModules(ver) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const div = rsDivisor(ecLen);
  const split: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const dat = data.slice(k, k + shortLen - ecLen + (i < shortBlocks ? 0 : 1));
    k += dat.length;
    const ec = rsRemainder(dat, div);
    if (i < shortBlocks) dat.push(0);
    split.push(dat.concat(ec));
  }
  const codewords: number[] = [];
  for (let i = 0; i < split[0]!.length; i++) {
    for (let j = 0; j < split.length; j++) if (i !== shortLen - ecLen || j >= shortBlocks) codewords.push(split[j]![i]!);
  }

  // Function patterns.
  const size = ver * 4 + 17;
  const dark = new Array<boolean>(size * size).fill(false);
  const fixed = new Array<boolean>(size * size).fill(false);
  const set = (x: number, y: number, on: boolean) => {
    dark[y * size + x] = on;
    fixed[y * size + x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const align = alignmentPositions(ver, size);
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(align[i]! + dx, align[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  const drawFormat = (mask: number) => {
    const d = (LEVEL_M << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((d << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((f >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const v = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const on = ((v >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, on);
      set(b, a, on);
    }
  }

  // Codewords in the zigzag, two columns at a time from the bottom right.
  let n = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (fixed[y * size + x] || n >= codewords.length * 8) continue;
        dark[y * size + x] = ((codewords[n >>> 3]! >>> (7 - (n & 7))) & 1) !== 0;
        n++;
      }
    }
  }

  const masks: ((x: number, y: number) => boolean)[] = [
    (x, y) => (x + y) % 2 === 0,
    (_x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const applyMask = (m: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y * size + x] && masks[m]!(x, y)) dark[y * size + x] = !dark[y * size + x];
  };
  const penalty = () => {
    let p = 0;
    let darkCount = 0;
    for (let y = 0; y < size; y++) {
      for (let pass = 0; pass < 2; pass++) {
        let run = 0;
        let prev = false;
        for (let x = 0; x < size; x++) {
          const on = pass === 0 ? dark[y * size + x]! : dark[x * size + y]!;
          if (x > 0 && on === prev) run++;
          else {
            if (run >= 5) p += run - 2;
            run = 1;
          }
          prev = on;
        }
        if (run >= 5) p += run - 2;
      }
      for (let x = 0; x < size; x++) {
        const on = dark[y * size + x]!;
        if (on) darkCount++;
        if (x + 1 < size && y + 1 < size && on === dark[y * size + x + 1] && on === dark[(y + 1) * size + x] && on === dark[(y + 1) * size + x + 1]) p += 3;
      }
    }
    const total = size * size;
    return p + (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
  };
  let best = 0;
  let bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m);
    drawFormat(m);
    const s = penalty();
    if (s < bestScore) {
      bestScore = s;
      best = m;
    }
    applyMask(m);
  }
  applyMask(best);
  drawFormat(best);
  return { size, dark };
}
