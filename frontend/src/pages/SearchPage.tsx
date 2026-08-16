import { useState, useEffect, lazy, Suspense, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2, Car, X } from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';

import { PageMeta } from '@/components/seo/PageMeta';
import { Button } from '@/components/ui/Button';
import type { Product } from '@/types/api';

import { detectInputType, getPlaceholderForType, type InputType } from '@/components/search/UnifiedSearch/InputTypeDetector';
import {
  RegnrSearchIcon,
  EurocodeSearchIcon,
  OeNumberSearchIcon,
  VehicleWizardIcon,
  ProfessorSearchIcon,
  SearchLensIcon,
  BarcodeIcon,
} from '@/components/icons/SearchIcons';
import { ResultSkeleton } from '@/components/search/ResultSkeleton';

const RegnrResults = lazy(() =>
  import('@/components/search/results/RegnrResults').then((m) => ({ default: m.RegnrResults }))
);
const VinResults = lazy(() =>
  import('@/components/search/results/VinResults').then((m) => ({ default: m.VinResults }))
);
const IdentifierResults = lazy(() =>
  import('@/components/search/results/IdentifierResults').then((m) => ({ default: m.IdentifierResults }))
);
const CatalogResults = lazy(() =>
  import('@/components/search/results/CatalogResults').then((m) => ({ default: m.CatalogResults }))
);
const VerifyR43 = lazy(() =>
  import('@/components/search/VerifyR43').then((m) => ({ default: m.VerifyR43 }))
);
const VehicleWizard = lazy(() => import('@/components/search/VehicleWizard').then((m) => ({ default: m.VehicleWizard })));
const ProductDetail = lazy(() => import('@/components/catalog/ProductDetail').then((m) => ({ default: m.ProductDetail })));

const RECENT_SEARCHES_KEY = 'ag_recent_searches';
const MAX_RECENT = 5;

