import { useState, useRef, useCallback } from 'react';
import { Camera, X, Loader2, ScanLine, AlertCircle, Check, ShieldCheck, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { fetchApi } from '@/api/client';

interface VerifyTreff {
  r43_nummer: string;
  landkode: string;
  eurokode: string | null;
  varenr: string | null;
  merke: string | null;
  modell: string | null;
  kilde: string;
  bekreftet: number;
  varenavn?: string | null;
  pris?: number | null;
  article_number?: string | null;
}

interface VerifyResponse {
  ok: boolean;
  queryRef: string;
  r43Nummer: string | null;
  observasjon: {
    r43Numbers?: Array<{ value: string; confidence: number }>;
    warnings?: string[];
  };
  treff: VerifyTreff[];
  fusion: {
    outcome: 'PINPOINT' | 'VERIFY' | 'FALLBACK' | 'MANUAL_REVIEW';
    confidence: number;
    winner: { glassId: string; label?: string; priceTier?: number | null } | null;
  } | null;
  melding: string;
}

const MAX_FILE_MB = 5;

function formatPris(n: number | null | undefined): string {
  if (n == null || n <= 0) return 'Pris på forespørsel';
  return n.toLocaleString('nb-NO', { style: 'currency', currency: 'NOK', maximumFractionDigits: 0 });
}

function outcomeBadge(outcome: NonNullable<VerifyResponse['fusion']>['outcome']): { label: string; cls: string } {
  switch (outcome) {
    case 'PINPOINT':
      return { label: '✓ Bekreftet', cls: 'bg-emerald-100 text-emerald-800 border-emerald-300' };
    case 'VERIFY':
      return { label: 'Kontroller variant', cls: 'bg-amber-100 text-amber-800 border-amber-300' };
    case 'MANUAL_REVIEW':
      return { label: 'Må sjekkes manuelt', cls: 'bg-red-100 text-red-800 border-red-300' };
    default:
      return { label: 'Familie-treff', cls: 'bg-gray-100 text-gray-700 border-gray-300' };
  }
}

/**
 * ECE R43-verifisering (B2B): verkstedet fotograferer 43R-godkjenningsmerket
 * på kundens gamle glass — eller skriver nummeret manuelt — og får bekreftet
 * hvilket glass som sitter i bilen FØR bestilling. Bildet prosesseres og
 * slettes; kun nummeret lagres (GDPR).
 */
export function VerifyR43() {
  const [open, setOpen] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const [manuell, setManuell] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [feil, setFeil] = useState<string | null>(null);
  const [svar, setSvar] = useState<VerifyResponse | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = useCallback((file: File | undefined | null) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setFeil('Filen må være et bilde (JPG/PNG/WebP)');
      return;
    }
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      setFeil(`Bildet er over ${MAX_FILE_MB} MB — ta et nytt bilde med mobilen`);
      return;
    }
    setFeil(null);
    setStatus('idle');
    setSvar(null);
    const reader = new FileReader();
    reader.onload = () => setImage(typeof reader.result === 'string' ? reader.result : null);
    reader.readAsDataURL(file);
  }, []);

  const verifySend = useCallback(async () => {
    setFeil(null);
    if (!image && !manuell.trim()) {
      setFeil('Last opp et bilde eller skriv 43R-nummeret manuelt');
      return;
    }
    if (manuell.trim() && !/43R/i.test(manuell) && !/^\d{4,7}$/.test(manuell.trim())) {
      setFeil('Nummeret må se ut som 43R-004592 (eller bare sifrene)');
      return;
    }
    setStatus('loading');
    setSvar(null);
    try {
      const body: Record<string, unknown> = {
        queryRef: `b2b-${Date.now()}`,
        role: 'corner_marking',
      };
      if (image) body.image = image;
      if (manuell.trim()) body.r43 = manuell.trim();
      const res = await fetchApi<VerifyResponse>('/api/verify-glass', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setSvar(res);
      setStatus('done');
    } catch (e) {
      setStatus('error');
      setFeil(e instanceof Error ? e.message : 'Klarte ikke å verifisere nummeret. Prøv igjen.');
    }
  }, [image, manuell]);

  const reset = useCallback(() => {
    setImage(null);
    setManuell('');
    setSvar(null);
    setStatus('idle');
    setFeil(null);
  }, []);

  const badge = svar?.fusion ? outcomeBadge(svar.fusion.outcome) : null;

  return (
    <div className="rounded-xl border border-dashed border-autoglass-blue/40 bg-white overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3.5 hover:bg-autoglass-blue/5 transition text-left"
        aria-expanded={open}
      >
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-autoglass-blue/10 text-autoglass-blue">
            <ShieldCheck className="h-5 w-5" />
          </span>
          <div>
            <p className="text-sm font-semibold text-gray-900">Verifiser glasset med 43R-merket</p>
            <p className="text-xs text-gray-500">
              Fotografer godkjenningsmerket i hjørnet av det gamle glasset — få bekreftet eksakt glass før bestilling
            </p>
          </div>
        </div>
        {open ? <ChevronUp className="h-5 w-5 text-gray-400" /> : <ChevronDown className="h-5 w-5 text-gray-400" />}
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-gray-100 pt-3">
          <div className="text-xs text-gray-500 mb-3 leading-relaxed">
            Merket sitter i nederkant av frontruten, oftest i førerens hjørne: en sirkel med <b>E1</b> og et nummer som{' '}
            <span className="font-mono">43R-004592</span>. Tørk av glasset utenpå, legg et hvitt ark inni mot merket og ta
            bildet fra utsiden.
          </div>

          <div className="flex flex-col sm:flex-row gap-2 mb-3">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0])}
            />
            {image ? (
              <div className="relative w-full sm:w-40 h-24 rounded-lg overflow-hidden border border-gray-200">
                <img src={image} alt="43R-merket" className="w-full h-full object-cover" />
                <button
                  type="button"
                  onClick={() => { setImage(null); setSvar(null); setStatus('idle'); }}
                  className="absolute top-1 right-1 p-1 rounded-full bg-black/60 text-white hover:bg-black/80"
                  aria-label="Fjern bilde"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()} className="gap-2">
                <Camera className="h-4 w-4" /> Ta bilde / last opp
              </Button>
            )}
            <div className="flex items-center gap-2 flex-1">
              <div className="relative flex-1">
                <ScanLine className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  value={manuell}
                  onChange={(e) => setManuell(e.target.value)}
                  placeholder="eller skriv: 43R-004592"
                  className="w-full h-10 pl-9 pr-3 text-sm bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-autoglass-blue/30 focus:border-autoglass-blue"
                />
              </div>
              <Button type="button" size="sm" onClick={verifySend} disabled={status === 'loading'} className="gap-2 flex-shrink-0">
                {status === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Verifiser
              </Button>
            </div>
          </div>

          {feil && (
            <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>{feil}</span>
            </div>
          )}

          {status === 'done' && svar && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {badge && <span className={cn('text-xs font-semibold px-2.5 py-1 rounded-full border', badge.cls)}>{badge.label}</span>}
                  {svar.r43Nummer && <span className="font-mono text-sm text-gray-600">{svar.r43Nummer}</span>}
                </div>
                <button type="button" onClick={reset} className="text-xs text-gray-400 hover:text-gray-600">
                  Start på nytt
                </button>
              </div>

              <p className="text-sm text-gray-700">{svar.melding}</p>

              {svar.treff.length === 0 && (
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
                  Ingen treff i 43R-mappingen ennå. Søk glasset på bilen som vanlig — og send nummeret til Autoglass så
                  bygger vi katalogen videre.
                </div>
              )}

              {svar.treff.length > 0 && (
                <div className="space-y-2">
                  {svar.treff.map((t, i) => (
                    <div key={i} className="rounded-lg border border-gray-200 px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-gray-900 truncate">{t.varenavn || t.varenr || t.eurokode}</p>
                          {t.eurokode && <p className="text-xs text-gray-500 font-mono mt-0.5">{t.eurokode}</p>}
                          {(t.merke || t.modell) && (
                            <p className="text-xs text-gray-500 mt-0.5">
                              {[t.merke, t.modell].filter(Boolean).join(' ')}
                            </p>
                          )}
                          {t.bekreftet === 1 && (
                            <p className="text-[11px] text-emerald-700 flex items-center gap-1 mt-1">
                              <Check className="h-3 w-3" /> Verifisert av Autoglass
                            </p>
                          )}
                        </div>
                        <p className="text-sm font-semibold text-autoglass-blue whitespace-nowrap">{formatPris(t.pris)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <p className="text-[11px] text-gray-400 mt-3">
            Bildet brukes kun til å lese nummeret og slettes umiddelbart. Kun nummeret lagres i søkeloggen.
          </p>
        </div>
      )}
    </div>
  );
}
