/**
 * FASE 6 — Evidence fusion (KLA-301).
 *
 * Eksplisitt beslutningsmotor: AI- og datasignaler FUSJONERES her.
 * AI returnerer aldri «riktig varenummer» direkte — kun signaler.
 * Regler er deterministiske og forklarbare; hver avgjørelse kan
 * rekonstrueres fra FusionResult.evidence.
 *
 * Utfall: PINPOINT / VERIFY / FALLBACK / MANUAL_REVIEW
 */

export type EvidenceType =
  | 'oem_build'          // VIN/build-data → OEM-frontrutenummer (høyest vekt)
  | 'vin_ktype'          // VIN → kType
  | 'ocr_eurocode'       // OCR av eurocode på glasset
  | 'ocr_oem'            // OCR av OEM-nummer på glasset
  | 'ocr_r43'            // OCR av ECE R43-approval-nummer på glasset (fysisk bevis, familie-nivå)
  | 'feature_data'       // strukturert feature-data (katalog/build)
  | 'image_feature'      // bilde-basert feature-deteksjon (CV)
  | 'visual_similarity'  // generell visuell likhet (lav vekt)
  | 'manual_verification'; // manuelt verifisert (menneske)

export type SignalDirection = 'positive' | 'negative' | 'unknown';

export interface EvidenceSignal {
  type: EvidenceType;
  /** Normalisert verdi: eurocode / OEM-nummer / feature-navn+verdi («camera:true») / ktype */
  value: string;
  confidence: number; // 0..1
  direction: SignalDirection;
  sourceId?: string;
  inputHash?: string;
  modelVersion?: string;
  explanation?: string;
}

export interface FusionCandidate {
  glassId: string;
  eurocode: string | null;
  oemNumbers: string[];
  /** ECE R43-approval-numre for glasset/familien (normalisert: siffer, uten 43R-prefiks/landkode). */
  r43Numbers: string[];
  /** feature → kjent verdi; null = ukjent */
  features: Record<string, boolean | null>;
  /** Har salgbart FinnBilGlass-varenr i prislisten */
  sellable: boolean;
  priceTier: number | null;
  label?: string;
}

export type FusionOutcome = 'PINPOINT' | 'VERIFY' | 'FALLBACK' | 'MANUAL_REVIEW';

export interface FusionResult {
  outcome: FusionOutcome;
  reason: string;
  confidence: number;
  winner: FusionCandidate | null;
  candidates: FusionCandidate[];
  eliminated: Array<{ glassId: string; reason: string }>;
  signals: EvidenceSignal[];
  engineVersion: string;
}

export const ENGINE_VERSION = 'evidence-fusion-1.0';

/** Signalvekter (oppdragsgitt). */
export const WEIGHTS: Record<EvidenceType, number> = {
  oem_build: 1.0,
  vin_ktype: 0.9,
  ocr_eurocode: 0.9,
  ocr_oem: 0.85,
  ocr_r43: 0.95, // fysisk bevis fra selve glasset — men familie-nivå (ett nummer kan dekke flere koder)
  feature_data: 0.65,
  image_feature: 0.5,
  visual_similarity: 0.2,
  manual_verification: 1.0,
};

/** Features der MOTSTRID = hard stop (MANUAL_REVIEW), aldri gjetting. */
export const HARD_STOP_FEATURES = ['camera', 'hud', 'heated', 'rain_sensor'];

const FEATURE_SIGNAL_RE = /^([a-z_]+):(true|false)$/;

function featureSignal(s: EvidenceSignal): { feature: string; value: boolean; confidence: number } | null {
  if (s.type !== 'feature_data' && s.type !== 'image_feature') return null;
  const m = FEATURE_SIGNAL_RE.exec(s.value);
  if (!m) return null;
  return { feature: m[1], value: m[2] === 'true', confidence: s.confidence };
}

/** Signal som bærer en identitets-kode (eurocode/OEM/ktype). */
function identityValue(s: EvidenceSignal): string | null {
  if (s.direction !== 'positive') return null;
  switch (s.type) {
    case 'ocr_eurocode':
      return normalizeEurocode(s.value);
    case 'ocr_oem':
      return s.value.trim().toUpperCase();
    case 'ocr_r43':
      return `R43:${normalizeR43(s.value) ?? s.value.trim().toUpperCase()}`;
    case 'vin_ktype':
      return `KTYPE:${s.value.trim().toUpperCase()}`;
    case 'oem_build':
      return `OEM:${s.value.trim().toUpperCase()}`;
    default:
      return null;
  }
}

