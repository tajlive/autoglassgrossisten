import { describe, expect, it } from 'vitest';
import { handleVerifyGlass } from './verify-glass';

/** Minimal D1-mock som dekker det verify-glass bruker. */
function mockD1() {
  const eceRader = [
    {
      r43_nummer: '004592',
      landkode: 'E1',
      eurokode: '8579AGSGYAVZ1B',
      varenr: '8579AGSGYAVZ1B',
      merke: 'VW',
      modell: 'TRANSPORTER T5 2003-',
      kilde: 'manual',
      bekreftet: 1,
    },
  ];
  const glassRecord = {
    eurocode: '8579AGSGYAVZ1B',
    article_number: '8579AGSGYAVZ1B',
    description: 'Frontrute VW TRANSPORTER T5 03-',
    price: 5490,
    brand: 'VW',
    model: 'TRANSPORTER T5',
  };
  return {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async all() {
              if (sql.includes('FROM ece_r43')) return { results: eceRader };
              if (sql.includes('FROM glass_catalog')) return { results: [glassRecord] };
              return { results: [] };
            },
            async run() {
              return { success: true };
            },
          };
        },
      };
    },
  };
}

function mockEnv() {
  return {
    GLASS_CATALOG_D1: mockD1(),
    AI: {} as Ai,
  } as unknown as import('../types').Env;
}

describe('handleVerifyGlass (ECE R43, B2B)', () => {
  it('400 uten image eller r43', async () => {
    const res = await handleVerifyGlass(
      new Request('https://auto-glass.no/api/verify-glass', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      }),
      mockEnv()
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect((body as { error: string }).error).toContain('påkrevd');
  });

  it('manuell r43 gir treff fra ece_r43 + glass_catalog-berikelse', async () => {
    const res = await handleVerifyGlass(
      new Request('https://auto-glass.no/api/verify-glass', {
        method: 'POST',
        body: JSON.stringify({ r43: '43R-004592', merke: 'VW', modell: 'TRANSPORTER' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      mockEnv()
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      r43Nummer: string;
      treff: Array<{ eurokode: string; varenavn?: string; pris?: number }>;
      fusion: { outcome: string } | null;
      melding: string;
    };
    expect(body.ok).toBe(true);
    expect(body.r43Nummer).toBe('43R-004592');
    expect(body.treff).toHaveLength(1);
    expect(body.treff[0].eurokode).toBe('8579AGSGYAVZ1B');
    expect(body.treff[0].varenavn).toContain('TRANSPORTER');
    expect(body.treff[0].pris).toBe(5490);
    expect(body.fusion?.outcome).toBe('PINPOINT');
    expect(body.melding).toContain('Bekreftet');
  });

  it('dataURL må starte med data:image/', async () => {
    const res = await handleVerifyGlass(
      new Request('https://auto-glass.no/api/verify-glass', {
        method: 'POST',
        body: JSON.stringify({ image: 'https://eksempel.no/bilde.png' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      mockEnv()
    );
    expect(res.status).toBe(400);
  });
});
