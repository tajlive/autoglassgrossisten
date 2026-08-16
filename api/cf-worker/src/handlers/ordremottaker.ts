/**
 * AI Ordremottaker handler
 * POST /api/ordremottaker
 */

import type { Env, GlassRecord, OrdremottakerRequest, OrdremottakerResponse, AccessoryItem, GroundTruthRecord } from '../types';
import { jsonResponse, errorResponse } from '../lib/cors';
import { extractVehicleHybrid, extractEquipment } from '../lib/ordremottaker-ner';
import { generateDialogue, buildCartUrl } from '../lib/ordremottaker-llm';
import { createSession, getSession, updateSession, addMessage } from '../lib/ordremottaker-session';
import { lesBildeKontekst, slåOppR43, slåOppSkilt } from '../lib/ordremottaker-vision';
import { searchByRegnr } from './search';
import { queryByBrandAndYear, queryByBrandOnly, queryByEurocode } from '../lib/db';
import { normalizeRecord } from '../lib/normalize';
import { decodeVin } from '../lib/vin-decoder';
import { getCustomerHistory } from '../lib/customer-history';
import { sha256 } from '../lib/learning';
import { decodeEurocode } from '../lib/eurocode-decoder';
import { generateDialogueTurn, normalizeExtracted, determineDialogueState, type ExtractedFields } from '../lib/ordremottaker-llm-dialogue';
import { searchFaq, looksLikeKnowledgeQuestion, isGreeting, buildGreetingResponse } from '../lib/ordremottaker-knowledge';
import { findKtypeByVehicle, queryByKtype } from '../lib/ktype-family-lookup';
import { routeTools, executeTool, generateResponseFromToolResults, determineStatusFromTools, synthesizeSearchToolResult } from '../lib/professor-tools';

type Candidate = Record<string, unknown> & { properties?: Record<string, unknown>; decoded_description?: string | null };

function addDecodedDescription(candidates: Candidate[]): Candidate[] {
  return candidates.map((c) => ({
    ...c,
    decoded_description: decodeEurocode(String(c.eurocode || c.articleNumber || c.supplier_sku || '')),
  }));
}

interface EquipmentFlags {
  hasAdas: boolean;
  hasLdw: boolean;
  isHeated: boolean;
  heatedType: 'full' | 'camera' | null;
  hasHud: boolean;
  hasAntenna: boolean;
  hasCoated: boolean;
  hasRainSensor: boolean;
  hasAcoustic: boolean;
}

/** Hjelper for å få lesbar posisjonsbetegnelse */
function positionLabel(position: string | null): string {
  if (position === 'bakrute') return 'bakruten';
  if (position === 'dørrute' || position?.startsWith('dørrute-')) return 'dørruten';
  if (position === 'siderute' || position === 'sideglass' || position?.startsWith('sideglass-')) return 'sideruten';
  return 'frontruten';
}

/** Bygg tilbehørsliste basert på posisjon og equipment */
function buildAccessories(position: string | null, flags: EquipmentFlags): AccessoryItem[] {
  const accessories: AccessoryItem[] = [];
  const posLabel = positionLabel(position);

  const isDoorGlass = position === 'dørrute' || position?.startsWith('dørrute-');
  const isSideGlass =
    position === 'siderute' ||
    position === 'sideglass' ||
    position === 'ventilrute' ||
    position?.startsWith('sideglass-');

  if (position === 'bakrute') {
    accessories.push({ sku: 'LIM-STD', name: 'Lim', price: 189, included: true, removable: false, category: 'required' });
    accessories.push({ sku: 'KLIPS-STD', name: 'Klips', price: 89, included: true, removable: true, category: 'required' });
  } else if (isDoorGlass || isSideGlass) {
    accessories.push({ sku: 'KLIPS-STD', name: 'Klips', price: 89, included: true, removable: true, category: 'required' });
    accessories.push({ sku: 'TETNING-STD', name: 'Tetningslist', price: 145, included: true, removable: false, category: 'required' });
  } else {
    // Default = frontrute
    accessories.push({ sku: 'LIST-STD', name: 'Pyntelist', price: 245, included: true, removable: false, category: 'required' });
    accessories.push({ sku: 'LIM-STD', name: 'Lim', price: 189, included: true, removable: false, category: 'required' });
    accessories.push({ sku: 'KLIPS-STD', name: 'Klips', price: 89, included: true, removable: true, category: 'required' });
  }

  if (flags.hasAdas || flags.hasLdw) {
    accessories.push({
      sku: 'ADAS-WARN',
      name: 'ADAS-kalibrering',
      price: 0,
      included: false,
      removable: false,
      category: 'warning',
      notes: `Kalibrering av førerassistentsystemer kreves etter montering av ${posLabel} med kamera/sensor`,
    });
  }

  if (flags.isHeated) {
    if (flags.heatedType === 'camera') {
      accessories.push({
        sku: 'LIM-HEAT-CAM',
        name: 'Spesial-lim (kamera-varme)',
        price: 299,
        included: true,
        removable: true,
        category: 'recommended',
        notes: 'Anbefalt for frontrute med varmesone foran kamera — sikrer best isolasjon',
      });
    } else {
      accessories.push({
        sku: 'LIM-HEAT',
        name: 'Spesial-lim (varmebestandig)',
        price: 249,
        included: true,
        removable: true,
        category: 'recommended',
        notes: 'Anbefalt for oppvarmet glass — tåler høyere temperaturer',
      });
    }
  }

  if (flags.hasHud) {
    accessories.push({
      sku: 'HUD-WARN',
      name: 'HUD-spesialglass',
      price: 0,
      included: false,
      removable: false,
      category: 'warning',
      notes: `Head-Up Display krever spesial${posLabel} — sjekk at valgt glass støtter HUD-projeksjon`,
    });
  }

  if (flags.hasAntenna) {
    accessories.push({
      sku: 'ANT-WARN',
      name: 'Integrert antenne',
      price: 0,
      included: false,
      removable: false,
      category: 'warning',
      notes: `${posLabel.charAt(0).toUpperCase() + posLabel.slice(1)} har integrert antenne — sørg for riktig tilkobling ved montering`,
    });
  }

  return accessories;
}

/** Hjelper for å lese equipment fra properties (normalisert av normalizeRecord) */
function getProp(c: { properties?: Record<string, unknown> }, key: string): unknown {
  const props = c.properties || {};
  return props[key];
}

export function buildAccessoriesForContext(
  position: string | null | undefined,
  candidates: Array<{ properties?: Record<string, unknown> }>,
  equipmentAnswers: Record<string, string>
): AccessoryItem[] {
  const hasAdas = candidates.some((c) => !!getProp(c, 'adas')) || equipmentAnswers['adas'] === 'ja';
  const hasLdw = candidates.some((c) => !!getProp(c, 'lane_assist') || !!getProp(c, 'adas')) || equipmentAnswers['ldw'] === 'ja';
  const isHeated = candidates.some((c) => !!getProp(c, 'heated')) || equipmentAnswers['heated'] === 'ja';
  const heatedType = (equipmentAnswers['heated_type'] as 'full' | 'camera' | undefined) || null;
  const hasHud = candidates.some((c) => !!getProp(c, 'hud')) || equipmentAnswers['hud'] === 'ja';
  const hasAntenna = candidates.some((c) => !!getProp(c, 'antenna')) || equipmentAnswers['antenna'] === 'ja';
  const hasCoated = candidates.some((c) => !!getProp(c, 'coated')) || equipmentAnswers['coated'] === 'ja';
  const hasRainSensor = candidates.some((c) => !!getProp(c, 'rainSensor')) || equipmentAnswers['rainSensor'] === 'ja';
  const hasAcoustic = candidates.some((c) => !!getProp(c, 'acoustic')) || equipmentAnswers['acoustic'] === 'ja';

  return buildAccessories(position || null, {
    hasAdas, hasLdw, isHeated, heatedType,
    hasHud, hasAntenna, hasCoated, hasRainSensor, hasAcoustic
  });
}

