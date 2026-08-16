import { describe, expect, it } from 'vitest';
import { normaliserR43, normaliserR43Loose, normaliserSkilt } from './ordremottaker-vision';

describe('normaliserR43', () => {
  it('henter 43R-nummer fra AI-svar', () => {
    expect(normaliserR43Loose('43R:004592')).toBe('004592');
    expect(normaliserR43('43R-004592')).toBe('004592');
    expect(normaliserR43('E1 43R004592 LAMINATED')).toBe('004592');
    expect(normaliserR43('43R 004592.')).toBe('004592');
  });
  it('behandler O som 0 (OCR-forveksling)', () => {
    expect(normaliserR43('43R-OO4592')).toBe('004592');
  });
  it('null ved ingen 43R', () => {
    expect(normaliserR43('PLATE:SU18018')).toBeNull();
    expect(normaliserR43('NONE')).toBeNull();
  });
});

describe('normaliserSkilt', () => {
  it('henter norsk kjennemerke fra AI-svar', () => {
    expect(normaliserSkilt('PLATE:SU18018')).toBe('SU18018');
    expect(normaliserSkilt('Plate: AB12345')).toBe('AB12345');
  });
  it('null ved ugyldig format', () => {
    expect(normaliserSkilt('43R:004592')).toBeNull();
    expect(normaliserSkilt('NONE')).toBeNull();
  });
});