/**
 * Normaliserer et ECE R43-approval-nummer til sifferform.
 * «43R-004592», «43R 004592», «E1 43R004592» → «004592».
 * Returnerer null hvis ingen gyldig 43R-sekvens finnes (4-7 siffer).
 */
export function normalizeR43(raw: string): string | null {
  const m = /43R\s*[-–—]?\s*(\d{4,7})/i.exec(raw || '');
  if (!m) return null;
  return m[1];
}

/** Normaliserer eurocode: strip bindestreker/mellomrom. Faktisk format i våre data:
 *  8-15 tegn (fasit: 8579ACSGYAVZ1B=14, 2525CSGYA=9). Krav: 6-17 tegn, minst 2 bokstaver. */
export function normalizeEurocode(raw: string): string | null {
  const c = (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length < 6 || c.length > 17) return null;
  if ((c.match(/[A-Z]/g) ?? []).length < 2) return null;
  return c;
}

function candidateMatchesIdentity(c: FusionCandidate, ident: string): boolean {
  if (ident.startsWith('OEM:')) return c.oemNumbers.includes(ident.slice(4));
  if (ident.startsWith('R43:')) return c.r43Numbers.includes(ident.slice(4));
  if (ident.startsWith('KTYPE:')) return false; // ktype er kjøretøy-nivå, ikke glass-nivå her
  const ec = normalizeEurocode(ident);
  return ec !== null && normalizeEurocode(c.eurocode ?? '') === ec;
}

/** Hard stop #1: motstridende feature-status mot kandidat med kjent verdi. */
function conflictingFeature(
  c: FusionCandidate,
  fs: { feature: string; value: boolean; confidence: number },
): boolean {
  const kjent = c.features[fs.feature];
  if (kjent == null) return false; // ukjent hos kandidaten — ingen konflikt
  if (HARD_STOP_FEATURES.includes(fs.feature) && kjent !== fs.value && fs.confidence >= 0.6) {
    return true;
  }
  return kjent !== fs.value && fs.confidence >= 0.8;
}

/**
 * Beslutningsmotoren.
 * @param candidates   aktuelle kandidater (fra resolver-lagene)
 * @param signals      alle evidens-signaler (build/OCR/CV/feature)
 */