type EquipmentField = 'adas' | 'ldw' | 'rainSensor' | 'heated' | 'heated_type' | 'hud' | 'antenna' | 'coated' | 'acoustic';

/** Sjekk om kandidater har variasjon i et gitt equipment-felt */
function hasVariation(candidates: Candidate[], field: EquipmentField): boolean {
  if (field === 'ldw') {
    const hasLdw = candidates.some((c) => !!getProp(c, 'lane_assist') || !!getProp(c, 'adas'));
    const hasNoLdw = candidates.some((c) => !getProp(c, 'lane_assist') && !getProp(c, 'adas'));
    return hasLdw && hasNoLdw;
  }
  if (field === 'heated_type') {
    const heatedCandidates = candidates.filter((c) => !!getProp(c, 'heated'));
    if (heatedCandidates.length < 2) return false;
    const hasFull = heatedCandidates.some((c) => !getProp(c, 'camera'));
    const hasCamera = heatedCandidates.some((c) => !!getProp(c, 'camera'));
    return hasFull && hasCamera;
  }
  const values = new Set<string>();
  for (const c of candidates) {
    const val = String(!!getProp(c, field));
    values.add(val);
    if (values.size > 1) return true;
  }
  return values.size > 1;
}

/** Filtrer kandidater basert på equipment-svar */
function filterByEquipment(candidates: Candidate[], answers: Record<string, string>): Candidate[] {
  return candidates.filter((c) => {
    for (const [field, answer] of Object.entries(answers)) {
      if (answer === 'vet_ikke') continue;
      if (field === 'ldw') {
        const hasLdw = !!getProp(c, 'lane_assist') || !!getProp(c, 'adas');
        const expected = answer === 'ja';
        if (hasLdw !== expected) return false;
        continue;
      }
      if (field === 'heated_type') {
        if (answer === 'full') {
          if (!getProp(c, 'heated') || !!getProp(c, 'camera')) return false;
        } else if (answer === 'camera') {
          if (!getProp(c, 'heated') || !getProp(c, 'camera')) return false;
        }
        continue;
      }
      if (field === 'adas' || field === 'rainSensor' || field === 'heated' || field === 'hud' || field === 'antenna' || field === 'coated' || field === 'acoustic') {
        const expected = answer === 'ja' ? 'true' : answer === 'nei' ? 'false' : answer;
        if (String(!!getProp(c, field)) !== expected) return false;
      }
    }
    return true;
  });
}

/** Parse posisjon-svar fra bruker — støtter detaljerte høyre/venstre-valg */
function parsePositionAnswer(message: string): string | null {
  const lower = message.toLowerCase().trim();

  // Annet / ukjent
  if (lower === 'annet' || lower === 'other' || lower === 'vet ikke') return 'annet';

  // Frontrute / bakrute
  if (lower.includes('frontrute') || lower.includes('vindskjerm') || lower === 'front') return 'frontrute';
  if (lower.includes('bakrute') || lower.includes('bakvindu') || lower === 'bak') return 'bakrute';

  // Dørrute — sjekk mest spesifikk først
  if (lower.includes('førerdør') || lower.includes('førerside') || lower.includes('venstre foran') || lower.includes('foran venstre')) {
    if (lower.includes('bak')) return 'dørrute-bv';
    return 'dørrute-fv';
  }
  if (lower.includes('passasjerdør') || lower.includes('passasjerside') || lower.includes('høyre foran') || lower.includes('foran høyre')) {
    if (lower.includes('bak')) return 'dørrute-bh';
    return 'dørrute-fh';
  }
  if (lower.includes('dørrute') || lower.includes('sidedør') || lower.includes('dør')) {
    if (lower.includes('bak') && (lower.includes('venstre') || lower.includes('fører'))) return 'dørrute-bv';
    if (lower.includes('bak') && (lower.includes('høyre') || lower.includes('passasjer'))) return 'dørrute-bh';
    if (lower.includes('bak')) return 'dørrute-bak';
    if (lower.includes('frem') && (lower.includes('venstre') || lower.includes('fører'))) return 'dørrute-fv';
    if (lower.includes('frem') && (lower.includes('høyre') || lower.includes('passasjer'))) return 'dørrute-fh';
    if (lower.includes('frem')) return 'dørrute-frem';
    return 'dørrute';
  }

  // Siderute / ventilrute
  if (lower.includes('ventilrute')) return 'ventilrute';
  if (lower.includes('siderute') || lower.includes('sidevindu') || lower.includes('side')) {
    if (lower.includes('bak') && (lower.includes('venstre') || lower.includes('fører'))) return 'sideglass-bv';
    if (lower.includes('bak') && (lower.includes('høyre') || lower.includes('passasjer'))) return 'sideglass-bh';
    if (lower.includes('venstre') || lower.includes('fører')) return 'sideglass-fv';
    if (lower.includes('høyre') || lower.includes('passasjer')) return 'sideglass-fh';
    return 'siderute';
  }

  return null;
}

/** Parse equipment-svar fra bruker: ja / nei / vet_ikke
 *  Støtter naturlige svar som "ja den har regnsensor", "uten regnsensor", "bare antenne"
 */
function parseEquipmentAnswer(message: string): 'ja' | 'nei' | 'vet_ikke' | null {
  const lower = message.toLowerCase().trim();

  // Nei-svar — sjekk først for å unngå at "jada, nei" blir tolket som ja
  if (/\b(nei|no|false|nope|niks|n)\b/.test(lower)) return 'nei';

  // Ja-svar — matcher helord med word boundaries
  if (/\b(ja|yes|true|jepp|joda|jo|jada|y)\b/.test(lower)) return 'ja';

  // "uten X" / "ikke X" / "ingen X" → nei
  if (/\b(uten\s|ikke\s|ingen\s)/.test(lower)) return 'nei';

  // "bare X" / "kun X" / "only X" → ja (bruker bekrefter dette spesifikke)
  if (/\b(bare|kun|only|må ha|trenger)\b/.test(lower)) return 'ja';

  // "har X" / "med X" → ja
  if (/\b(har\s|med\s)/.test(lower)) return 'ja';

  // Vet ikke
  if (/\b(vet ikke|vetikke|usikker|ikke sikker|maybe|kanskje)\b/.test(lower)) return 'vet_ikke';

  return null;
}

/** Parse heated_type-svar: full vs kamera-sone */
function parseHeatedTypeAnswer(message: string): 'full' | 'camera' | null {
  const lower = message.toLowerCase().trim();
  if (lower.includes('full') || lower.includes('hele') || lower.includes('alt') || lower.includes('alt sammen')) return 'full';
  if (lower.includes('kamera') || lower.includes('cam') || lower.includes('bare') || lower.includes('sone') || lower.includes('zone')) return 'camera';
  return null;
}

/** Map posisjon til ground_truth kolonne(r) for oppslag */
function getGroundTruthColumns(position: string): string[] {
  const p = position.toLowerCase().trim();
  if (p === 'frontrute') return ['frontrute_eurocode'];
  if (p === 'bakrute') return ['bakrute_eurocode'];
  if (p === 'dørrute-fv' || p === 'dør-fv') return ['dor_fv_eurocode'];
  if (p === 'dørrute-fh' || p === 'dør-fh') return ['dor_fh_eurocode'];
  if (p === 'dørrute-bv' || p === 'dør-bv') return ['dor_bv_eurocode'];
  if (p === 'dørrute-bh' || p === 'dør-bh') return ['dor_bh_eurocode'];
  if (p === 'dørrute-frem' || p === 'dør-frem') return ['dor_fv_eurocode', 'dor_fh_eurocode'];
  if (p === 'dørrute-bak' || p === 'dør-bak') return ['dor_bv_eurocode', 'dor_bh_eurocode'];
  if (p === 'sideglass-fv' || p === 'siderute-fv') return ['sideglass_fv_eurocode'];
  if (p === 'sideglass-fh' || p === 'siderute-fh') return ['sideglass_fh_eurocode'];
  if (p === 'sideglass-bv' || p === 'siderute-bv') return ['sideglass_bv_eurocode'];
  if (p === 'sideglass-bh' || p === 'siderute-bh') return ['sideglass_bh_eurocode'];
  if (p === 'siderute' || p === 'sideglass' || p === 'ventilrute') return ['sideglass_fv_eurocode', 'sideglass_fh_eurocode', 'sideglass_bv_eurocode', 'sideglass_bh_eurocode'];
  if (p === 'dørrute' || p === 'dør') return ['dor_fv_eurocode', 'dor_fh_eurocode', 'dor_bv_eurocode', 'dor_bh_eurocode'];
  return [];
}

