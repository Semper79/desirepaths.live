/**
 * Colour maths for the adaptive design system.
 *
 * WHY THIS FILE EXISTS
 * Section 2.1 of the spec: "Every palette variant must pass a WCAG AA contrast check at
 * generation time; a variant that fails is rejected before it can ever be served.
 * Accessibility is not something the optimiser is allowed to trade away."
 *
 * That sentence only means something if the check is mechanical, runs before a
 * variant enters the pool, and cannot be disabled by a flag. This module is that
 * check. It is pure, has no dependencies, and is unit-tested against the reference
 * values in the WCAG 2.2 specification.
 *
 * WHY OKLCH
 * Palettes are authored in OKLCH rather than hex because the optimiser generates
 * palettes programmatically, and OKLCH is perceptually uniform: holding L constant
 * across hues actually holds *apparent* lightness constant, so a generated palette
 * stays coherent instead of having a muddy yellow and a screaming blue at the same
 * nominal lightness. Out-of-gamut colours are resolved by reducing chroma, never by
 * clamping channels - clamping shifts hue and produces the exact ugly artefacts an
 * automated palette generator must not ship.
 *
 * WHY NOT APCA
 * APCA (WCAG 3 draft) models contrast better than the 2.x ratio, particularly for
 * dark themes. It is not yet normative, and the legal obligation is WCAG 2.2 AA.
 * The gate below is the 2.2 ratio; `apcaLc` is provided alongside it as an advisory
 * score recorded in the adaptation log, so the switch is a one-line change the day
 * WCAG 3 lands.
 */

export interface Rgb {
  /** 0..1 */ readonly r: number;
  /** 0..1 */ readonly g: number;
  /** 0..1 */ readonly b: number;
}

export interface Oklch {
  /** Perceptual lightness, 0..1 */ readonly l: number;
  /** Chroma, 0..~0.4 */ readonly c: number;
  /** Hue in degrees, 0..360 */ readonly h: number;
}

export class ColorParseError extends Error {
  constructor(input: string) {
    super(`Not a colour this system understands: ${input}`);
    this.name = 'ColorParseError';
  }
}

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const OKLCH_RE = /^oklch\(\s*([0-9.]+)%?\s+([0-9.]+)\s+([0-9.]+)(?:deg)?\s*\)$/i;

/**
 * Accepts `#abc`, `#aabbcc` and `oklch(L C H)`.
 *
 * Alpha is deliberately unsupported: a translucent colour has no fixed contrast
 * ratio, and a design token that can be composited over anything cannot be
 * verified at generation time. Tokens that need transparency compose two opaque
 * tokens instead.
 */
export function parseColor(input: string): Rgb {
  const value = input.trim();

  if (HEX_RE.test(value)) {
    const hex = value.slice(1);
    const full =
      hex.length === 3
        ? // Non-null assertions are safe: HEX_RE guarantees three characters.
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length checked by HEX_RE
          `${hex[0]!}${hex[0]!}${hex[1]!}${hex[1]!}${hex[2]!}${hex[2]!}`
        : hex;
    const n = Number.parseInt(full, 16);
    return {
      r: ((n >> 16) & 0xff) / 255,
      g: ((n >> 8) & 0xff) / 255,
      b: (n & 0xff) / 255,
    };
  }

  const oklch = OKLCH_RE.exec(value);
  if (oklch) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- regex has three capture groups
    const rawL = Number.parseFloat(oklch[1]!);
    // A percentage form (`oklch(62% ...)`) and a unit form (`oklch(0.62 ...)`) are
    // both idiomatic CSS; normalise both to 0..1.
    const l = value.includes('%') ? rawL / 100 : rawL;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- regex has three capture groups
    const c = Number.parseFloat(oklch[2]!);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- regex has three capture groups
    const h = Number.parseFloat(oklch[3]!);
    return oklchToRgb({ l, c, h });
  }

  throw new ColorParseError(input);
}

