/**
 * POST /api/verify-glass — ECE R43-verifisering (B2B).
 *
 * Verkstedet fotograferer 43R-godkjenningsmerket på kundens gamle glass
 * (eller skriver nummeret manuelt) → Workers AI leser nummeret → oppslag i
 * ece_r43 → bekreftet glass fra glass_catalog FØR bestilling.
 *
 * Samme evidens-lag som FinnBilGlass (KLA-301): bilde → VisionProvider →
 * ImageObservation → EvidenceSignal[] → fuseEvidence(). Modulene ligger i
 * src/lib/vision/ og er delt mellom de to prosjektene.
 *
 * Body: { image?: dataURL, r43?: string (manuell), merke?, modell?, aar?,
 *         vin?, role?: 'corner_marking'|'full_glass', queryRef? }
 * Svar: { ok, queryRef, r43Nummer, observasjon, treff[], fusion, melding }
 */
import type { Env, GlassRecord } from "../types";
import { jsonResponse } from "../lib/cors";
import { queryByEurocode } from "../lib/db";
import { WorkersAIVisionProvider } from "../lib/vision/vision-provider";
import { observationToSignals } from "../lib/vision/image-resolver";
import {
  fuseEvidence,
  normalizeR43,
  type FusionCandidate,
} from "../lib/vision/evidence-fusion";
import type { ImageObservation } from "../lib/vision/image-resolver";

const MAX_IMAGE_CHARS = 7_000_000; // ~5 MB dataURL

