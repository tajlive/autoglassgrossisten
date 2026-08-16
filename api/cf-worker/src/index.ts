/**
 * Autoglass AS — Cloudflare Worker API v2.3 (Modular)
 * ========================================================================
 * Thin router: delegates all logic to handler modules.
 * BUILD: 2026-06-12-06-35
 */

import type { Env } from "./types";
import { CORS_HEADERS, jsonResponse, errorResponse } from "./lib/cors";
import { checkRateLimit } from "./lib/rate-limit";
import { handleGlass } from "./handlers/glass";
import { handleCatalogBrands, handleCatalogCategories, handleCatalogSearch, handleCatalogBulkLookup } from "./handlers/catalog";
import { handleBrowseBrands, handleBrowseBrand } from "./handlers/browse";
import { handleQuote } from "./handlers/quote";
import { handleFeedback, handleWrongMatchFeedback } from "./handlers/feedback";
import { handleAdminQuotes } from "./handlers/admin";
import { handleVinLookup, handleVinLookupStatus } from "./handlers/vin";
import { handleHealth } from "./handlers/health";
import { handleVehicleKtypeLookup, handleVehicleBrands, handleVehicleModels, handleVehicleYears, handleVehicleProducts, handleVehicleDebug, handleVehicleEquipmentProfile } from "./handlers/vehicle";
import { handleGlassGuide } from "./handlers/glass-guide";
import { handleVerifyGlass } from "./handlers/verify-glass";
import { handleOrdremottaker, handleFeedback as handleOrdremottakerFeedback } from "./handlers/ordremottaker";
import { handleUnifiedSearch } from "./handlers/unified-search";
import { handleBuildKtypeMapping } from "./handlers/build-ktype-mapping";
import { getMetricsSummary, flushMetrics, recordRequest, recordTokenSavings } from "./lib/telemetry";
import { fetchSvvEnkeltoppslag } from "./providers/svv";

/** Lagre SVV-status til KV for overvåking */
async function recordSvvStatus(
  env: Env,
  status: "ok" | "degraded" | "down",
  error?: string,
  httpStatus?: number
): Promise<void> {
  const now = new Date().toISOString();
  const key = "svv:status:history";
  
  try {
    // Hent eksisterende historikk
    const existing = await env.GLASS_CATALOG.get(key, "json") as {
      entries?: Array<{ timestamp: string; status: string; error?: string; httpStatus?: number }>;
      lastSuccessAt?: string;
      lastFailureAt?: string;
      failureCount: number;
    } | null;
    
    const entries = existing?.entries || [];
    
    // Legg til ny entry
    entries.push({
      timestamp: now,
      status,
      error,
      httpStatus,
    });
    
    // Hold kun siste 50 entries
    if (entries.length > 50) {
      entries.shift();
    }
    
    // Oppdater counters
    const lastSuccessAt = status === "ok" ? now : existing?.lastSuccessAt;
    const lastFailureAt = status !== "ok" ? now : existing?.lastFailureAt;
    const failureCount = status !== "ok" 
      ? (existing?.failureCount || 0) + 1 
      : 0; // Reset ved suksess
    
    await env.GLASS_CATALOG.put(key, JSON.stringify({
      entries,
      lastSuccessAt,
      lastFailureAt,
      failureCount,
      updatedAt: now,
    }));
    
    console.log(`[SVV Monitor] Status recorded: ${status}${error ? ` (${error})` : ""}`);
  } catch (e) {
    console.error("[SVV Monitor] Failed to record status:", e);
  }
}