/** Map posisjon til ground_truth kolonne for upsert (feedback) */
function getGroundTruthColumnForUpsert(position: string): string | null {
  const p = position.toLowerCase().trim();
  if (p === 'frontrute') return 'frontrute_eurocode';
  if (p === 'bakrute') return 'bakrute_eurocode';
  if (p === 'dørrute-fv' || p === 'dør-fv') return 'dor_fv_eurocode';
  if (p === 'dørrute-fh' || p === 'dør-fh') return 'dor_fh_eurocode';
  if (p === 'dørrute-bv' || p === 'dør-bv') return 'dor_bv_eurocode';
  if (p === 'dørrute-bh' || p === 'dør-bh') return 'dor_bh_eurocode';
  if (p === 'dørrute-frem' || p === 'dør-frem') return 'dor_fv_eurocode';
  if (p === 'dørrute-bak' || p === 'dør-bak') return 'dor_bv_eurocode';
  if (p === 'sideglass-fv' || p === 'siderute-fv') return 'sideglass_fv_eurocode';
  if (p === 'sideglass-fh' || p === 'siderute-fh') return 'sideglass_fh_eurocode';
  if (p === 'sideglass-bv' || p === 'siderute-bv') return 'sideglass_bv_eurocode';
  if (p === 'sideglass-bh' || p === 'siderute-bh') return 'sideglass_bh_eurocode';
  if (p === 'siderute' || p === 'sideglass' || p === 'ventilrute') return 'sideglass_fv_eurocode';
  if (p === 'dørrute' || p === 'dør') return 'dor_fv_eurocode';
  return null;
}

/** Bygg spørsmål for neste equipment-variasjon */
function buildEquipmentQuestion(
  candidates: Candidate[],
  answers: Record<string, string>,
  position: string
): { field: string; question: string; nextAction: string } | null {
  const isFront = position === 'frontrute' || position === 'glass';
  const isBack = position === 'bakrute';
  const isDoor = position?.startsWith('dørrute-') || position === 'dørrute' || position === 'dør';
  const isSide = position?.startsWith('sideglass-') || position === 'siderute' || position === 'sideglass' || position === 'ventilrute';
  let glassType = 'glasset';
  if (isBack) glassType = 'bakruten';
  else if (isFront) glassType = 'frontruten';
  else if (isDoor) glassType = 'dørruten';
  else if (isSide) glassType = 'sideruten';

  const priority: Array<{ field: EquipmentField; question: string; nextAction: string; frontOnly?: boolean }> = [
    { field: 'adas', question: `Har bilen ADAS-kamera i ${glassType}? Dette er et kamera bak frontruten som brukes til trafikkskiltgjenkjenning og adaptiv cruisekontroll.`, nextAction: 'ask_adas', frontOnly: true },
    { field: 'ldw', question: `Har bilen filholderassistent (Lane Assist / LDW)? Dette hjelper deg å holde deg i filen.`, nextAction: 'ask_ldw', frontOnly: true },
    { field: 'heated', question: `Har bilen oppvarmet ${glassType}?`, nextAction: 'ask_heated' },
    { field: 'heated_type', question: `Er det full varme i hele frontruten, eller bare en varmesone foran kameraet?`, nextAction: 'ask_heated_type', frontOnly: true },
    { field: 'hud', question: `Har bilen Head-Up Display (HUD)? Dette projiserer hastighet og info i frontruten.`, nextAction: 'ask_hud', frontOnly: true },
    { field: 'antenna', question: `Har bilen antenne integrert i ${glassType}?`, nextAction: 'ask_antenna', frontOnly: true },
    { field: 'coated', question: `Ønsker du varmereflekterende (solar/coated) ${glassType}? Dette holder varmen ute om sommeren.`, nextAction: 'ask_coated' },
    { field: 'rainSensor', question: 'Har bilen regnsensor som aktiverer vindusviskerne automatisk?', nextAction: 'ask_rain_sensor' },
    { field: 'acoustic', question: `Ønsker du akustisk (støydempet) ${glassType}? Dette gir deg en stillere kabin.`, nextAction: 'ask_acoustic' },
  ];

  for (const item of priority) {
    if (answers[item.field] !== undefined) continue;
    if (item.frontOnly && !isFront) continue;

    // heated_type is a follow-up only after user confirms heated=ja
    if (item.field === 'heated_type') {
      if (answers['heated'] !== 'ja') continue;
      if (!hasVariation(candidates, 'heated_type')) continue;
      return item;
    }

    if (hasVariation(candidates, item.field)) {
      return item;
    }
  }
  return null;
}

/** Ekstraher posisjon fra melding (fallback når NER ikke er kjørt) */
function extractPositionFromMessage(message: string): string {
  const parsed = parsePositionAnswer(message);
  return parsed || 'glass';
}

/** Merge LLM-extracted fields into equipment answers */
function mergeExtractedIntoAnswers(
  existing: Record<string, string>,
  extracted: ExtractedFields
): Record<string, string> {
  const normalized = normalizeExtracted(extracted);
  return { ...existing, ...normalized };
}

