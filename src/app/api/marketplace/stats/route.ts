/**
 * GET /api/marketplace/stats
 *
 * Returns aggregate statistics for the marketplace including active listings,
 * average yield, median price, and breakdown by commitment type.
 *
 * ## Caching & Freshness Strategy
 *
 * ### Cache Bounds
 * - TTL: 30 seconds (prevents stale aggregates)
 * - Max concurrent requests: 5 (prevents thundering herd)
 * - Stale-while-revalidate: 60 seconds (allows serving stale on overload)
 * - Expiry after: 300 seconds (hard limit for staleness)
 *
 * ### Freshness States (client-aware via X-Cache-Freshness header)
 * - FRESH: Data is current (< 60s old)
 * - STALE: Data is usable but older (60-300s old)
 * - EXPIRED: Data is too old and unreliable (> 300s)
 * - EMPTY: No cached data available
 *
 * ### Invalidation
 * - Explicit invalidation on listing create/update/cancel
 * - Cache version incremented on invalidation
 * - Clients notified via X-Cache-Version header for consistency
 *
 * ### Error Semantics
 * - 429: Rate limited (too many concurrent aggregations)
 * - 503: Service degraded (too many concurrent requests)
 * - 500: Aggregation failed (data unavailable)
 * - Empty array on zero results (not an error state)\n */

import { NextRequest } from "next/server";
import { ok } from "@/lib/backend/apiResponse";
import { checkRateLimit, getRateLimitWindowSeconds } from "@/lib/backend/rateLimit";
import { withApiHandler } from "@/lib/backend/withApiHandler";
import { marketplaceService } from "@/lib/backend/services/marketplace";
import { cache } from "@/lib/backend/cache/factory";
import { CacheKey, CacheTTL } from "@/lib/backend/cache/index";
import {
  marketplaceCacheInvalidationService,
  CacheFreshness,
  MARKETPLACE_CACHE_BOUNDS,
  CacheEntry,
} from "@/lib/backend/services/marketplaceCacheInvalidation";
import { diagnosticsService } from "@/lib/backend/diagnostics";
import { randomUUID } from "crypto";

