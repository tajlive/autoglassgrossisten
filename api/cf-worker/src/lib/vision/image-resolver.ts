/**
 * AI bilde-resolver (KLA-301).
 *
 * Denne modulen velger aldri glass direkte. Den oversetter AI/CV-output til
 * EvidenceSignal-rader som evidence-fusion kan bruke sammen med OEM/VIN/build.
 *
 * Brukes likt av FinnBilGlass og B2B:
 *   bilde(r) -> VisionProvider -> ImageObservation[] -> EvidenceSignal[] -> fuseEvidence()
 */
import {
  fuseEvidence,
  makeSignal,
  normalizeEurocode,
  normalizeR43,
  type EvidenceSignal,
  type FusionCandidate,
  type FusionResult,
} from './evidence-fusion';

export const IMAGE_RESOLVER_VERSION = 'image-resolver-0.1';

export type GlassPhotoRole =
  | 'corner_marking'  // bilde av rutehjørne/merking: Eurocode/OE/OCR
  | 'mirror_area'     // bilde bak speilet: kamera/sensor/speilbrakett
  | 'full_glass'      // hel frontrute: kun svak visuell sammenligning
  | 'sensor_detail'   // detalj av sensor-/kameraområde
  | 'catalog_image'   // lisensiert katalogbilde brukt som kandidat-referanse
  | 'unknown';

export interface ImageInput {
  id: string;
  role: GlassPhotoRole;
  /** Base64/data URL/R2 URL/leverandør-URL. Provider bestemmer hva den støtter. */
  imageRef: string;
  mime?: string;
  width?: number;
  height?: number;
  sha256?: string;
  source?: 'customer' | 'licensed_catalog' | 'internal_b2b' | 'research';
}

export interface CandidateImageRef {
  glassId: string;
  eurocode: string | null;
  role: GlassPhotoRole;
  imageRef: string;
  sha256?: string;
  sourceId?: string;
  licenseRef: string;
}

export interface VisionFeature {
  name: string;
  value: boolean | null;
  confidence: number;
  explanation?: string;
}

export interface VisionIdentity {
  value: string;
  confidence: number;
  explanation?: string;
}

export interface VisionSimilarity {
  glassId: string;
  confidence: number;
  explanation?: string;
}

export interface ImageObservation {
  imageId: string;
  role: GlassPhotoRole;
  inputHash?: string;
  modelVersion: string;
  rawText?: string;
  eurocodes: VisionIdentity[];
  oemNumbers: VisionIdentity[];
  /** ECE R43-approval-nummer lest av på glasset (f.eks. «43R-004592»). */
  r43Numbers?: VisionIdentity[];
  features: VisionFeature[];
  similarities: VisionSimilarity[];
  warnings: string[];
}

export interface VisionRequest {
  image: ImageInput;
  candidateImages: CandidateImageRef[];
  prompt: string;
}

export interface VisionProvider {
  modelVersion: string;
  observe(request: VisionRequest): Promise<ImageObservation>;
}

export interface ImageResolverInput {
  images: ImageInput[];
  candidates: FusionCandidate[];
  candidateImages?: CandidateImageRef[];
  existingSignals?: EvidenceSignal[];
}

export interface ImageResolverResult {
  outcome: FusionResult['outcome'];
  fusion: FusionResult;
  observations: ImageObservation[];
  imageSignals: EvidenceSignal[];
  resolverVersion: string;
}

const FEATURE_ALIASES: Record<string, string> = {
  adas: 'camera',
  camera: 'camera',
  camera_mount: 'camera',
  lane_assist: 'camera',
  front_assist: 'camera',
  rain: 'rain_sensor',
  rain_sensor: 'rain_sensor',
  light_sensor: 'rain_sensor',
  sensor: 'rain_sensor',
  heated: 'heated',
  heatable: 'heated',
  hud: 'hud',
  head_up_display: 'hud',
  antenna: 'antenna',
  acoustic: 'acoustic',
  solar: 'solar_coated',
  solar_coated: 'solar_coated',
  coated: 'solar_coated',
  mirror: 'mirror_bracket',
  mirror_bracket: 'mirror_bracket',
  vin_window: 'vin_window',
  panoramic: 'panoramic',
};

