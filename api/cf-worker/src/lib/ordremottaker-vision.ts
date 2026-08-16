/**
 * ORDREMOTTAKER-VISION — bilde-støtte for AI-ordremottakeren (2026-08-16).
 *
 * Verkstedet sender et bilde i chatten:
 *  - 43R-merket på glasset  → ece_r43-oppslag → EKSAKT glass (varenavn, pris)
 *  - Kjennemerket på bilen  → SVV-enkeltoppslag → bil (merke, modell, år, VIN)
 *
 * Resultatet injiseres i LLM-dialogen som `imageContext` så ordremottakeren
 * kan bekrefte glasset/ordren med fysisk bevis — samme kanal som FinnBilGlass
 * (src/les-skilt.ts + vision-provider.ts), tilpasset B2B.
 */

import type { Env } from '../types';
import { queryByEurocode } from './db';

export const ORDREMOTTAKER_VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

export interface BildeKontekst {
  r43: string | null;    // normalisert (kun sifrene, f.eks. '004592')
  skilt: string | null;  // normalisert (f.eks. 'SU18018')
  raatekst: string;
}

/** AI-prompt: be om BÅDE 43R-nummer og kjennemerke (én avlesning per bilde). */
function visionPrompt(): string {
  return JSON.stringify({
    task: 'Read the vehicle glass approval marking AND the license plate in this image, if visible.',
    instructions: [
      'The approval marking looks like "43R-004592" (a circle with E1 or similar, then 43R followed by 4-7 digits).',
      'The license plate has 2 letters and 5 digits, e.g. SU18018.',
      'Respond with ONLY the found values, one per line, e.g.:',
      '43R:004592',
      'PLATE:SU18018',
      'Write 43R: or PLATE: only for values you actually see. If nothing is visible, respond with exactly: NONE',
    ],
  });
}

/** Normaliser 43R: strip landkode/tegn, behold kun sifrene. */
export function normaliserR43(raw: string): string | null {
  const m = /43R\s*[-–—]?\s*([0-9O]{4,7})/i.exec(raw);
  if (!m) return null;
  return m[1].replace(/O/g, '0');
}

/** Test-vennlig variant som også tåler «43R:004592» (kolon i stedet for bindestrek). */
export function normaliserR43Loose(raw: string): string | null {
  const m = /43R\s*[-–—:.]?\s*([0-9O]{4,7})/i.exec(raw);
  if (!m) return null;
  return m[1].replace(/O/g, '0');
}

/** Normaliser norsk kjennemerke: 2 bokstaver + 5 siffer. */
export function normaliserSkilt(raw: string): string | null {
  const m = /[A-ZÆØÅ]{2}\s*[-–—]?\s*\d{5}/i.exec(raw);
  return m ? m[0].toUpperCase().replace(/[\s\-–—]/g, '') : null;
}

/** Les 43R + skilt fra et bilde (dataURL). Returnerer alltid en kontekst. */
export async function lesBildeKontekst(ai: Ai, imageDataUrl: string): Promise<BildeKontekst> {
  try {
    const out = (await ai.run(ORDREMOTTAKER_VISION_MODEL, {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageDataUrl } },
            { type: 'text', text: visionPrompt() },
          ],
        },
      ],
    })) as { response?: string } | string;
    const raatekst = typeof out === 'string' ? out : (out?.response ?? '');
    return {
      r43: normaliserR43Loose(raatekst),
      skilt: normaliserSkilt(raatekst),
      raatekst,
    };
  } catch (e) {
    console.error('lesBildeKontekst feilet:', e);
    return { r43: null, skilt: null, raatekst: '' };
  }
}

export interface R43GlassTreff {
  eurokode: string;
  varenr: string | null;
  kategori: string | null;
  merke: string | null;
  modell: string | null;
  bekreftet: number;
  varenavn?: string | null;
  pris?: number | null;
}

/** Slå opp 43R-nummer i ece_r43 + berik med varenavn/pris fra glass_catalog. */
export async function slåOppR43(env: Env, r43: string): Promise<R43GlassTreff[] | null> {
  try {
    const { results } = await env.GLASS_CATALOG_D1.prepare(
      `SELECT r43_nummer, eurokode, varenr, kategori, merke, modell, bekreftet
       FROM ece_r43 WHERE r43_nummer = ? ORDER BY bekreftet DESC, id ASC LIMIT 5`
    ).bind(r43).all();
    if (!results || results.length === 0) return null;
    const ut = await Promise.all(
      results.map(async (r: any) => {
        const rekord = await queryByEurocode(env.GLASS_CATALOG_D1, r.eurokode || '');
        return {
          eurokode: String(r.eurokode ?? ''),
          varenr: r.varenr ?? null,
          kategori: r.kategori ?? null,
          merke: r.merke ?? null,
          modell: r.modell ?? null,
          bekreftet: Number(r.bekreftet ?? 0),
          varenavn: rekord?.description ?? null,
          pris: rekord?.price ?? null,
        };
      })
    );
    return ut;
  } catch (e) {
    console.error('slåOppR43 feilet:', e);
    return null;
  }
}

export interface SkiltBil {
  merke: string;
  modell: string;
  aar: number | null;
  vin: string | null;
}

/** SVV-enkeltoppslag (kjennemerke → bil) — samme mønster som FinnBilGlass src/svv.ts. */
export async function slåOppSkilt(env: Env, skilt: string): Promise<SkiltBil | null> {
  const apiKey = env.SVV_API_KEY;
  if (!apiKey) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(
      `https://akfell-datautlevering.atlas.vegvesen.no/enkeltoppslag/kjoretoydata?kjennemerke=${encodeURIComponent(skilt)}`,
      {
        signal: ctrl.signal,
        headers: {
          Accept: 'application/json',
          'SVV-Authorization': `Apikey ${apiKey}`,
          'User-Agent': 'Autoglass-ordremottaker/1.0',
        },
      }
    );
    if (!res.ok || res.status === 204) return null;
    const data = (await res.json()) as {
      kjoretoydataListe?: Array<{
        kjoretoyId?: { understellsnummer?: string };
        forstegangsregistrering?: { registrertForstegangNorgeDato?: string };
        godkjenning?: {
          tekniskGodkjenning?: {
            tekniskeData?: {
              generelt?: {
                merke?: Array<{ merke: string }>;
                handelsbetegnelse?: Array<string>;
              };
            };
          };
        };
      }>;
    };
    const k = data.kjoretoydataListe?.[0];
    if (!k) return null;
    const g = k.godkjenning?.tekniskGodkjenning?.tekniskeData?.generelt;
    const merkeRaw = (g?.merke?.[0]?.merke ?? '').trim().toUpperCase();
    const merke = merkeRaw === 'MERCEDES-BENZ' ? 'MERCEDES' : merkeRaw === 'VOLKSWAGEN' ? 'VW' : merkeRaw;
    const modell = (g?.handelsbetegnelse?.[0] ?? '').trim().toUpperCase();
    if (!merke) return null;
    const regDato = k.forstegangsregistrering?.registrertForstegangNorgeDato ?? '';
    const aar = regDato ? parseInt(regDato.slice(0, 4), 10) : null;
    return {
      merke,
      modell,
      aar: aar && aar > 1900 && aar < 2100 ? aar : null,
      vin: k.kjoretoyId?.understellsnummer ?? null,
    };
  } catch (e) {
    console.error('slåOppSkilt feilet:', e);
    return null;
  } finally {
    clearTimeout(t);
  }
}