export const GET = withApiHandler(async (req: NextRequest, _, correlationId) => {
  // ─── Operation Tracking ───────────────────────────────────────────────────
  const operationId = randomUUID();
  const telemetry = diagnosticsService.startOperation(
    operationId,
    'marketplace_stats_fetch',
    MARKETPLACE_CACHE_BOUNDS.MAX_CONCURRENT_REQUESTS,
  );

  // Check if we're at capacity for concurrent requests
  if (telemetry.status === 'degraded') {
    diagnosticsService.completeOperation(operationId, 'degraded', telemetry.failureReason);
    const response = new Response(
      JSON.stringify({
        success: false,
        error: {
          code: 'SERVICE_DEGRADED',
          message: 'Marketplace stats service temporarily overloaded. Please retry.',
          requestId: correlationId,
        },
      }),
      { status: 503 },
    );
    response.headers.set('X-Telemetry-Status', 'degraded');
    response.headers.set('X-Cache-Freshness', CacheFreshness.EMPTY);
    return response;
  }

  try {
    // ─── Rate Limiting ────────────────────────────────────────────────────────
    const ip = req.ip ?? req.headers.get("x-forwarded-for") ?? "anonymous";
    const isAllowed = await checkRateLimit(ip, "api/marketplace/stats");

    if (!isAllowed) {
      diagnosticsService.completeOperation(
        operationId,
        'failure',
        'Rate limit exceeded',
        { ip },
      );
      const response = new Response(
        JSON.stringify({
          success: false,
          error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: "Too many requests. Please try again later.",
            retryAfter: getRateLimitWindowSeconds("api/marketplace/stats"),
          },
        }),
        { status: 429 },
      );
      response.headers.set(
        "Retry-After",
        String(getRateLimitWindowSeconds("api/marketplace/stats")),
      );
      return response;
    }

    // ─── Cache Lookup ─────────────────────────────────────────────────────────
    const cacheKey = CacheKey.marketplaceStats();
    const cached = await cache.get<CacheEntry<any>>(cacheKey);
    const freshness = await marketplaceCacheInvalidationService.getFreshness();
    const cacheVersion = marketplaceCacheInvalidationService.getCacheVersion();

    // Serve from cache if fresh
    if (cached && freshness === CacheFreshness.FRESH) {
      diagnosticsService.completeOperation(operationId, 'success', undefined, {
        cacheHit: true,
        freshness: CacheFreshness.FRESH,
        age: Date.now() - (cached.metadata?.createdAt || 0),
      });

      const response = ok(cached.data, undefined, 200, correlationId);
      response.headers.set("X-Cache", "HIT");
      response.headers.set("X-Cache-Freshness", CacheFreshness.FRESH);
      response.headers.set("X-Cache-Version", cacheVersion);
      response.headers.set(
        "Cache-Control",
        "public, s-maxage=60, stale-while-revalidate=30",
      );
      response.headers.set("Age", String(cached.metadata?.createdAt ? Math.floor((Date.now() - cached.metadata.createdAt) / 1000) : 0));
      return response;
    }

    // Serve stale data if available but warn about freshness
    if (cached && freshness === CacheFreshness.STALE) {
      diagnosticsService.completeOperation(operationId, 'degraded', undefined, {
        cacheHit: true,
        freshness: CacheFreshness.STALE,
        age: Date.now() - (cached.metadata?.createdAt || 0),
      });

      const response = ok(cached.data, undefined, 200, correlationId);
      response.headers.set("X-Cache", "STALE");
      response.headers.set("X-Cache-Freshness", CacheFreshness.STALE);
      response.headers.set("X-Cache-Version", cacheVersion);
      response.headers.set(
        "Cache-Control",
        "public, s-maxage=30, stale-while-revalidate=60",
      );
      response.headers.set("Age", String(cached.metadata?.createdAt ? Math.floor((Date.now() - cached.metadata.createdAt) / 1000) : 0));
      response.headers.set("X-Telemetry-Status", "stale");
      return response;
    }

    // ─── Cache Miss – Fetch Fresh Data ────────────────────────────────────────
    let stats: any;
    try {
      stats = await marketplaceService.getMarketplaceStats();
    } catch (error) {
      diagnosticsService.completeOperation(
        operationId,
        'failure',
        error instanceof Error ? error.message : 'Failed to fetch marketplace stats',
        { errorType: error instanceof Error ? error.constructor.name : typeof error },
      );

      // If we have stale data, serve it with warning
      if (cached) {
        const response = ok(cached.data, undefined, 200, correlationId);
        response.headers.set("X-Cache", "EXPIRED");
        response.headers.set("X-Cache-Freshness", CacheFreshness.EXPIRED);
        response.headers.set("X-Telemetry-Status", "degraded");
        response.headers.set(
          "X-Warning",
          "Serving expired cached data due to aggregation failure",
        );
        return response;
      }

      // No cache available – return error
      throw error;
    }

    // ─── Validate Stats Response ──────────────────────────────────────────────
    if (!stats || typeof stats !== 'object') {
      throw new Error('Invalid marketplace stats response: expected object');
    }

    // Handle empty results (not an error, just no listings)
    const isEmpty = !stats.activeListings || stats.activeListings === 0;

    // ─── Cache Result ─────────────────────────────────────────────────────────
    const cacheEntry: CacheEntry<any> = {
      data: stats,
      metadata: {
        createdAt: Date.now(),
        version: cacheVersion,
      },
    };

    const ttl = isEmpty ? CacheTTL.MARKETPLACE_STATS_EMPTY : CacheTTL.MARKETPLACE_STATS;
    await cache.set(cacheKey, cacheEntry, ttl);

    // ─── Success Response ─────────────────────────────────────────────────────
    const duration = Date.now() - telemetry.startTime;
    const isSlow = duration > 5000; // 5 second threshold

    diagnosticsService.completeOperation(
      operationId,
      isSlow ? 'degraded' : 'success',
      undefined,
      {
        cacheHit: false,
        freshness: CacheFreshness.FRESH,
        duration,
        slow: isSlow,
        isEmpty,
      },
    );

    const response = ok(stats, undefined, 200, correlationId);
    response.headers.set("X-Cache", "MISS");
    response.headers.set("X-Cache-Freshness", CacheFreshness.FRESH);
    response.headers.set("X-Cache-Version", cacheVersion);
    response.headers.set(
      "Cache-Control",
      "public, s-maxage=60, stale-while-revalidate=30",
    );
    if (isSlow) {
      response.headers.set("X-Telemetry-Status", "slow");
    }
    return response;
  } catch (error) {
    diagnosticsService.completeOperation(
      operationId,
      'failure',
      error instanceof Error ? error.message : 'Unknown error',
      { errorType: error instanceof Error ? error.constructor.name : typeof error },
    );
    throw error;
  }
});
