/** Quantized sRGB contrast; Oklab matrices: https://bottosson.github.io/posts/oklab/ . */
const LINEAR = Float64Array.from({ length: 256 }, (_, n) => {
  const c = n / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const luminance = (rgb: number): number =>
  0.2126 * LINEAR[(rgb >>> 16) & 255]! +
  0.7152 * LINEAR[(rgb >>> 8) & 255]! +
  0.0722 * LINEAR[rgb & 255]!;
export function packedContrastRatio(a: number, b: number): number {
  const x = luminance(a) + 0.05,
    y = luminance(b) + 0.05;
  return Math.max(x, y) / Math.min(x, y);
}
function byte(c: number): number {
  return Math.round(
    Math.max(0, Math.min(1, c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)) * 255,
  );
}
function candidate(L: number, a: number, b: number): number {
  // Reduce chroma along the same hue ray until inside sRGB, then quantize.
  let lo = 0,
    hi = 1,
    result = -1;
  for (let i = 0; i < 10; i++) {
    const scale = i === 0 ? 1 : (lo + hi) / 2;
    const l = (L + 0.3963377774 * a * scale + 0.2158037573 * b * scale) ** 3;
    const m = (L - 0.1055613458 * a * scale - 0.0638541728 * b * scale) ** 3;
    const s = (L - 0.0894841775 * a * scale - 1.291485548 * b * scale) ** 3;
    const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const blue = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
    if (Math.min(r, g, blue) >= 0 && Math.max(r, g, blue) <= 1) {
      result = (byte(r) << 16) | (byte(g) << 8) | byte(blue);
      if (i === 0) return result;
      lo = scale;
    } else hi = scale;
  }
  return result < 0 ? byte(L ** 3) * 0x10101 : result;
}
/** Leave passing pairs exact. Search both lightness directions with a verified endpoint fallback. */
export function correctContrastForeground(fg: number, bg: number): number {
  if (packedContrastRatio(fg, bg) >= 4.5) return fg;
  const r = LINEAR[(fg >>> 16) & 255]!,
    g = LINEAR[(fg >>> 8) & 255]!,
    b = LINEAR[fg & 255]!;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  let best = 0,
    distance = Infinity;
  for (const end of [0, 1]) {
    let passing = end,
      failing = L;
    let rgb = end === 0 ? 0 : 0xffffff;
    if (packedContrastRatio(rgb, bg) < 4.5) continue;
    for (let i = 0; i < 12; i++) {
      const mid = (passing + failing) / 2;
      const trial = candidate(mid, a, bb);
      if (packedContrastRatio(trial, bg) >= 4.5) {
        passing = mid;
        rgb = trial;
      } else failing = mid;
    }
    if (Math.abs(passing - L) < distance) {
      best = rgb;
      distance = Math.abs(passing - L);
    }
  }
  return best;
}

/** Cheap high-color-churn fallback: linear-sRGB blend to the nearer passing endpoint. */
export function fastContrastForeground(fg: number, bg: number): number {
  if (packedContrastRatio(fg, bg) >= 4.5) return fg;
  const y = luminance(fg),
    base = luminance(bg);
  const darkTarget = (base + 0.05) / 4.5 - 0.05;
  const lightTarget = (base + 0.05) * 4.5 - 0.05;
  const darkMix = darkTarget >= 0 ? (y - darkTarget) / y : Infinity;
  const lightMix = lightTarget <= 1 ? (lightTarget - y) / (1 - y) : Infinity;
  const end = darkMix <= lightMix ? 0 : 1;
  // A small quantization margin usually avoids endpoint fallback. Always verify.
  const amount = Math.min(1, Math.max(0, Math.min(darkMix, lightMix)) + 0.012);
  const r = LINEAR[(fg >>> 16) & 255]!,
    g = LINEAR[(fg >>> 8) & 255]!,
    b = LINEAR[fg & 255]!;
  const result =
    (byte(r + (end - r) * amount) << 16) |
    (byte(g + (end - g) * amount) << 8) |
    byte(b + (end - b) * amount);
  return packedContrastRatio(result, bg) >= 4.5 ? result : end === 0 ? 0 : 0xffffff;
}

export function createContrastPairCache(limit = 4096) {
  const pairs = new Map<number, number>();
  let remaining = Infinity;
  return {
    beginFrame() {
      remaining = 128;
    },
    get size() {
      return pairs.size;
    },
    correct(fg: number, bg: number): number {
      const key = fg * 0x1000000 + bg;
      const cached = pairs.get(key);
      if (cached !== undefined) return cached;
      const corrected =
        packedContrastRatio(fg, bg) >= 4.5
          ? fg
          : remaining-- > 0
            ? correctContrastForeground(fg, bg)
            : fastContrastForeground(fg, bg);
      if (pairs.size >= limit) pairs.clear();
      pairs.set(key, corrected);
      return corrected;
    },
  };
}

export interface ContrastBuffer {
  readonly buffers: {
    char: Uint32Array;
    fg: Uint16Array;
    bg: Uint16Array;
    attributes: Uint32Array;
  };
}
const read = (c: Uint16Array, i: number) =>
  ((c[i]! & 255) << 16) | ((c[i + 1]! & 255) << 8) | (c[i + 2]! & 255);
/** Final composed surface only: no canonical state or scheduling; allocation-free cache hits. */
export function createAutomaticContrastPass() {
  const cache = createContrastPairCache();
  return (buffer: ContrastBuffer): void => {
    cache.beginFrame();
    const { char, fg, bg, attributes } = buffer.buffers;
    for (let cell = 0; cell < char.length; cell++) {
      const cp = char[cell]!,
        attr = attributes[cell]!,
        i = cell * 4;
      // Preserve concealment, whitespace and pixel-art coverage. Grapheme IDs and
      // wide continuations are opaque and retained byte-for-byte.
      if (
        attr & 64 ||
        cp === 0 ||
        cp === 32 ||
        cp === 160 ||
        (cp >= 0x2580 && cp <= 0x259f) ||
        (cp >= 0x2800 && cp <= 0x28ff)
      )
        continue;
      if ((fg[i + 3]! & 255) !== 255 || (bg[i + 3]! & 255) !== 255) continue;
      const foreground = attr & 32 ? bg : fg;
      const background = attr & 32 ? fg : bg;
      const original = read(foreground, i);
      const base = read(background, i);
      // DIM is emulator-dependent. Materialize a deterministic 50% sRGB blend
      // before correction and clear only the final composed DIM bit.
      let visible = original;
      if (attr & 2) {
        visible =
          (Math.round(((original >>> 16) + (base >>> 16)) / 2) << 16) |
          (Math.round((((original >>> 8) & 255) + ((base >>> 8) & 255)) / 2) << 8) |
          Math.round(((original & 255) + (base & 255)) / 2);
        attributes[cell] = attr & ~2;
      }
      const corrected = cache.correct(visible, base);
      if (corrected === original && !(attr & 2)) continue;
      // RGB intent is zero. Indexed/default metadata must not override correction.
      foreground[i] = corrected >>> 16;
      foreground[i + 1] = (corrected >>> 8) & 255;
      foreground[i + 2] = corrected & 255;
      foreground[i + 3] = 255;
    }
  };
}