export async function handleOrdremottaker(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'POST') {
    return errorResponse('Kun POST støttet', 405);
  }

  let body: OrdremottakerRequest;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Ugyldig JSON', 400);
  }

  if (!body.message || typeof body.message !== 'string') {
    return errorResponse('Mangler message', 400);
  }

  try {
    // 1. Get or create session
    let sessionToken = body.session_token || '';
    let session = sessionToken ? await getSession(env, sessionToken) : null;
    if (!session) {
      sessionToken = await createSession(env);
      session = await getSession(env, sessionToken);
    }
    if (!session) {
      return errorResponse('Kunne ikke opprette session', 500);
    }

    // 2. Add user message
    await addMessage(env, sessionToken, 'user', body.message);

    // 2b. Bilde-støtte: foto av 43R-merke eller kjennemerke → fysisk bevis → LLM-kontekst.
    //     Bildet lagres ALDRI — kun det utleste nummeret (samme GDPR-mønster som FinnBilGlass).
    let imageContext: string | null = null;
    if (body.image) {
      if (typeof body.image !== 'string' || body.image.length > 7_000_000 || !body.image.startsWith('data:image/')) {
        return errorResponse('image må være dataURL (data:image/jpeg|png|webp;base64,...), maks ~7 MB', 400);
      }
      try {
        const lest = await lesBildeKontekst(env.AI, body.image);
        const deler: string[] = [];
        if (lest.r43) {
          const treff = await slåOppR43(env, lest.r43);
          if (treff && treff.length > 0) {
            const forste = treff[0];
            const navn = forste.varenavn ? ` (${forste.varenavn})` : '';
            const pris = forste.pris ? `, pris ${forste.pris} kr` : '';
            deler.push(
              `43R-${lest.r43} = ${forste.merke ?? '?'} ${forste.modell ?? ''}${forste.kategori ? `, ${forste.kategori}` : ''}${navn}${pris}, eurokode ${forste.eurokode}`
            );
            // Ett bekreftet treff = glasset er identifisert — sett som kandidat-fundament.
            if (forste.bekreftet === 1) {
              imageContext = `Kunden sendte bilde av 43R-merket: 43R-${lest.r43} → ${forste.merke ?? '?'} ${forste.modell ?? ''} (${forste.eurokode}). Glasset er VERIFISERT (fysisk merke på glasset).`;
            } else {
              imageContext = `Kunden sendte bilde av 43R-merket: 43R-${lest.r43} → ${deler.join('; ')}.`;
            }
          } else {
            imageContext = `Kunden sendte bilde av et 43R-merke (43R-${lest.r43}), men nummeret er ikke i mappingen vår ennå. Be kunden bekrefte glassets varenummer/eurokode, eller identifiser via bil+utstyr.`;
          }
        } else if (lest.skilt) {
          const bil = await slåOppSkilt(env, lest.skilt);
          if (bil) {
            imageContext = `Kunden sendte bilde av kjennemerket: ${lest.skilt} = ${bil.merke} ${bil.modell}${bil.aar ? ` (${bil.aar})` : ''}${bil.vin ? `, VIN ${bil.vin}` : ''}.`;
          } else {
            imageContext = `Kunden sendte bilde av kjennemerket ${lest.skilt}, men SVV-oppslaget ga ingen bil (kan være avregistrert). Spør om biltype manuelt.`;
          }
        } else {
          imageContext = `Kunden sendte et bilde, men vi klarte ikke å lese verken 43R-merke eller kjennemerke (${lest.raatekst.slice(0, 80)}). Spør kunden om varenummer/eurokode eller biltype.`;
        }
        await addMessage(env, sessionToken, 'user', `[BILDE] ${imageContext}`);
      } catch (e) {
        console.error('Bilde-lesing feilet:', e);
        imageContext = 'Kunden sendte et bilde, men det kunne ikke leses. Spør om glassets nummer/eurokode.';
      }
    }

    // 3. State variables
    let candidates: Candidate[] = [];
    let vehicleInfo: { make: string; model: string; year: number } | undefined;
    let aiResponse = '';
    let status: OrdremottakerResponse['status'] = 'clarification';
    let nextAction: string | null = null;
    let confidence = 0;
    let nerResult: any = null;
    let ktypeFamilyInfo: { canonicalModel: string; ktypes: number[]; confidence: number } | null = null;

    // Equipment answers — always restore from session so LLM dialogue state persists
    let equipmentAnswers: Record<string, string> = { ...(session.answers || {}) };

    // ── A: Handle pending question or restore LLM dialogue state ──
    if (session.pending_question || session.candidate_data) {
      let answer: string | null = null;
      if (session.pending_question === 'heated_type') {
        answer = parseHeatedTypeAnswer(body.message);
      } else if (session.pending_question === 'position') {
        answer = parsePositionAnswer(body.message);
      } else if (session.pending_question) {
        answer = parseEquipmentAnswer(body.message);
      }

      // Add parsed answer to already-restored equipment answers
      if (answer !== null && session.pending_question) {
        equipmentAnswers[session.pending_question] = answer;
      }

      // ALSO scan the message for ANY equipment mentions (user may answer multiple at once)
      // e.g. "ja, med varme" or "uten regnsensor, med antenne"
      const equipmentFromMessage = extractEquipment(body.message);
      if (equipmentFromMessage.rain_sensor !== null) {
        equipmentAnswers['rainSensor'] = equipmentFromMessage.rain_sensor ? 'ja' : 'nei';
      }
      if (equipmentFromMessage.heated !== null) {
        equipmentAnswers['heated'] = equipmentFromMessage.heated ? 'ja' : 'nei';
      }
      if (equipmentFromMessage.adas !== null) {
        equipmentAnswers['adas'] = equipmentFromMessage.adas ? 'ja' : 'nei';
      }
      if (equipmentFromMessage.antenna !== null) {
        equipmentAnswers['antenna'] = equipmentFromMessage.antenna ? 'ja' : 'nei';
      }
      if (equipmentFromMessage.coated !== null) {
        equipmentAnswers['coated'] = equipmentFromMessage.coated ? 'ja' : 'nei';
      }

      if (session.candidate_data) {
        try {
          candidates = JSON.parse(session.candidate_data);
        } catch {
          candidates = [];
        }
      }

      // If position was just answered, filter candidates by position first
      if (session.pending_question === 'position' && candidates.length > 0) {
        const positionAnswer = answer?.toLowerCase() || '';
        candidates = candidates.filter((c: Candidate) => {
          const cat = String(c.category || '').toLowerCase();
          if (positionAnswer === 'frontrute') return cat.includes('front');
          if (positionAnswer === 'bakrute') return cat.includes('bak') && !cat.includes('dør') && !cat.includes('dor');
          if (positionAnswer?.startsWith('dørrute-') || positionAnswer === 'dørrute' || positionAnswer === 'dør') return cat.includes('dør') || cat.includes('dor');
          if (positionAnswer?.startsWith('sideglass-') || positionAnswer === 'siderute' || positionAnswer === 'sideglass' || positionAnswer === 'ventilrute') return cat.includes('side');
          return true;
        });
      }

      // Filter by all accumulated equipment answers
      if (candidates.length > 0) {
        candidates = filterByEquipment(candidates, equipmentAnswers);
      }

      vehicleInfo = session.vehicle;
      confidence = 0.8; // We already had a good search before
    }

    // ── B: Normal search flow ──
    if (candidates.length === 0) {
      // Check if user is answering a simple yes/no/don't-know in an active LLM dialogue
      const simpleAnswer = parseEquipmentAnswer(body.message);
      if (simpleAnswer && session.answers?.position && session.vehicle) {
        console.log(`[Ordremottaker] Simple answer "${body.message}" in active dialogue — skipping NER, using session vehicle`);
        vehicleInfo = session.vehicle;
        const db = env.GLASS_CATALOG_D1;

        // Try kType family lookup first
        let dbCandidates: GlassRecord[] = [];
        if (session.vehicle.model) {
          const ktypeResult = await findKtypeByVehicle(db, session.vehicle.make, session.vehicle.model, session.vehicle.year);
          if (ktypeResult.ktypes.length > 0) {
            ktypeFamilyInfo = {
              canonicalModel: ktypeResult.canonicalModel!,
              ktypes: ktypeResult.ktypes,
              confidence: ktypeResult.confidence,
            };
            (vehicleInfo as any).k_type = ktypeResult.ktypes[0];
            const rawKtypeCandidates = await queryByKtype(db, ktypeResult.ktypes, session.answers.position);
            dbCandidates = rawKtypeCandidates as unknown as GlassRecord[];
          }
        }

        if (dbCandidates.length === 0) {
          const { results } = await db
            .prepare("SELECT * FROM glass_catalog WHERE brand = ? AND year_from <= ? AND year_to >= ? LIMIT 100")
            .bind(session.vehicle.make, session.vehicle.year, session.vehicle.year)
            .all();
          dbCandidates = (results || []) as unknown as GlassRecord[];
          if (dbCandidates.length === 0) {
            const { results: r2 } = await db
              .prepare("SELECT * FROM glass_catalog WHERE UPPER(brand) = UPPER(?) AND year_from <= ? AND year_to >= ? LIMIT 100")
              .bind(session.vehicle.make, session.vehicle.year, session.vehicle.year)
              .all();
            dbCandidates = (r2 || []) as unknown as GlassRecord[];
          }
        }
        candidates = dbCandidates.map(normalizeRecord) as unknown as Candidate[];
        confidence = 0.8;
      } else {
        // NER extraction (hybrid: regex + LLM fallback)
        nerResult = await extractVehicleHybrid(env, body.message);
        confidence = nerResult.confidence;

        // If we have partial info from session (e.g., position from previous turn),
        // combine with new NER results to build a complete picture
        if (session.answers?.position && !nerResult?.position) {
          console.log(`[Ordremottaker] Combining session.position=${session.answers.position} with new NER results`);
          nerResult = { ...nerResult, position: session.answers.position };
        }

        // Year correction: user says "it's a 2022 model" without repeating make/model
        if (nerResult?.year && !nerResult?.make && session.vehicle) {
          console.log(`[Ordremottaker] Year correction: ${session.vehicle.year} → ${nerResult.year}`);
          session.vehicle.year = nerResult.year;
          vehicleInfo = session.vehicle;
          await updateSession(env, sessionToken, { vehicle: session.vehicle });
        }
      }

      // === GREETING HANDLING ===
      // Pure greetings ("hei", "hallo", etc.) get a friendly response
      if (isGreeting(body.message)) {
        const greetingResponse = buildGreetingResponse();
        console.log('[Ordremottaker] Greeting detected');
        await updateSession(env, sessionToken, { status: 'active' });
        await addMessage(env, sessionToken, 'ai', greetingResponse);
        return jsonResponse({
          status: 'knowledge',
          ai_response: greetingResponse,
          session_token: sessionToken,
          confidence: 0.95,
        });
      }

      // === KNOWLEDGE ROUTING ===
      // If intent is knowledge (or looks like a knowledge question), search FAQ and answer directly.
      // We search FAQ even if NER found a make (LLM can hallucinate brands), but NOT if we have a regnr.
      // Also NOT if user is in an active ordering dialogue (they're answering questions, not asking).
      const isActiveDialog = !!session.vehicle && (
        session.dialogueState === 'filtering' ||
        session.dialogueState === 'needs_position' ||
        session.dialogueState === 'ready_to_show' ||
        session.dialogueState === 'showing_results'
      );
      const isKnowledge = !isActiveDialog && (nerResult?.intent === 'kunnskap' || looksLikeKnowledgeQuestion(body.message));
      if (isKnowledge && !nerResult?.regnr) {
        const faqResult = searchFaq(body.message);
        if (faqResult && faqResult.score >= 0.5) {
          console.log(`[Ordremottaker] Knowledge question matched FAQ: ${faqResult.article.id} (score: ${faqResult.score.toFixed(2)})`);
          const knowledgeResponse = faqResult.article.answer;

          await updateSession(env, sessionToken, {
            status: 'active',
            pending_question: null,
            answers: {},
          });
          await addMessage(env, sessionToken, 'ai', knowledgeResponse);

          const response: OrdremottakerResponse = {
            status: 'knowledge',
            ai_response: knowledgeResponse,
            session_token: sessionToken,
            confidence: 0.95,
            next_action: undefined,
          };
          return jsonResponse(response);
        }

        // Knowledge question with weak/no FAQ match — only give general help if no make was found
        if (!nerResult?.make) {
          console.log('[Ordremottaker] Knowledge question, no FAQ match — giving general help');
          const generalHelp = "Jeg er Professor Autoglass, din ekspert på bilglass hos Autoglass AS. Jeg kan hjelpe deg med to ting: (1) Finne riktig glass til din kunde — oppgi regnr, så finner jeg eksakt glass med utstyr og eurocode. Alternativt merke, modell, år og posisjon. (2) Svare på spørsmål om produkter, garanti, levering, OEM vs aftermarket, ADAS-kalibrering, priser, lagerstatus, og mer. Hva trenger du hjelp med?";
          await updateSession(env, sessionToken, { status: 'active' });
          await addMessage(env, sessionToken, 'ai', generalHelp);
          return jsonResponse({
            status: 'knowledge',
            ai_response: generalHelp,
            session_token: sessionToken,
            confidence: 0.8,
            next_action: undefined,
          });
        }
      }

      if (nerResult && nerResult.confidence >= 0.2) {
        if (nerResult.regnr) {
          console.log(`[Ordremottaker] Searching by regnr: ${nerResult.regnr}`);

          // Ground truth lookup BEFORE search
          const regnrHash = await sha256(nerResult.regnr);
          const gt = await env.GLASS_CATALOG_D1
            .prepare("SELECT * FROM ground_truth WHERE regnr_hash = ?")
            .bind(regnrHash)
            .first() as unknown as GroundTruthRecord | null;

          const gtEurocodes = new Set<string>();
          if (gt) {
            const pos = nerResult.position?.toLowerCase() || 'frontrute';
            const columns = getGroundTruthColumns(pos);
            for (const col of columns) {
              const eurocode = gt[col as keyof GroundTruthRecord] as string | null;
              if (eurocode && !gtEurocodes.has(eurocode)) {
                gtEurocodes.add(eurocode);
                const record = await queryByEurocode(env.GLASS_CATALOG_D1, eurocode);
                if (record) {
                  console.log(`[Ordremottaker] Ground truth hit for ${nerResult.regnr}: ${eurocode}`);
                  candidates.push({ ...normalizeRecord(record), isGroundTruth: true });
                }
              }
            }
          }

          const searchResult = await searchByRegnr(nerResult.regnr, env);
          if (searchResult.httpStatus === 200) {
            const searchBody = searchResult.body as {
              candidates?: Candidate[];
              vehicle?: { make: string; model: string; year: number };
            };
            const searchCandidates = searchBody.candidates || [];
            // Merge search candidates, avoiding duplicates with ground truth
            for (const sc of searchCandidates) {
              if (!gtEurocodes.has(sc.eurocode as string)) {
                candidates.push(sc);
              }
            }
            vehicleInfo = searchBody.vehicle;
          }
        } else if (nerResult.vin) {
          const vinData = decodeVin(nerResult.vin);
          if (vinData) {
            const make = vinData.make.charAt(0).toUpperCase() + vinData.make.slice(1);
            const year = vinData.modelYear || new Date().getFullYear();
            vehicleInfo = { make, model: vinData.generation, year };
            const db = env.GLASS_CATALOG_D1;
            let dbCandidates = await queryByBrandAndYear(db, vinData.make, year);
            if (dbCandidates.length === 0) {
              dbCandidates = await queryByBrandOnly(db, vinData.make, vinData.generation);
            }
            candidates = dbCandidates.map(normalizeRecord) as unknown as Candidate[];
          }
        } else if (nerResult.make && nerResult.year) {
          const db = env.GLASS_CATALOG_D1;
          vehicleInfo = {
            make: nerResult.make,
            model: nerResult.model || '',
            year: nerResult.year,
          };

          // ── kType Family Lookup (primary) ──────────────────────────
          // If we have make+model+year, try exact kType matching via families
          let ktypeCandidates: GlassRecord[] = [];
          if (nerResult.model) {
            const ktypeResult = await findKtypeByVehicle(db, nerResult.make, nerResult.model, nerResult.year);
            if (ktypeResult.ktypes.length > 0) {
              console.log(`[Ordremottaker] kType family match: ${ktypeResult.canonicalModel} (${ktypeResult.ktypes.length} ktypes, confidence=${ktypeResult.confidence.toFixed(2)})`);
              ktypeFamilyInfo = {
                canonicalModel: ktypeResult.canonicalModel!,
                ktypes: ktypeResult.ktypes,
                confidence: ktypeResult.confidence,
              };
              // Store k_type in vehicleInfo so scoring.ts can use it
              (vehicleInfo as any).k_type = ktypeResult.ktypes[0];
              const rawKtypeCandidates = await queryByKtype(db, ktypeResult.ktypes, nerResult.position);
              ktypeCandidates = rawKtypeCandidates as unknown as GlassRecord[];
            }
          }

          // ── Fallback: brand+year query ─────────────────────────────
          let dbCandidates: GlassRecord[] = [];
          if (ktypeCandidates.length > 0) {
            dbCandidates = ktypeCandidates;
          } else {
            const { results } = await db
              .prepare("SELECT * FROM glass_catalog WHERE brand = ? AND year_from <= ? AND year_to >= ? LIMIT 100")
              .bind(nerResult.make, nerResult.year, nerResult.year)
              .all();
            dbCandidates = (results || []) as unknown as GlassRecord[];
            if (dbCandidates.length === 0) {
              const { results: r2 } = await db
                .prepare("SELECT * FROM glass_catalog WHERE UPPER(brand) = UPPER(?) AND year_from <= ? AND year_to >= ? LIMIT 100")
                .bind(nerResult.make, nerResult.year, nerResult.year)
                .all();
              dbCandidates = (r2 || []) as unknown as GlassRecord[];
            }
          }
          candidates = dbCandidates.map(normalizeRecord) as unknown as Candidate[];
        } else if (nerResult.make) {
          // Make found but year missing — store partial info and ask for year
          // instead of defaulting to current year (which gives wrong results)
          vehicleInfo = {
            make: nerResult.make,
            model: nerResult.model || '',
            year: 0, // No year yet — will be filled in by user's next message
          };
          // Don't query DB yet — we need year for accurate kType/brand+year matching
          aiResponse = nerResult.model
            ? `Jeg fant ${nerResult.make} ${nerResult.model}. For å finne riktig glass trenger jeg årsmodellen — hvilket år er bilen fra?`
            : `Jeg fant ${nerResult.make}. For å finne riktig glass trenger jeg årsmodellen — hvilket år er bilen fra?`;
          status = 'clarification';
          nextAction = 'ask_year';
        }
      }

      // Fallback: NER found nothing but we have vehicle from session
      // (LLM dialogue continuation — user answered a question, not a new search)
      if (candidates.length === 0 && session.vehicle) {
        console.log(`[Ordremottaker] NER found no vehicle, using session.vehicle: ${session.vehicle.make} ${session.vehicle.model} (${session.vehicle.year})`);
        vehicleInfo = session.vehicle;

        // If year is still missing (year=0 placeholder), ask for it before querying
        if (session.vehicle.year === 0) {
          aiResponse = session.vehicle.model
            ? `Jeg fant ${session.vehicle.make} ${session.vehicle.model}. For å finne riktig glass trenger jeg årsmodellen — hvilket år er bilen fra?`
            : `Jeg fant ${session.vehicle.make}. For å finne riktig glass trenger jeg årsmodellen — hvilket år er bilen fra?`;
          status = 'clarification';
          nextAction = 'ask_year';
        } else {
          const db = env.GLASS_CATALOG_D1;

          // Try kType family lookup first if session has model
          let dbCandidates: GlassRecord[] = [];
        if (session.vehicle.model) {
          const ktypeResult = await findKtypeByVehicle(db, session.vehicle.make, session.vehicle.model, session.vehicle.year);
          if (ktypeResult.ktypes.length > 0) {
            console.log(`[Ordremottaker] Session fallback kType match: ${ktypeResult.canonicalModel} (${ktypeResult.ktypes.length} ktypes)`);
            ktypeFamilyInfo = {
              canonicalModel: ktypeResult.canonicalModel!,
              ktypes: ktypeResult.ktypes,
              confidence: ktypeResult.confidence,
            };
            (vehicleInfo as any).k_type = ktypeResult.ktypes[0];
            const rawKtypeCandidates = await queryByKtype(db, ktypeResult.ktypes, undefined);
            dbCandidates = rawKtypeCandidates as unknown as GlassRecord[];
          }
        }

        if (dbCandidates.length === 0) {
          const { results } = await db
            .prepare("SELECT * FROM glass_catalog WHERE brand = ? AND year_from <= ? AND year_to >= ? LIMIT 100")
            .bind(session.vehicle.make, session.vehicle.year, session.vehicle.year)
            .all();
          dbCandidates = (results || []) as unknown as GlassRecord[];
          if (dbCandidates.length === 0) {
            const { results: r2 } = await db
              .prepare("SELECT * FROM glass_catalog WHERE UPPER(brand) = UPPER(?) AND year_from <= ? AND year_to >= ? LIMIT 100")
              .bind(session.vehicle.make, session.vehicle.year, session.vehicle.year)
              .all();
            dbCandidates = (r2 || []) as unknown as GlassRecord[];
          }
        }
        candidates = dbCandidates.map(normalizeRecord) as unknown as Candidate[];
        confidence = 0.8;
        }
      }

      // Filter by position if specified (from NER or accumulated answers)
      const positionFromAnswers = equipmentAnswers.position;
      const positionToFilter = nerResult?.position || positionFromAnswers;
      if (positionToFilter && candidates.length > 0) {
        const pos = positionToFilter.toLowerCase();
        candidates = candidates.filter((c: Candidate) => {
          const cat = String(c.category || '').toLowerCase();
          if (pos === 'frontrute') return cat.includes('front');
          if (pos === 'bakrute') return cat.includes('bak') && !cat.includes('dør') && !cat.includes('dor');
          if (pos?.startsWith('dørrute-') || pos === 'dørrute' || pos === 'dør') return cat.includes('dør') || cat.includes('dor');
          if (pos?.startsWith('sideglass-') || pos === 'siderute' || pos === 'sideglass' || pos === 'ventilrute') return cat.includes('side');
          return true;
        });
      }

      // Auto-apply equipment from NER (user mentioned it explicitly)
      // ALWAYS store position from NER so follow-up messages can use it
      if (nerResult?.position) {
        equipmentAnswers['position'] = nerResult.position;
      }
      if (nerResult && nerResult.adas !== null) equipmentAnswers['adas'] = nerResult.adas ? 'ja' : 'nei';
      if (nerResult && nerResult.rain_sensor !== null) equipmentAnswers['rainSensor'] = nerResult.rain_sensor ? 'ja' : 'nei';
      if (nerResult && nerResult.heated !== null) equipmentAnswers['heated'] = nerResult.heated ? 'ja' : 'nei';
    }

    // Apply all accumulated equipment answers to filter candidates
    if (Object.keys(equipmentAnswers).length > 0 && candidates.length > 0) {
      candidates = filterByEquipment(candidates, equipmentAnswers);
    }

    // Needed before tool-calling so buildQuote sees the same accessory context
    // that response/cart will expose when tool-calling is used.
    let pos = equipmentAnswers.position || nerResult?.position || extractPositionFromMessage(body.message);
    const toolAccessories = buildAccessoriesForContext(pos, candidates, equipmentAnswers);

    // ── C: Tool-Calling Copilot (Fase 3A) — opt-in, replaces LLM dialogue for actionable intents ──
    let toolResults: import('../types').ToolResult[] | undefined;
    let useToolCalling = false;

    // Activate tool-calling when we have enough context to route to a tool.
    // NOTE: make/model/year does NOT activate search-tool here because
    // /api/search text-input is still a placeholder. Existing ordremottaker
    // search (DB query) is source of truth for make/year.
    const canRoute =
      (!!nerResult?.regnr || !!nerResult?.vin) ||
      (nerResult?.intent === 'kunnskap' && !nerResult?.regnr && !nerResult?.vin) ||
      (candidates.length > 0 && session.vehicle);

    if (canRoute && !isGreeting(body.message)) {
      const toolCalls = routeTools(nerResult || {}, body.message, {
        vehicle: session.vehicle || undefined,
        candidates: candidates as unknown as GlassRecord[],
        dialogueState: session.dialogueState,
      });

      if (toolCalls.length > 0) {
        // Gate: don't use tool-calling if position is unknown and candidates
        // span multiple categories, or if equipment questions remain.
        // Let existing LLM/rigid flow handle the question.
        const pos = equipmentAnswers.position || nerResult?.position || extractPositionFromMessage(body.message);
        const posKnown = pos !== 'glass' || session.answers?.position;
        const categories = new Set(candidates.map((c) => String(c.category || '').toLowerCase()));
        const needsPosition = !posKnown && categories.size > 1;
        const needsEquipment = candidates.length > 3
          ? buildEquipmentQuestion(candidates, equipmentAnswers, pos) !== null
          : false;

        if (needsPosition || needsEquipment) {
          console.log(`[Ordremottaker] Tool-calling gated: needsPosition=${needsPosition}, needsEquipment=${needsEquipment}`);
          // Fall through to existing LLM/rigid flow below
        } else {
          useToolCalling = true;
          toolResults = [];
        for (const toolCall of toolCalls) {
          let result: import('../types').ToolResult;
          if (toolCall.tool === 'search') {
            // Synthesize search result from existing ordremottaker data
            // to avoid double lookup (regnr already searched above)
            result = synthesizeSearchToolResult(
              toolCall,
              candidates as unknown as GlassRecord[],
              vehicleInfo,
              confidence
            );
          } else {
            result = await executeTool(
              toolCall,
              env,
              ctx,
              {
                vehicle: session.vehicle || undefined,
                equipmentAnswers: { ...equipmentAnswers },
                candidates: candidates as unknown as GlassRecord[],
                accessories: toolAccessories,
              }
            );
          }
          toolResults.push(result);
        }

        // Build AI response from tool results — use vehicleInfo (live search result)
        // not just session.vehicle, so first-time searches show the actual vehicle
        aiResponse = generateResponseFromToolResults(toolResults, {
          vehicle: vehicleInfo || session.vehicle || undefined,
          candidates: candidates as unknown as GlassRecord[],
        });
        status = determineStatusFromTools(toolResults);
        nextAction = null;
        console.log(`[Ordremottaker] Tool-calling used: ${toolResults.map((r) => `${r.tool}(${r.success ? 'OK' : 'FAIL'})`).join(', ')}`);
      }
    }
    }

    // ── D: Build response — Dual flow: LLM Dialogue Engine (primary) or rigid fallback ──
    let useLlmDialogue = false;
    if (!useToolCalling) {

    // If user explicitly chose "Annet", we need more info — don't try to match
    if (pos === 'annet') {
      useLlmDialogue = false;
    } else if (candidates.length > 0 && confidence >= 0.3) {
      const posKnown = pos !== 'glass' || session.answers?.position;
      if (posKnown) {
        useLlmDialogue = true;
      }
    } else if (session.answers && Object.keys(session.answers).length > 0 && session.answers.position) {
      // We have accumulated answers from previous turns (LLM dialogue in progress)
      // Continue with LLM even if candidates filtered to 0 — LLM can explain no matches
      useLlmDialogue = true;
    } else if (imageContext) {
      // Bilde fra kunden (43R-merke/kjennemerke) er FYSISK BEVIS — LLM må svare med
      // imageContext i prompten (bekrefte glasset/bilen), selv uten kandidater ennå.
      useLlmDialogue = true;
    }

    if (useLlmDialogue) {
      // === LLM DIALOGUE ENGINE (PRIMARY) ===
      if (pos !== 'glass' && !equipmentAnswers.position) {
        equipmentAnswers.position = pos;
      }

      const history = (session.messages || []).slice(-10).map(m => ({
        role: m.role as 'user' | 'ai',
        content: m.content,
      }));

      const dialogueResult = await generateDialogueTurn(env, {
        candidates: candidates.map(c => ({
          ...c,
          decoded_description: decodeEurocode(String(c.eurocode || c.articleNumber || c.supplier_sku || '')),
        })),
        history,
        extracted: equipmentAnswers,
        vehicle: vehicleInfo || null,
        ktypeFamily: ktypeFamilyInfo || undefined,
        imageContext,
      });

      if (dialogueResult) {
        // Merge any new extracted fields
        if (dialogueResult.extracted && Object.keys(dialogueResult.extracted).length > 0) {
          equipmentAnswers = mergeExtractedIntoAnswers(equipmentAnswers, dialogueResult.extracted);
          candidates = filterByEquipment(candidates, equipmentAnswers);
        }

        aiResponse = dialogueResult.message;
        confidence = dialogueResult.confidence;

        switch (dialogueResult.action) {
          case 'ask_question':
            status = 'question';
            nextAction = 'ask_llm';
            break;
          case 'extract_info':
            status = 'clarification';
            nextAction = null;
            break;
          case 'show_results':
          case 'confirm':
            status = 'recommendation';
            nextAction = 'show_candidates';
            break;
          case 'clarify':
            status = 'clarification';
            nextAction = 'ask_llm'; // Keep LLM dialogue flowing
            break;
        }
      } else {
        // LLM failed — fallback to rigid flow
        useLlmDialogue = false;
      }
    }

    if (!useLlmDialogue) {
      // === RIGID FALLBACK (ORIGINAL LOGIC) ===
      // If aiResponse already set (e.g., year-missing case), skip rigid fallback
      if (aiResponse) {
        // keep existing aiResponse, status, nextAction — already handled above
      } else if (confidence < 0.3 && candidates.length === 0 && !equipmentAnswers.position) {
        // No info at all — ask for everything
        aiResponse = 'Hei! For å finne riktig glass trenger jeg å vite: bilmerke, modell, årsmodell, og hvilket glass (frontrute, bakrute, sidedør, etc.). Har du registreringsnummer er det enda bedre!';
        status = 'clarification';
        nextAction = 'ask_vehicle_details';
      } else if (confidence < 0.3 && candidates.length === 0 && equipmentAnswers.position) {
        // We have position from this turn but missing vehicle info — ask specifically for that
        aiResponse = `Du har valgt ${equipmentAnswers.position}. For å finne riktig glass trenger jeg å vite bilmerke, modell og årsmodell (f.eks. "Volvo XC60 2018"). Har du registreringsnummer er det enda bedre!`;
        status = 'clarification';
        nextAction = 'ask_vehicle_details';
      } else if (candidates.length === 0 && vehicleInfo) {
        aiResponse = `Jeg forstår at du trenger glass til ${vehicleInfo.make} ${vehicleInfo.model} (${vehicleInfo.year}). Dessverre fant jeg ingen glass som passer i katalogen vår. Kan du dobbeltsjekke årsmodellen, eller har du registreringsnummer?`;
        status = 'clarification';
        nextAction = 'ask_regnr_or_verify_year';
      } else if (candidates.length > 0) {
        const posKnown = pos !== 'glass';

        if (!posKnown && !session.answers?.position) {
          const categories = new Set(candidates.map((c) => String(c.category || '').toLowerCase()));
          if (categories.size > 1) {
            aiResponse = `Flott — jeg fant ${candidates.length} glass som passer. Hvilket glass trenger du? (frontrute, bakrute, siderute, eller dørrute)`;
            status = 'question';
            nextAction = 'ask_position';
          }
        }

        if (status !== 'question') {
          const eqQuestion = candidates.length > 3 ? buildEquipmentQuestion(candidates, equipmentAnswers, pos) : null;

          if (eqQuestion) {
            aiResponse = eqQuestion.question;
            status = 'question';
            nextAction = eqQuestion.nextAction;
          } else {
            const make = vehicleInfo?.make || nerResult?.make || '';
            const model = vehicleInfo?.model || nerResult?.model || '';
            const year = vehicleInfo?.year || nerResult?.year || '';
            const count = candidates.length;

            // Build vehicle description without duplicates
            const modelWithoutMake = model && model.toUpperCase().startsWith(make.toUpperCase())
              ? model.slice(make.length).trim()
              : model;
            const vehicleDesc = [
              make,
              modelWithoutMake && modelWithoutMake !== make ? modelWithoutMake : '',
              year && String(year) !== modelWithoutMake ? `(${year})` : ''
            ].filter(Boolean).join(' ');

            if (nerResult?.regnr) {
              aiResponse = `Forstått — ${vehicleDesc}, ${pos}. Her er glassene som passer basert på regnr ${nerResult.regnr}:`;
            } else if (nerResult?.vin) {
              aiResponse = `Forstått — ${vehicleDesc}, ${pos}. Her er glassene som passer:`;
            } else if (make && year && year < 2030) {
              aiResponse = `Forstått — ${vehicleDesc}, ${pos}. Jeg har ${count} alternativer. Velg OEM eller aftermarket:`;
            } else if (make) {
              aiResponse = `Forstått — ${make}, ${pos}. Jeg har ${count} alternativer. Sjekk at det stemmer:`;
            } else {
              aiResponse = `Her er ${count} glass som kan passe. Sjekk at merke og modell stemmer:`;
            }
            status = 'recommendation';
            nextAction = 'show_candidates';
          }
        }
      } else {
        const parts: string[] = [];
        if (nerResult?.make) parts.push(nerResult.make);
        if (nerResult?.model) parts.push(nerResult.model);
        if (nerResult?.year) parts.push(String(nerResult.year));
        if (nerResult?.position) parts.push(nerResult.position);

        if (parts.length > 0) {
          aiResponse = `Jeg forstår at du trenger ${parts.join(' ')}. For å finne eksakt riktig glass, kan du oppgi registreringsnummer eller bekrefte årsmodellen?`;
        } else {
          aiResponse = 'Hei! Jeg hjelper deg å finne riktig bilglass. Kan du oppgi bilmerke, modell, årsmodell og hvilket glass du trenger (frontrute, bakrute, etc.)?';
        }
        status = 'clarification';
        nextAction = 'ask_vehicle_details';
      }
    }
    }

    // Build position-based accessories. Recompute after LLM/rigid flow because
    // equipmentAnswers may have been updated there; tool-calling keeps the
    // precomputed list so QuoteDraft and response use the same accessory set.
    pos = equipmentAnswers.position || nerResult?.position || extractPositionFromMessage(body.message);
    const accessories = useToolCalling
      ? toolAccessories
      : buildAccessoriesForContext(pos, candidates, equipmentAnswers);

    // Build cart URL if recommendation and candidates exist
    let cartUrl: string | undefined;
    if (status === 'recommendation' && candidates.length > 0) {
      const topCandidate = candidates[0] as Candidate;
      const sku =
        (topCandidate.supplier_sku as string | undefined) ||
        (topCandidate.articleNumber as string | undefined) ||
        (topCandidate.eurocode as string | undefined) ||
        String(topCandidate.id);
      const includedAccessories = accessories.filter((a) => a.included && !a.removable);
      const cartItems = [
        { sku, qty: 1 },
        ...includedAccessories.map((a) => ({ sku: a.sku, qty: 1 })),
      ];
      cartUrl = buildCartUrl(cartItems);
    }

    // Update session
    const pendingQuestionField = nextAction?.startsWith('ask_')
      ? (() => {
          const field = nextAction.replace('ask_', '');
          // LLM-managed questions don't use the rigid pending_question mechanism
          if (field === 'llm') return null;
          const mapping: Record<string, string> = {
            rain_sensor: 'rainSensor',
            heated_type: 'heated_type',
            ldw: 'ldw',
            hud: 'hud',
            antenna: 'antenna',
            coated: 'coated',
          };
          return mapping[field] || field;
        })()
      : null;

    await updateSession(env, sessionToken, {
      vehicle: vehicleInfo,
      candidates: candidates.map((c: Candidate) => c.id).filter((id): id is number => typeof id === 'number'),
      status: status === 'recommendation' ? 'completed' : 'active',
      pending_question: pendingQuestionField,
      // Don't store candidate_data for LLM-managed dialogue — next turn should
      // go through normal flow + LLM dialogue, not rigid pending-question logic
      candidate_data: (status === 'question' && nextAction !== 'ask_llm') ? JSON.stringify(candidates) : undefined,
      answers: equipmentAnswers,
      dialogueState: determineDialogueState(candidates, equipmentAnswers),
    });

    // Fetch proactive suggestions for known B2B customers
    let proactiveSuggestions: OrdremottakerResponse['proactive_suggestions'];
    if (body.customer_id && typeof body.customer_id === 'number') {
      try {
        const db = env.GLASS_CATALOG_D1;
        proactiveSuggestions = (await getCustomerHistory(db, body.customer_id)) || undefined;
      } catch (err) {
        console.error(
          `[Ordremottaker] Failed to load customer history for ${body.customer_id}:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // Add AI message
    await addMessage(env, sessionToken, 'ai', aiResponse);

    // Return response
    const response: OrdremottakerResponse = {
      status,
      ai_response: aiResponse,
      session_token: sessionToken,
      candidates: status === 'recommendation' ? addDecodedDescription(candidates.slice(0, 5)) as unknown as GlassRecord[] : undefined,
      accessories: status === 'recommendation' || status === 'order_ready' ? accessories : undefined,
      cart_url: cartUrl,
      confidence: confidence,
      next_action: nextAction || undefined,
      proactive_suggestions: proactiveSuggestions,
      tool_results: toolResults,
    };

    return jsonResponse(response);
  } catch (e) {
    console.error(
      `[Ordremottaker] Handler error: ${e instanceof Error ? e.message : String(e)}`
    );
    return errorResponse('Intern feil i ordremottaker', 500);
  }
}

export async function handleFeedback(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return errorResponse('Kun POST støttet', 405);
  }

  let body: {
    session_token: string;
    regnr?: string;
    position: string;
    recommended_eurocode?: string;
    chosen_eurocode: string;
    was_correct: number;
    correction_eurocode?: string;
    correction_reason?: string;
    equipment_answers?: Record<string, string>;
    make?: string;
    model?: string;
    year?: number;
  };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Ugyldig JSON', 400);
  }

  if (!body.session_token || typeof body.session_token !== 'string') {
    return errorResponse('Mangler session_token', 400);
  }
  if (!body.position || typeof body.position !== 'string') {
    return errorResponse('Mangler position', 400);
  }
  if (!body.chosen_eurocode || typeof body.chosen_eurocode !== 'string') {
    return errorResponse('Mangler chosen_eurocode', 400);
  }
  if (typeof body.was_correct !== 'number') {
    return errorResponse('Mangler was_correct', 400);
  }

  try {
    const regnrHash = body.regnr ? await sha256(body.regnr) : null;
    const db = env.GLASS_CATALOG_D1;

    // Insert into feedback_log
    const insertResult = await db.prepare(
      `INSERT INTO feedback_log (
        session_token, regnr_hash, position,
        recommended_eurocode, chosen_eurocode, was_correct,
        correction_eurocode, correction_reason, equipment_answers
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      body.session_token,
      regnrHash,
      body.position,
      body.recommended_eurocode || null,
      body.chosen_eurocode,
      body.was_correct,
      body.correction_eurocode || null,
      body.correction_reason || null,
      body.equipment_answers ? JSON.stringify(body.equipment_answers) : null
    ).run();

    const feedbackId = insertResult.meta?.last_row_id ?? 0;

    // If correct, upsert into ground_truth
    if (body.was_correct === 1 && regnrHash) {
      const col = getGroundTruthColumnForUpsert(body.position);
      if (col) {
        // Get make/model/year from session if available
        const session = await getSession(env, body.session_token);
        const make = session?.vehicle?.make || body.make || '';
        const model = session?.vehicle?.model || body.model || '';
        const year = session?.vehicle?.year || body.year || new Date().getFullYear();

        if (make && year) {
          await db.prepare(
            `INSERT INTO ground_truth (
              regnr_hash, make, model, year, ${col},
              verified_by, confidence
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(regnr_hash) DO UPDATE SET
              make = excluded.make,
              model = excluded.model,
              year = excluded.year,
              ${col} = excluded.${col},
              verified_by = excluded.verified_by,
              confidence = excluded.confidence,
              verified_at = CURRENT_TIMESTAMP`
          ).bind(
            regnrHash,
            make,
            model,
            year,
            body.chosen_eurocode,
            'ai_feedback',
            0.9
          ).run();
        } else {
          console.warn(`[Ordremottaker-Feedback] Skipping ground_truth upsert: missing make/year for ${regnrHash}`);
        }
      }
    }

    return jsonResponse({ success: true, feedback_id: feedbackId });
  } catch (e) {
    console.error(`[Ordremottaker-Feedback] Error: ${e instanceof Error ? e.message : String(e)}`);
    return errorResponse('Kunne ikke lagre feedback', 500);
  }
}