export async function handleVerifyGlass(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "Ugyldig JSON" }, 400);
  }
  if (!body || typeof body !== "object") {
    return jsonResponse({ ok: false, error: "JSON-body påkrevd" }, 400);
  }
  const b = body as Record<string, unknown>;

  const imageRaw = typeof b.image === "string" ? b.image : "";
  const manuellR43 = typeof b.r43 === "string" ? b.r43.trim() : "";
  if (!imageRaw && !manuellR43) {
    return jsonResponse({ ok: false, error: "image (dataURL) eller r43 påkrevd" }, 400);
  }
  if (imageRaw && (imageRaw.length < 100 || !imageRaw.startsWith("data:image/"))) {
    return jsonResponse({ ok: false, error: "image må være dataURL (data:image/jpeg|png|webp;base64,...)" }, 400);
  }
  if (imageRaw.length > MAX_IMAGE_CHARS) {
    return jsonResponse({ ok: false, error: "Bildet er for stort (maks ~5 MB)" }, 413);
  }

  const queryRef =
    typeof b.queryRef === "string" && b.queryRef.trim()
      ? b.queryRef.trim().slice(0, 120)
      : `verify-${crypto.randomUUID()}`;
  const roleRaw = b.role;
  const role: "corner_marking" | "full_glass" =
    roleRaw === "corner_marking" || roleRaw === "full_glass" ? roleRaw : "corner_marking";

  try {
    // 1) Les 43R: bilde (Workers AI) eller manuelt innskrevet nummer.
    let observation: ImageObservation;
    if (imageRaw) {
      const provider = new WorkersAIVisionProvider(env.AI);
      observation = await provider.observe({
        image: {
          id: `${queryRef}-img`,
          role,
          imageRef: imageRaw,
          mime: "image/jpeg",
          source: "customer" as const,
        },
        candidateImages: [],
        prompt: "",
      });
    } else {
      observation = {
        imageId: `${queryRef}-manual`,
        role,
        modelVersion: "manual-input-0.1",
        eurocodes: [],
        oemNumbers: [],
        r43Numbers: [{ value: manuellR43, confidence: 0.9, explanation: "manuelt innskrevet av verksted" }],
        features: [],
        similarities: [],
        warnings: [],
      };
    }
    const imageSignals = observationToSignals(observation);
    const r43Norm = normalizeR43(observation.r43Numbers?.[0]?.value ?? "");

    // 2) ECE R43-oppslag i mappingen.
    let treff: Array<Record<string, unknown>> = [];
    if (r43Norm) {
      const { results } = await env.GLASS_CATALOG_D1.prepare(
        `SELECT r43_nummer, landkode, eurokode, varenr, merke, modell, kilde, bekreftet
         FROM ece_r43 WHERE r43_nummer = ? ORDER BY bekreftet DESC, id ASC LIMIT 20`
      )
        .bind(r43Norm)
        .all();
      treff = results as Array<Record<string, unknown>>;

      // Berik med varenavn + B2B-pris fra glass_catalog (eurokode → record).
      for (const rad of treff) {
        const eurokode = typeof rad.eurokode === "string" && rad.eurokode ? rad.eurokode : null;
        if (!eurokode) continue;
        const record = await queryByEurocode(env.GLASS_CATALOG_D1, eurokode);
        if (record) {
          rad.varenavn = record.description ?? null;
          rad.pris = record.price ?? null;
          rad.article_number = record.article_number ?? null;
          if (!rad.merke && record.brand) rad.merke = record.brand;
          if (!rad.modell && record.model) rad.modell = record.model;
        }
      }

      try {
        await env.GLASS_CATALOG_D1.prepare(
          "INSERT INTO r43_sok_logg (r43_nummer, treff, kilde, query_ref, ip) VALUES (?, ?, ?, ?, ?)"
        )
          .bind(r43Norm, treff.length, imageRaw ? "photo" : "manual", queryRef, request.headers.get("CF-Connecting-IP") ?? null)
          .run();
      } catch {
        // søkelogg-feil må ikke knekke svaret
      }
    }

    // 3) Kandidater: ece_r43-treff (43R-bevis) + evt. bil-kontekst-kandidater.
    const candidates: FusionCandidate[] = [];
    for (const rad of treff) {
      const varenr = typeof rad.varenr === "string" ? rad.varenr : null;
      const eurokode = typeof rad.eurokode === "string" ? rad.eurokode : null;
      candidates.push({
        glassId: `r43-${varenr ?? eurokode ?? "?"}`,
        eurocode: eurokode,
        oemNumbers: [],
        r43Numbers: [String(rad.r43_nummer)],
        features: {},
        sellable: true,
        priceTier: typeof rad.pris === "number" ? rad.pris : null,
        label:
          [typeof rad.varenavn === "string" ? rad.varenavn : null, rad.merke, rad.modell]
            .filter((x): x is string => typeof x === "string" && x.length > 0)
            .join(" ") || undefined,
      });
    }

    // Bil-kontekst: filtrer treffene på merke/modell hvis gitt (verkstedet vet
    // hva kunden har på løft — ett glass på bordet skal bekreftes, ikke finnes).
    const harKontekst = typeof b.merke === "string" && typeof b.modell === "string";
    if (harKontekst && candidates.length > 1) {
      const merke = String(b.merke).toLowerCase();
      const modell = String(b.modell).toLowerCase();
      const matcher = (c: FusionCandidate): boolean => {
        const label = (c.label ?? "").toLowerCase();
        return label.includes(merke) || label.includes(modell);
      };
      const matchet = candidates.filter(matcher);
      if (matchet.length > 0) {
        // Behold kun treff som matcher bilen — men aldri eliminer alle.
        candidates.length = 0;
        candidates.push(...matchet);
      }
    }

    // 4) Fusion: 43R-bevis (0.95) avgjør PINPOINT / VERIFY / FALLBACK.
    const fusion = candidates.length > 0 ? fuseEvidence(candidates, imageSignals) : null;

    return jsonResponse({
      ok: true,
      queryRef,
      r43Nummer: r43Norm ? `43R-${r43Norm}` : null,
      observasjon: observation,
      treff,
      fusion,
      melding: !r43Norm
        ? "Fant ikke 43R-nummer i bildet. Prøv nytt bilde med bedre lys, eller skriv nummeret manuelt."
        : treff.length === 0
          ? "Vi kjenner ikke dette 43R-nummeret ennå — det kan være kopiglass eller et glass utenfor katalogen vår."
          : fusion?.outcome === "PINPOINT"
            ? "Bekreftet: dette er glasset som hører til nummeret du fotograferte."
            : fusion?.outcome === "VERIFY"
              ? "Nummeret stemmer med riktig glassfamilie — kontroller varianten før bestilling."
              : "Fant glass i samme godkjenningsfamilie.",
    });
  } catch (e) {
    console.error("verify-glass feilet:", e);
    return jsonResponse({ ok: false, error: "Intern feil" }, 500);
  }
}
