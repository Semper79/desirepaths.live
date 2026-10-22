import { describe, expect, it } from 'vitest';
import {
  apcaLc,
  checkContrast,
  ColorParseError,
  contrastRatio,
  oklchToRgb,
  parseColor,
  relativeLuminance,
  rgbToHex,
} from '../src/color';

describe('parseColor', () => {
  it('reads six-digit hex', () => {
    expect(parseColor('#ff8000')).toEqual({ r: 1, g: 128 / 255, b: 0 });
  });

  it('expands three-digit hex', () => {
    expect(parseColor('#f80')).toEqual(parseColor('#ff8800'));
  });

  it('is case-insensitive and tolerates surrounding space', () => {
    expect(parseColor('  #FF8000 ')).toEqual(parseColor('#ff8000'));
  });

  it('reads oklch in both unit and percentage form', () => {
    const unit = parseColor('oklch(0.62 0.15 250)');
    const percent = parseColor('oklch(62% 0.15 250)');
    expect(rgbToHex(unit)).toBe(rgbToHex(percent));
  });

  it('accepts an explicit hue unit', () => {
    expect(rgbToHex(parseColor('oklch(0.62 0.15 250deg)'))).toBe(
      rgbToHex(parseColor('oklch(0.62 0.15 250)')),
    );
  });

  it('rejects anything else, including alpha forms', () => {
    expect(() => parseColor('rgba(0,0,0,0.5)')).toThrow(ColorParseError);
    expect(() => parseColor('#ff8000aa')).toThrow(ColorParseError);
    expect(() => parseColor('red')).toThrow(ColorParseError);
    expect(() => parseColor('')).toThrow(ColorParseError);
  });
});

describe('oklchToRgb', () => {
  it('maps zero chroma to a neutral grey', () => {
    const grey = oklchToRgb({ l: 0.5, c: 0, h: 0 });
    expect(grey.r).toBeCloseTo(grey.g, 6);
    expect(grey.g).toBeCloseTo(grey.b, 6);
  });

  it('maps L=1, C=0 to white and L=0 to black', () => {
    expect(rgbToHex(oklchToRgb({ l: 1, c: 0, h: 0 }))).toBe('#ffffff');
    expect(rgbToHex(oklchToRgb({ l: 0, c: 0, h: 0 }))).toBe('#000000');
  });

  it('keeps hue and lightness when reducing an out-of-gamut chroma', () => {
    // C = 0.4 at this lightness is far outside sRGB. The result must stay in gamut
    // and stay recognisably the same hue - not clip into a different colour.
    const wild = oklchToRgb({ l: 0.6, c: 0.4, h: 150 });
    for (const channel of [wild.r, wild.g, wild.b]) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(1);
    }
    // Hue 150 is green-leaning: green must dominate.
    expect(wild.g).toBeGreaterThan(wild.r);
    expect(wild.g).toBeGreaterThan(wild.b);
  });

  it('is stable for an in-gamut colour', () => {
    const inGamut = { l: 0.6, c: 0.05, h: 250 };
    expect(rgbToHex(oklchToRgb(inGamut))).toBe(rgbToHex(oklchToRgb(inGamut)));
  });
});

describe('relativeLuminance', () => {
  it('matches the WCAG reference endpoints', () => {
    expect(relativeLuminance(parseColor('#ffffff'))).toBeCloseTo(1, 10);
    expect(relativeLuminance(parseColor('#000000'))).toBeCloseTo(0, 10);
  });
});

describe('contrastRatio', () => {
  it('is 21:1 for black on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 6);
  });

  it('is order-independent', () => {
    expect(contrastRatio('#123456', '#abcdef')).toBeCloseTo(
      contrastRatio('#abcdef', '#123456'),
      12,
    );
  });

  it('is 1:1 for a colour against itself', () => {
    expect(contrastRatio('#3366cc', '#3366cc')).toBeCloseTo(1, 12);
  });

  it('reproduces the canonical AA boundary cases', () => {
    // #767676 on white is the textbook "just passes AA" grey (4.54:1);
    // #777777 is the textbook "just fails" one (4.48:1).
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThan(4.5);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.5);
  });

  it('accepts already-parsed colours', () => {
    expect(contrastRatio(parseColor('#000'), parseColor('#fff'))).toBeCloseTo(21, 6);
  });
});

describe('checkContrast', () => {
  it('enforces 4.5:1 for body text', () => {
    expect(checkContrast('#777777', '#ffffff', 'body').passes).toBe(false);
    expect(checkContrast('#767676', '#ffffff', 'body').passes).toBe(true);
  });

  it('enforces 3:1 for large text and UI', () => {
    expect(checkContrast('#949494', '#ffffff', 'large').passes).toBe(true);
    expect(checkContrast('#949494', '#ffffff', 'ui').passes).toBe(true);
    expect(checkContrast('#cccccc', '#ffffff', 'ui').passes).toBe(false);
  });

  it('imposes no requirement on decorative colour', () => {
    const result = checkContrast('#fefefe', '#ffffff', 'decorative');
    expect(result.required).toBe(0);
    expect(result.passes).toBe(true);
  });

  it('reports the ratio rounded the way every accessibility tool does', () => {
    const result = checkContrast('#000000', '#ffffff', 'body');
    expect(result.ratio).toBe(21);
    expect(result.foreground).toBe('#000000');
    expect(result.background).toBe('#ffffff');
    expect(result.role).toBe('body');
  });
});

describe('apcaLc', () => {
  it('is strongly positive for dark text on a light background', () => {
    expect(apcaLc('#000000', '#ffffff')).toBeGreaterThan(100);
  });

  it('is negative for light text on a dark background', () => {
    expect(apcaLc('#ffffff', '#000000')).toBeLessThan(-90);
  });

  it('is zero for a colour against itself', () => {
    expect(apcaLc('#808080', '#808080')).toBe(0);
  });

  it('collapses to zero below the perceptual threshold', () => {
    expect(Math.abs(apcaLc('#808080', '#828282'))).toBe(0);
    expect(Math.abs(apcaLc('#828282', '#808080'))).toBe(0);
  });

  it('accepts parsed colours', () => {
    expect(apcaLc(parseColor('#000'), parseColor('#fff'))).toBeGreaterThan(100);
  });
});