// -----------------------------------------------------------------------------
// OKLCH -> sRGB
// -----------------------------------------------------------------------------

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** sRGB transfer function (linear -> encoded). */
function gammaEncode(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** sRGB transfer function (encoded -> linear). */
function gammaDecode(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Unclamped OKLab -> linear sRGB. Coefficients from Björn Ottosson's derivation. */
function oklabToLinearRgb(l: number, a: number, b: number): [number, number, number] {
  const lp = l + 0.3963377774 * a + 0.2158037573 * b;
  const mp = l - 0.1055613458 * a - 0.0638541728 * b;
  const sp = l - 0.0894841775 * a - 1.291485548 * b;

  const l3 = lp * lp * lp;
  const m3 = mp * mp * mp;
  const s3 = sp * sp * sp;

  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}

const IN_GAMUT_EPSILON = 1e-6;

function isInGamut([r, g, b]: [number, number, number]): boolean {
  return (
    r >= -IN_GAMUT_EPSILON &&
    r <= 1 + IN_GAMUT_EPSILON &&
    g >= -IN_GAMUT_EPSILON &&
    g <= 1 + IN_GAMUT_EPSILON &&
    b >= -IN_GAMUT_EPSILON &&
    b <= 1 + IN_GAMUT_EPSILON
  );
}

/**
 * Convert OKLCH to sRGB, reducing chroma until the colour fits the gamut.
 *
 * The binary search is 24 iterations, which resolves chroma to ~2e-8 - far below
 * the 8-bit quantisation that follows. Hue and lightness are preserved exactly,
 * which is the whole point: a generated palette that drifts in hue when it clips
 * looks broken in a way no reviewer can explain and no test would catch.
 */
export function oklchToRgb(input: Oklch): Rgb {
  const hRad = (input.h * Math.PI) / 180;

  const at = (chroma: number): [number, number, number] =>
    oklabToLinearRgb(input.l, chroma * Math.cos(hRad), chroma * Math.sin(hRad));

  let linear = at(input.c);

  if (!isInGamut(linear)) {
    let lo = 0;
    let hi = input.c;
    for (let i = 0; i < 24; i += 1) {
      const mid = (lo + hi) / 2;
      if (isInGamut(at(mid))) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    linear = at(lo);
  }

  return {
    r: clamp01(gammaEncode(clamp01(linear[0]))),
    g: clamp01(gammaEncode(clamp01(linear[1]))),
    b: clamp01(gammaEncode(clamp01(linear[2]))),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const byte = (x: number): string =>
    Math.round(clamp01(x) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

// -----------------------------------------------------------------------------
// WCAG 2.2 contrast
// -----------------------------------------------------------------------------

/** Relative luminance, WCAG 2.2 §Relative luminance. */
export function relativeLuminance(color: Rgb): number {
  return (
    0.2126 * gammaDecode(color.r) + 0.7152 * gammaDecode(color.g) + 0.0722 * gammaDecode(color.b)
  );
}

/**
 * Contrast ratio between two opaque colours, in [1, 21].
 * Order-independent by construction.
 */
export function contrastRatio(a: Rgb | string, b: Rgb | string): number {
  const ca = typeof a === 'string' ? parseColor(a) : a;
  const cb = typeof b === 'string' ? parseColor(b) : b;
  const la = relativeLuminance(ca);
  const lb = relativeLuminance(cb);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** The role a colour pair plays, which determines the threshold it must clear. */
export type ContrastRole =
  /** Body copy and anything below 18.66px regular / 24px bold. 4.5:1 */
  | 'body'
  /** Large text: >= 18.66px bold or >= 24px regular. 3:1 */
  | 'large'
  /** Icons, borders of inputs, focus rings, chart marks. 3:1 */
  | 'ui'
  /** Purely decorative. No requirement, but recorded so it is a decision, not an oversight. */
  | 'decorative';

const THRESHOLD: Record<ContrastRole, number> = {
  body: 4.5,
  large: 3,
  ui: 3,
  decorative: 0,
};

export interface ContrastCheck {
  readonly role: ContrastRole;
  readonly foreground: string;
  readonly background: string;
  readonly ratio: number;
  readonly required: number;
  readonly passes: boolean;
}

export function checkContrast(
  foreground: string,
  background: string,
  role: ContrastRole,
): ContrastCheck {
  const ratio = contrastRatio(foreground, background);
  const required = THRESHOLD[role];
  return {
    role,
    foreground,
    background,
    ratio: Math.round(ratio * 100) / 100,
    required,
    // Round to two decimals before comparing so a 4.4999 does not pass while a
    // designer's tool reports "4.50". Rounding up to the threshold is the same
    // convention every accessibility checker uses.
    passes: Math.round(ratio * 100) / 100 >= required,
  };
}

/**
 * Advisory APCA lightness contrast (Lc), for the adaptation log only.
 *
 * Implements the SAPC-APCA 0.1.9 (W3C draft) formula. Values are signed: positive
 * for dark text on light background, negative for the reverse. |Lc| >= 60 is
 * roughly WCAG AA body text, |Lc| >= 45 roughly AA large text.
 */
export function apcaLc(textColor: Rgb | string, bgColor: Rgb | string): number {
  const txt = typeof textColor === 'string' ? parseColor(textColor) : textColor;
  const bg = typeof bgColor === 'string' ? parseColor(bgColor) : bgColor;

  const yFrom = ({ r, g, b }: Rgb): number =>
    0.2126729 * Math.pow(r, 2.4) + 0.7151522 * Math.pow(g, 2.4) + 0.072175 * Math.pow(b, 2.4);

  const softClamp = (y: number): number => (y > 0.022 ? y : y + Math.pow(0.022 - y, 1.414));

  const yTxt = softClamp(yFrom(txt));
  const yBg = softClamp(yFrom(bg));

  if (Math.abs(yBg - yTxt) < 0.0005) return 0;

  if (yBg > yTxt) {
    const sapc = (Math.pow(yBg, 0.56) - Math.pow(yTxt, 0.57)) * 1.14;
    return sapc < 0.1 ? 0 : (sapc - 0.027) * 100;
  }
  const sapc = (Math.pow(yBg, 0.65) - Math.pow(yTxt, 0.62)) * 1.14;
  return sapc > -0.1 ? 0 : (sapc + 0.027) * 100;
}