/** Cron-trigger: Periodisk SVV health check */
async function runSvvHealthCheck(env: Env): Promise<void> {
  const testRegnr = "EB21570";
  const startTime = Date.now();
  
  console.log("[SVV Monitor] Running scheduled health check...");
  
  try {
    const result = await fetchSvvEnkeltoppslag(testRegnr, env.SVV_API_KEY);
    const responseTimeMs = Date.now() - startTime;
    
    if (result.status === "ok" || result.status === "not_found") {
      console.log(`[SVV Monitor] Health check passed (${responseTimeMs}ms)`);
      await recordSvvStatus(env, "ok");
    } else if (result.status === "upstream_error") {
      console.warn(`[SVV Monitor] Health check failed: upstream error ${result.httpStatus}`);
      await recordSvvStatus(env, "down", `HTTP ${result.httpStatus}`, result.httpStatus);
    } else {
      console.warn(`[SVV Monitor] Health check degraded: ${result.status}`);
      await recordSvvStatus(env, "degraded", result.status);
    }
  } catch (e) {
    console.error(`[SVV Monitor] Health check error: ${e instanceof Error ? e.message : String(e)}`);
    await recordSvvStatus(env, "down", e instanceof Error ? e.message : "Unknown error");
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startTime = Date.now();
    
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";

    // Rate limiting
    if (!(await checkRateLimit(env.GLASS_CATALOG_D1, clientIp))) {
      return errorResponse("For mange forespørsler. Prøv igjen om et minutt.", 429);
    }

    // Health check
    if (path === "/api/health") {
      return handleHealth(request, env);
    }

    // Root — friendly API landing page
    if (path === "/") {
      return jsonResponse({
        service: "autoglass-glass-sok",
        status: "ok",
        version: "2.3-enterprise",
        endpoints: {
          health: "/api/health",
          glass: "/api/glass?regnr=<REGNR>&category=frontrute",
          search: "POST /api/search",
        },
        timestamp: new Date().toISOString(),
      });
    }

    // SVV Status monitor (detaljert historikk)
    if (path === "/api/svv-status") {
      const history = await env.GLASS_CATALOG.get("svv:status:history", "json") as {
        entries?: Array<{ timestamp: string; status: string; error?: string; httpStatus?: number }>;
        lastSuccessAt?: string;
        lastFailureAt?: string;
        failureCount: number;
        updatedAt?: string;
      } | null;
      
      // Beregn uptime % fra siste 24 timer
      const now = Date.now();
      const oneDayAgo = now - 24 * 60 * 60 * 1000;
      const recentEntries = history?.entries?.filter(e => new Date(e.timestamp).getTime() > oneDayAgo) || [];
      const okCount = recentEntries.filter(e => e.status === "ok").length;
      const uptime24h = recentEntries.length > 0 ? (okCount / recentEntries.length) * 100 : 100;
      
      return jsonResponse({
        current: history?.entries?.[history.entries.length - 1] || null,
        summary: {
          lastSuccessAt: history?.lastSuccessAt,
          lastFailureAt: history?.lastFailureAt,
          totalFailures: history?.failureCount || 0,
          uptime24h: Math.round(uptime24h * 100) / 100,
          checksLast24h: recentEntries.length,
        },
        history: history?.entries?.slice(-20) || [], // Siste 20 entries
        timestamp: new Date().toISOString(),
      });
    }

    // Metrics endpoint (enterprise observability)
    if (path === "/api/metrics") {
      const summary = await getMetricsSummary(env);
      return jsonResponse({
        ...summary,
        timestamp: new Date().toISOString(),
        version: "2.3-enterprise",
      });
    }

    // Flush metrics (admin only)
    if (path === "/api/admin/flush-metrics" && request.method === "POST") {
      await flushMetrics(env);
      return jsonResponse({ status: "flushed", timestamp: new Date().toISOString() });
    }

    // Glass search
    if (path === "/api/glass") {
      const response = await handleGlass(request, env, ctx);
      
      // Enterprise telemetry (async)
      const latency = Date.now() - startTime;
      const responseBody = await response.clone().text();
      const isCompressed = responseBody.includes('"_compressed":true');
      const fieldsParam = url.searchParams.get('fields');
      
      ctx.waitUntil(
        recordRequest(env, {
          endpoint: "/api/glass",
          method: request.method,
          statusCode: response.status,
          latencyMs: latency,
          compressed: isCompressed,
        })
      );
      
      if (isCompressed && fieldsParam) {
        const originalSize = responseBody.length * 2.5;
        const savedTokens = Math.floor((originalSize - responseBody.length) / 4);
        ctx.waitUntil(
          recordTokenSavings(env, {
            endpoint: "/api/glass",
            originalTokens: Math.floor(originalSize / 4),
            savedTokens,
            compressionRatio: savedTokens / Math.floor(originalSize / 4),
          })
        );
      }
      
      return response;
    }

    // Glass Guide (AI glassvelger)
    if (path === "/api/glass-guide" && request.method === "POST") {
      return handleGlassGuide(request, env);
    }

    // ECE R43-verifisering (bilde/manuell avlesning av godkjenningsmerket)
    if (path === "/api/verify-glass" && request.method === "POST") {
      return handleVerifyGlass(request, env);
    }

    // Catalog metadata
    if (path === "/api/catalog/brands") {
      return handleCatalogBrands(request, env);
    }
    if (path === "/api/catalog/categories") {
      return handleCatalogCategories(request, env);
    }
    if (path === "/api/catalog/search") {
      return handleCatalogSearch(request, env);
    }
    if (path === "/api/catalog/bulk-lookup") {
      return handleCatalogBulkLookup(request, env);
    }

    // Browse data (merke/modell/år)
    if (path === "/api/browse/brands") {
      return handleBrowseBrands(request, env);
    }
    if (path.startsWith("/api/browse/") && path.endsWith(".json")) {
      return handleBrowseBrand(request, env);
    }

    // Auth
    if (path === "/api/me") {
      const email = request.headers.get("CF-Access-Authenticated-User-Email");
      if (!email) {
        return jsonResponse({ authenticated: false }, 401);
      }
      return jsonResponse({ authenticated: true, email });
    }

    // Quote request
    if (path === "/api/quote-request" && request.method === "POST") {
      return handleQuote(request, env);
    }

    // VIN lookup
    if (path === "/api/vin-lookup" && request.method === "POST") {
      return handleVinLookup(request, env, ctx);
    }
    if (path === "/api/vin-lookup/status" && request.method === "GET") {
      return handleVinLookupStatus(request, env);
    }

    // Feedback
    if (path === "/api/feedback" && request.method === "POST") {
      return handleFeedback(request, env);
    }
    if (path === "/api/feedback/wrong-match" && request.method === "POST") {
      return handleWrongMatchFeedback(request, env);
    }

    // Admin
    if (path === "/api/admin/quotes" && request.method === "GET") {
      return handleAdminQuotes(request, env);
    }
    if (path === "/api/admin/build-ktype-mapping" && request.method === "POST") {
      return handleBuildKtypeMapping(request, env);
    }

    // Vegvesen Scraper (backup når SVV er nede)
    if (path === "/api/scrape-vegvesen" && request.method === "GET") {
      const url = new URL(request.url);
      const regnr = url.searchParams.get("regnr");
      
      if (!regnr) {
        return errorResponse("Mangler regnr parameter", 400);
      }
      
      // Importer scraper dynamisk for å unngå oppstartskostnad
      const { scrapeVegvesen } = await import("./providers/vegvesen-scraper");
      const result = await scrapeVegvesen(regnr);
      
      if (result.status === "ok" && result.vehicle) {
        return jsonResponse({
          status: "ok",
          source: "vegvesen-scraper",
          vehicle: result.vehicle,
        });
      } else if (result.status === "not_found") {
        return jsonResponse({ 
          status: "not_found", 
          error: "Kjøretøy ikke funnet på vegvesen.no" 
        }, 404);
      } else {
        return jsonResponse({ 
          status: "error", 
          error: result.error || "Scraping feilet" 
        }, 503);
      }
    }


    // Vehicle Wizard endpoints
    if (path.startsWith("/api/vehicle/debug/")) {
      return handleVehicleDebug(request, env);
    }
    if (path === "/api/debug/tecdoc-resolve") {
      const url = new URL(request.url);
      const brand = url.searchParams.get("brand") || "";
      const model = url.searchParams.get("model") || "";
      const year = parseInt(url.searchParams.get("year") || "0", 10);
      const { resolveTecDocKType } = await import("./lib/tecdoc-resolver");
      const result = resolveTecDocKType(brand, model, year || undefined);
      return jsonResponse({ brand, model, year, result });
    }
    if (path.startsWith("/api/vehicle/ktype/")) {
      return handleVehicleKtypeLookup(request, env);
    }
    if (path === "/api/vehicle/brands") {
      return handleVehicleBrands(request, env);
    }
    if (path === "/api/vehicle/models") {
      return handleVehicleModels(request, env);
    }
    if (path === "/api/vehicle/years") {
      return handleVehicleYears(request, env);
    }
    if (path === "/api/vehicle/products") {
      return handleVehicleProducts(request, env);
    }
    if (path === "/api/vehicle/equipment-profile") {
      return handleVehicleEquipmentProfile(request, env);
    }

    // AI Ordremottaker
    if (path === "/api/ordremottaker" && request.method === "POST") {
      return handleOrdremottaker(request, env, ctx);
    }
    if (path === "/api/ordremottaker/feedback" && request.method === "POST") {
      return handleOrdremottakerFeedback(request, env);
    }

    // Unified search (regnr / VIN / eurocode / OEM / SKU / text)
    if (path === "/api/search" && request.method === "POST") {
      return handleUnifiedSearch(request, env, ctx);
    }

    return errorResponse("Ukjent endepunkt", 404);
  },
  
  /** Cron-trigger handler - kjører på schedule */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[Cron] Triggered at ${new Date().toISOString()}, cron: ${controller.cron}`);
    
    // Kjør SVV health check
    ctx.waitUntil(runSvvHealthCheck(env));
  },
};