export function fuseEvidence(candidates: FusionCandidate[], signals: EvidenceSignal[]): FusionResult {
  const engineVersion = ENGINE_VERSION;

  if (candidates.length === 0) {
    return {
      outcome: 'FALLBACK',
      reason: 'ingen resolver-kandidater — data mangler',
      confidence: 0,
      winner: null,
      candidates: [],
      eliminated: [],
      signals,
      engineVersion,
    };
  }

  // 1) Internt motstridende høy-vektsignaler → MANUAL_REVIEW (før alt annet).
  const byType = new Map<EvidenceType, EvidenceSignal[]>();
  for (const s of signals) byType.set(s.type, [...(byType.get(s.type) ?? []), s]);
  for (const [type, list] of byType) {
    if (type !== 'ocr_eurocode' && type !== 'ocr_oem' && type !== 'ocr_r43' && type !== 'feature_data') continue;
    const vals = [...new Set(list.filter((s) => s.confidence >= 0.7).map((s) => s.value))];
    if (vals.length > 1 && !(type === 'feature_data')) {
      return {
        outcome: 'MANUAL_REVIEW',
        reason: `motstridende ${type}-signaler: ${vals.join(' vs ')}`,
        confidence: 0,
        winner: null,
        candidates,
        eliminated: [],
        signals,
        engineVersion,
      };
    }
  }

  // 2) Eliminering: hard stops + negative bevis.
  const eliminated: Array<{ glassId: string; reason: string }> = [];
  const alive = candidates.filter((c) => {
    for (const s of signals) {
      if (s.direction === 'negative') {
        const ident = identityValue({ ...s, direction: 'positive' });
        if (ident && candidateMatchesIdentity(c, ident)) {
          eliminated.push({ glassId: c.glassId, reason: `negativt bevis: ${s.type}=${s.value}` });
          return false;
        }
      }
      const fs = featureSignal(s);
      if (fs && conflictingFeature(c, fs)) {
        eliminated.push({
          glassId: c.glassId,
          reason: `hard stop: ${fs.feature} motstridende (kandidat=${c.features[fs.feature]}, signal=${fs.value})`,
        });
        return false;
      }
    }
    if (!c.sellable) {
      eliminated.push({ glassId: c.glassId, reason: 'manglende salgbart varenr i prislisten' });
      return false;
    }
    return true;
  });

  if (alive.length === 0) {
    const hardStopConflict = eliminated.some((e) => e.reason.startsWith('hard stop'));
    return {
      outcome: hardStopConflict ? 'MANUAL_REVIEW' : 'FALLBACK',
      reason:
        hardStopConflict
          ? 'alle kandidater motstridende på hard-stop-feature'
          : 'alle kandidater eliminert — manglende salgbart varenr eller negativt bevis',
      confidence: 0,
      winner: null,
      candidates: alive,
      eliminated,
      signals,
      engineVersion,
    };
  }

  // 3) Scoring: vektet evidens per kandidat.
  const scored = alive.map((c) => {
    let score = 0;
    const matches: string[] = [];
    for (const s of signals) {
      const ident = identityValue(s);
      if (ident) {
        if (ident.startsWith('KTYPE:')) continue; // ktype skåres via vehicle_links, ikke her
        if (candidateMatchesIdentity(c, ident)) {
          score += WEIGHTS[s.type] * s.confidence;
          matches.push(`${s.type}=${s.value}`);
        }
      }
      const fs = featureSignal(s);
      if (fs) {
        const kjent = c.features[fs.feature];
        if (kjent === fs.value) {
          score += WEIGHTS[s.type] * s.confidence;
          matches.push(`${fs.feature}=${fs.value}`);
        }
      }
      if (s.type === 'visual_similarity' && s.direction === 'positive' && s.value === c.glassId) {
        score += WEIGHTS.visual_similarity * s.confidence;
        matches.push(`visual=${c.glassId}`);
      }
    }
    return { c, score, matches };
  }).sort((a, b) => b.score - a.score);

  const [top, second] = scored;
  const margin = top.score - (second?.score ?? 0);

  // 4) PINPOINT — alle obligatoriske bevis enige + klar margin + høyvektsbevis.
  const highWeightEvidence = top.matches.filter((m) =>
    m.startsWith('oem_build') || m.startsWith('ocr_eurocode') || m.startsWith('ocr_r43') || m.startsWith('manual') || m.startsWith('vin_ktype'),
  );
  const hasHighWeight = highWeightEvidence.length > 0;

  if (scored.length === 1 && hasHighWeight && top.score >= 0.8 && margin >= 0.3) {
    return {
      outcome: 'PINPOINT',
      reason: `entydig: ${top.matches.join(' + ')}`,
      confidence: Math.min(1, top.score),
      winner: top.c,
      candidates: alive,
      eliminated,
      signals,
      engineVersion,
    };
  }

  // 5) VERIFY — kandidater finnes, men noe må avklares.
  return {
    outcome: 'VERIFY',
    reason: !hasHighWeight
      ? 'kandidater finnes, men mangler høyvektsbevis (OEM/Eurocode/manuell verifisering)'
      : `${scored.length} kandidater innenfor margin (${margin.toFixed(2)}) — feature/build-data må avklares`,
    confidence: Math.min(0.5, top.score),
    winner: null,
    candidates: alive,
    eliminated,
    signals,
    engineVersion,
  };
}

/** Bekvemmelighet: bygg signal fra AI/CV-lagene (validerer aldri alene). */
export function makeSignal(
  type: EvidenceType,
  value: string,
  confidence: number,
  direction: SignalDirection = 'positive',
  extra: Partial<EvidenceSignal> = {},
): EvidenceSignal {
  return { type, value, confidence: Math.max(0, Math.min(1, confidence)), direction, ...extra };
}