function getRecentSearches(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_SEARCHES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

const typeBadgeColor: Record<InputType, string> = {
  regnr: 'bg-amber-50 text-amber-700 border-amber-200',
  eurocode: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  sku: 'bg-blue-50 text-blue-700 border-blue-200',
  oe: 'bg-purple-50 text-purple-700 border-purple-200',
  vin: 'bg-cyan-50 text-cyan-700 border-cyan-200',
  text: 'bg-gray-50 text-gray-600 border-gray-200',
  empty: '',
};

/* ========================================================================
   SearchShell — Lightweight shell. Result components are lazy-loaded.
   ======================================================================== */

export default function SearchPage() {
  const { openChat } = useChatStore();
  const [searchParams, setSearchParams] = useSearchParams();

  /* ---- unified input state ---- */
  const initialQuery = searchParams.get('q') ?? '';
  const [inputValue, setInputValue] = useState(initialQuery);
  const [detectedType, setDetectedType] = useState<InputType>('empty');
  const [activeQuery, setActiveQuery] = useState('');
  const [activeQueryType, setActiveQueryType] = useState<InputType>('empty');
  const [showRecent, setShowRecent] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [detailProduct, setDetailProduct] = useState<Product | null>(null);
  const [recentSearches, setRecentSearches] = useState<string[]>(getRecentSearches);

  const addRecentSearch = useCallback((query: string) => {
    const normalized = query.trim();
    if (normalized.length < 2) return;
    setRecentSearches((prev) => {
      const next = [normalized, ...prev.filter((r) => r.toLowerCase() !== normalized.toLowerCase())].slice(0, MAX_RECENT);
      localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  /* ---- auto-detect input type ---- */
  useEffect(() => {
    const detected = detectInputType(inputValue);
    setDetectedType(detected.type);
  }, [inputValue]);

  /* ---- submit handler ---- */
  const handleSubmit = useCallback((e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = inputValue.trim();
    if (trimmed.length < 2) return;

    const detected = detectInputType(trimmed);
    setActiveQuery(trimmed);
    setActiveQueryType(detected.type);
    setShowRecent(false);
    addRecentSearch(trimmed);

    const params = new URLSearchParams();
    params.set('q', trimmed);
    setSearchParams(params);
  }, [inputValue, setSearchParams]);

  /* ---- clear handler ---- */
  const handleClear = useCallback(() => {
    setInputValue('');
    setActiveQuery('');
    setActiveQueryType('empty');
    setSearchParams({});
    setShowRecent(false);
  }, [setSearchParams]);

  /* ---- recent search select ---- */
  const handleSelectRecent = useCallback((r: string) => {
    setInputValue(r);
    const detected = detectInputType(r);
    setActiveQuery(r);
    setActiveQueryType(detected.type);
    setShowRecent(false);
    addRecentSearch(r);
    const params = new URLSearchParams();
    params.set('q', r);
    setSearchParams(params);
  }, [setSearchParams]);

  /* ---- sync from URL ---- */
  useEffect(() => {
    const urlQ = searchParams.get('q') ?? '';
    const urlRegnr = searchParams.get('regnr') ?? '';
    const effectiveQuery = urlQ || urlRegnr;
    if (effectiveQuery && effectiveQuery !== activeQuery) {
      setInputValue(effectiveQuery);
      const detected = detectInputType(effectiveQuery);
      setActiveQuery(effectiveQuery);
      setActiveQueryType(detected.type);
    }
  }, [searchParams, activeQuery]);

  /* ---- quick-action focus helpers ---- */
  const focusWithHint = useCallback((_hint: string, example: string) => {
    setInputValue(example);
    inputRef.current?.focus();
  }, []);

  return (
    <>
      <PageMeta
        title="Søk — finn riktig bilglass"
        description="Søk med registreringsnummer, Eurocode, OE-nummer, VIN, eller merke/modell for å finne eksakt bilglass. Med ADAS-kompatibilitet, regnsensor og kalibrering."
        canonicalPath="/sok"
      />
      <div className="mx-auto max-w-5xl px-3 py-4 sm:px-6 sm:py-8 lg:px-8">

        {/* Header */}
        <div className="mb-6 sm:mb-8">
          <h1 className="text-xl sm:text-3xl font-bold text-gray-900 mb-2">Søk etter bilglass</h1>
          <p className="text-sm sm:text-base text-gray-600">
            Skriv inn regnr, Eurocode, OE-nummer, VIN — eller beskriv glasset du trenger.
          </p>
        </div>

        {/* Unified Search Bar */}
        <div className="relative mb-4">
          <form onSubmit={handleSubmit} className="flex gap-2">
            <div className="relative flex-1">
              <div className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                {detectedType === 'regnr' ? <RegnrSearchIcon className="h-5 w-5" /> :
                 detectedType === 'eurocode' ? <EurocodeSearchIcon className="h-5 w-5" /> :
                 detectedType === 'sku' ? <BarcodeIcon className="h-5 w-5" /> :
                 detectedType === 'oe' ? <OeNumberSearchIcon className="h-5 w-5" /> :
                 detectedType === 'vin' ? <Car className="h-5 w-5" /> :
                 <SearchLensIcon className="h-5 w-5" />}
              </div>
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onFocus={() => setShowRecent(true)}
                placeholder={getPlaceholderForType(detectedType)}
                className="w-full h-14 pl-11 pr-24 text-lg bg-white border border-gray-300 rounded-xl
                           focus:outline-none focus:ring-2 focus:ring-autoglass-blue/30 focus:border-autoglass-blue
                           transition shadow-sm"
                autoComplete="off"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
                {inputValue && (
                  <button
                    type="button"
                    onClick={() => { setInputValue(''); inputRef.current?.focus(); }}
                    className="p-1 text-gray-400 hover:text-gray-600 transition"
                    aria-label="Tøm søkefelt"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
                {detectedType !== 'empty' && (
                  <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border hidden sm:inline-block ${typeBadgeColor[detectedType]}`}>
                    {detectedType === 'regnr' ? 'Regnr' :
                     detectedType === 'eurocode' ? 'Eurocode' :
                     detectedType === 'sku' ? 'SKU' :
                     detectedType === 'oe' ? 'OE' :
                     detectedType === 'vin' ? 'VIN' :
                     detectedType === 'text' ? 'Fritekst' : ''}
                  </span>
                )}
              </div>
            </div>
            <Button
              type="submit"
              size="lg"
              className="h-14 px-5 sm:px-6 gap-2 flex-shrink-0 rounded-xl"
              disabled={inputValue.trim().length < 2}
            >
              <SearchLensIcon className="h-5 w-5" />
              <span className="hidden sm:inline">Søk</span>
            </Button>
          </form>

          {/* Recent searches dropdown */}
          {showRecent && recentSearches.length > 0 && !activeQuery && (
            <div
              className="absolute z-50 w-full mt-2 bg-white rounded-xl border border-gray-200 shadow-lg overflow-hidden"
              onMouseDown={(e) => e.preventDefault()}
            >
              <div className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-100">
                Siste søk
              </div>
              {recentSearches.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => handleSelectRecent(r)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition"
                >
                  <SearchLensIcon className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
                  <span className="font-mono">{r}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Quick Action Buttons */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 sm:gap-3 mb-6 sm:mb-8">
          <button
            type="button"
            onClick={() => focusWithHint('regnr', '')}
            className="group flex flex-col items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-3
                       hover:border-amber-300 hover:bg-amber-50/50 transition text-center"
          >
            <RegnrSearchIcon className="h-7 w-7 text-gray-600 group-hover:text-amber-600 transition" />
            <span className="text-xs font-medium text-gray-700 group-hover:text-amber-700">Regnr</span>
          </button>
          <button
            type="button"
            onClick={() => focusWithHint('eurocode', '')}
            className="group flex flex-col items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-3
                       hover:border-emerald-300 hover:bg-emerald-50/50 transition text-center"
          >
            <EurocodeSearchIcon className="h-7 w-7 text-gray-600 group-hover:text-emerald-600 transition" />
            <span className="text-xs font-medium text-gray-700 group-hover:text-emerald-700">Eurocode</span>
          </button>
          <button
            type="button"
            onClick={() => focusWithHint('oe', '')}
            className="group flex flex-col items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-3
                       hover:border-purple-300 hover:bg-purple-50/50 transition text-center"
          >
            <OeNumberSearchIcon className="h-7 w-7 text-gray-600 group-hover:text-purple-600 transition" />
            <span className="text-xs font-medium text-gray-700 group-hover:text-purple-700">OE-nummer</span>
          </button>
          <button
            type="button"
            onClick={() => setShowWizard(true)}
            className="group flex flex-col items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-3
                       hover:border-autoglass-blue/30 hover:bg-autoglass-blue/5 transition text-center"
          >
            <VehicleWizardIcon className="h-7 w-7 text-gray-600 group-hover:text-autoglass-blue transition" />
            <span className="text-xs font-medium text-gray-700 group-hover:text-autoglass-blue">Merke / modell</span>
          </button>
          <button
            type="button"
            onClick={() => openChat()}
            className="group flex flex-col items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-3
                       hover:border-gray-400 hover:bg-gray-50 transition text-center"
          >
            <ProfessorSearchIcon className="h-7 w-7 text-gray-600 group-hover:text-gray-800 transition" />
            <span className="text-xs font-medium text-gray-700 group-hover:text-gray-900">Professor</span>
          </button>
        </div>

        {/* ECE R43-verifisering (foto av godkjenningsmerket) */}
        <div className="mb-6 sm:mb-8">
          <VerifyR43 />
        </div>

        {/* ═══════════════════════════════════════════════════════════
            LAZY-LOADED RESULT COMPONENTS
            ═══════════════════════════════════════════════════════════ */}

        {activeQueryType === 'regnr' && activeQuery && (
          <Suspense fallback={<ResultSkeleton />}>
            <RegnrResults activeQuery={activeQuery} onClear={handleClear} onDetail={setDetailProduct} />
          </Suspense>
        )}

        {activeQueryType === 'vin' && activeQuery && (
          <Suspense fallback={<ResultSkeleton />}>
            <VinResults activeQuery={activeQuery} onClear={handleClear} onDetail={setDetailProduct} />
          </Suspense>
        )}

        {(activeQueryType === 'eurocode' || activeQueryType === 'sku' || activeQueryType === 'oe') && activeQuery && (
          <Suspense fallback={<ResultSkeleton />}>
            <IdentifierResults
              activeQuery={activeQuery}
              queryType={activeQueryType as 'eurocode' | 'sku' | 'oe'}
              onDetail={setDetailProduct}
            />
          </Suspense>
        )}

        {activeQueryType === 'text' && activeQuery && (
          <Suspense fallback={<ResultSkeleton />}>
            <CatalogResults activeQuery={activeQuery} onDetail={setDetailProduct} />
          </Suspense>
        )}

        {/* No query yet */}
        {activeQueryType === 'empty' && (
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-8 text-center">
            <SearchLensIcon className="mx-auto h-10 w-10 text-gray-300 mb-3" />
            <p className="text-gray-500">Skriv inn et søkeord for å finne bilglass</p>
            <p className="text-xs text-gray-400 mt-1">Regnr, VIN, Eurocode, OE-nummer, eller beskrivelse</p>
          </div>
        )}

        {/* Product detail modal */}
        <Suspense fallback={null}>
          <ProductDetail product={detailProduct} onClose={() => setDetailProduct(null)} />
        </Suspense>

        {/* Vehicle Wizard Modal */}
        {showWizard && (
          <div data-testid="vehicle-wizard-modal" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setShowWizard(false)}>
            <div className="w-full max-w-2xl max-h-[85vh] overflow-y-auto bg-white rounded-2xl shadow-2xl p-4 sm:p-6" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-gray-900">Finn glass via merke og modell</h2>
                <button type="button" onClick={() => setShowWizard(false)} className="p-2 text-gray-400 hover:text-gray-600 transition rounded-lg hover:bg-gray-100">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <Suspense fallback={
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-autoglass-blue" />
                </div>
              }>
                <VehicleWizard onComplete={() => setShowWizard(false)} />
              </Suspense>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