const HIGH_RISK_FEATURES = new Set(['camera', 'hud', 'heated', 'rain_sensor']);

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function normFeatureName(name: string): string | null {
  const key = (name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return FEATURE_ALIASES[key] ?? null;
}

function normOem(raw: string): string | null {
  const v = (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (v.length < 5 || !/\d/.test(v)) return null;
  return v;
}

function signalConfidence(base: number, role: GlassPhotoRole, kind: 'ocr' | 'feature' | 'similarity'): number {
  let c = clamp(base);
  if (kind === 'ocr' && role !== 'corner_marking') c *= 0.75;
  if (kind === 'feature' && role === 'corner_marking') c *= 0.75;
  if (kind === 'similarity') c = Math.min(c, role === 'full_glass' ? 0.65 : 0.55);
  return Number(c.toFixed(3));
}

export function buildVisionPrompt(image: ImageInput, candidateImages: CandidateImageRef[]): string {
  const candidateList = candidateImages.slice(0, 20).map((c) => ({
    glassId: c.glassId,
    eurocode: c.eurocode,
    role: c.role,
    licenseRef: c.licenseRef,
  }));
  return JSON.stringify({
    task: 'Analyse windshield image for evidence signals only. Do not select a final product.',
    imageRole: image.role,
    requiredOutput: {
      r43: { value: 'string som 43R-004592 eller null', confidence: '0..1', explanation: 'short' },
      eurocodes: [{ value: 'string', confidence: '0..1', explanation: 'short' }],
      oemNumbers: [{ value: 'string', confidence: '0..1', explanation: 'short' }],
      features: [{ name: 'camera|rain_sensor|heated|hud|antenna|acoustic|solar_coated|mirror_bracket|vin_window|panoramic', value: 'boolean|null', confidence: '0..1', explanation: 'short' }],
      similarities: [{ glassId: 'candidate glassId only', confidence: '0..1', explanation: 'short' }],
      warnings: ['string'],
    },
    strictRules: [
      'Return unknown/null when unsure.',
      'Visual similarity is weak evidence and can only help verification.',
      'Do not infer Eurocode from shape alone.',
      'Do not invent OE numbers or Eurocodes.',
      'OCR must preserve visible characters only.',
      '43R approval number: read the digits after "43R" exactly as printed (e.g. 43R-004592).',
    ],
    candidateImages: candidateList,
  });
}

export function observationToSignals(observation: ImageObservation): EvidenceSignal[] {
  const signals: EvidenceSignal[] = [];
  const common = {
    inputHash: observation.inputHash,
    modelVersion: observation.modelVersion,
    sourceId: observation.imageId,
  };

  for (const e of observation.eurocodes ?? []) {
    const eurocode = normalizeEurocode(e.value);
    if (!eurocode) continue;
    signals.push(makeSignal('ocr_eurocode', eurocode, signalConfidence(e.confidence, observation.role, 'ocr'), 'positive', {
      ...common,
      explanation: e.explanation ?? `OCR eurocode fra ${observation.role}`,
    }));
  }

  for (const o of observation.oemNumbers ?? []) {
    const oem = normOem(o.value);
    if (!oem) continue;
    signals.push(makeSignal('ocr_oem', oem, signalConfidence(o.confidence, observation.role, 'ocr'), 'positive', {
      ...common,
      explanation: o.explanation ?? `OCR OEM fra ${observation.role}`,
    }));
  }

  for (const r of observation.r43Numbers ?? []) {
    const r43 = normalizeR43(r.value);
    if (!r43) continue;
    signals.push(makeSignal('ocr_r43', r43, signalConfidence(r.confidence, observation.role, 'ocr'), 'positive', {
      ...common,
      explanation: r.explanation ?? `OCR ECE R43-approval-nummer fra ${observation.role}`,
    }));
  }

  for (const f of observation.features ?? []) {
    const feature = normFeatureName(f.name);
    if (!feature || f.value == null) continue;
    const confidence = signalConfidence(f.confidence, observation.role, 'feature');
    if (confidence < 0.45) continue;
    signals.push(makeSignal('image_feature', `${feature}:${f.value ? 'true' : 'false'}`, confidence, 'positive', {
      ...common,
      explanation:
        f.explanation ??
        `${feature}=${f.value}; ${HIGH_RISK_FEATURES.has(feature) ? 'hard-stop feature ved konflikt' : 'støttesignal'}`,
    }));
  }

  for (const s of observation.similarities ?? []) {
    if (!s.glassId || clamp(s.confidence) < 0.5) continue;
    signals.push(makeSignal('visual_similarity', s.glassId, signalConfidence(s.confidence, observation.role, 'similarity'), 'positive', {
      ...common,
      explanation: s.explanation ?? 'Svak visuell likhet mot lisensiert kandidatbilde',
    }));
  }

  return signals;
}

export function resolveImageObservations(
  candidates: FusionCandidate[],
  observations: ImageObservation[],
  existingSignals: EvidenceSignal[] = [],
): ImageResolverResult {
  const imageSignals = observations.flatMap(observationToSignals);
  const fusion = fuseEvidence(candidates, [...existingSignals, ...imageSignals]);
  return {
    outcome: fusion.outcome,
    fusion,
    observations,
    imageSignals,
    resolverVersion: IMAGE_RESOLVER_VERSION,
  };
}

export async function resolveGlassImages(input: ImageResolverInput, provider: VisionProvider): Promise<ImageResolverResult> {
  const candidateImages = input.candidateImages ?? [];
  const observations: ImageObservation[] = [];

  for (const image of input.images) {
    const relevantCandidates = candidateImages.filter((c) => c.role === 'catalog_image' || c.role === image.role || image.role === 'full_glass');
    const observation = await provider.observe({
      image,
      candidateImages: relevantCandidates.slice(0, 20),
      prompt: buildVisionPrompt(image, relevantCandidates),
    });
    observations.push({
      imageId: image.id,
      role: image.role,
      inputHash: image.sha256 ?? observation.inputHash,
      modelVersion: observation.modelVersion || provider.modelVersion,
      rawText: observation.rawText,
      eurocodes: observation.eurocodes ?? [],
      oemNumbers: observation.oemNumbers ?? [],
      r43Numbers: observation.r43Numbers ?? [],
      features: observation.features ?? [],
      similarities: observation.similarities ?? [],
      warnings: observation.warnings ?? [],
    });
  }

  return resolveImageObservations(input.candidates, observations, input.existingSignals ?? []);
}
