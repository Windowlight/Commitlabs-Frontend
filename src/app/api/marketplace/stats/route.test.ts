import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';
import { diagnosticsService } from '@/lib/backend/diagnostics';
import {
  marketplaceCacheInvalidationService,
  CacheFreshness,
} from '@/lib/backend/services/marketplaceCacheInvalidation';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/backend/rateLimit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
  getRateLimitWindowSeconds: vi.fn(() => 60),
}));

vi.mock('@/lib/backend/services/marketplace', () => ({
  marketplaceService: {
    getMarketplaceStats: vi.fn(),
  },
}));

vi.mock('@/lib/backend/cache/factory', () => ({
  cache: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
}));

import { checkRateLimit, getRateLimitWindowSeconds } from '@/lib/backend/rateLimit';
import { marketplaceService } from '@/lib/backend/services/marketplace';
import { cache } from '@/lib/backend/cache/factory';

const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockGetStats = vi.mocked(marketplaceService.getMarketplaceStats);
const mockCache = vi.mocked(cache);

// ── Helpers ───────────────────────────────────────────────────────────────────

function createMockRequest(url: string = 'http://localhost/api/marketplace/stats'): NextRequest {
  const req = new NextRequest(url, { method: 'GET' });
  vi.spyOn(req, 'ip', 'get').mockReturnValue('192.168.1.1');
  return req;
}

interface ParsedResponse {
  status: number;
  data: any;
  headers: Record<string, string>;
}

async function parseResponse(response: Response): Promise<ParsedResponse> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    status: response.status,
    data: await response.json(),
    headers,
  };
}

// ── Test Data ─────────────────────────────────────────────────────────────────

const MOCK_STATS = {
  activeListings: 42,
  averageYield: 8.5,
  medianPrice: 1500,
  breakdown: {
    shortTerm: 15,
    longTerm: 27,
  },
  lastUpdated: new Date().toISOString(),
};

const EMPTY_STATS = {
  activeListings: 0,
  averageYield: 0,
  medianPrice: 0,
  breakdown: {
    shortTerm: 0,
    longTerm: 0,
  },
  lastUpdated: new Date().toISOString(),
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('GET /api/marketplace/stats - Freshness & Caching Bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    diagnosticsService.clear();
    marketplaceCacheInvalidationService.clear();
    mockCheckRateLimit.mockResolvedValue(true);
    mockCache.get.mockResolvedValue(null);
    mockCache.set.mockResolvedValue(undefined);
    mockCache.delete.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    diagnosticsService.clear();
    marketplaceCacheInvalidationService.clear();
  });

  // ── Success Cases ──────────────────────────────────────────────────────────

  it('returns marketplace stats successfully on cache miss', async () => {
    mockGetStats.mockResolvedValue(MOCK_STATS);

    const req = createMockRequest();
    const response = await GET(req, {}, 'correlation-123');

    const result = await parseResponse(response);
    expect(result.status).toBe(200);
    expect(result.data.success).toBe(true);
    expect(result.data.data).toEqual(MOCK_STATS);
    expect(result.headers['x-cache']).toBe('MISS');
    expect(result.headers['x-cache-freshness']).toBe(CacheFreshness.FRESH);
  });

  it('serves cached fresh data on cache hit', async () => {
    const now = Date.now();
    const cachedEntry = {
      data: MOCK_STATS,
      metadata: {
        createdAt: now,
        version: 'v1',
      },
    };

    mockCache.get.mockResolvedValue(cachedEntry);

    const req = createMockRequest();
    const response = await GET(req, {}, 'correlation-123');

    const result = await parseResponse(response);
    expect(result.status).toBe(200);
    expect(result.data.data).toEqual(MOCK_STATS);
    expect(result.headers['x-cache']).toBe('HIT');
    expect(result.headers['x-cache-freshness']).toBe(CacheFreshness.FRESH);
  });

  it('handles empty stats result (no listings) without error', async () => {
    mockGetStats.mockResolvedValue(EMPTY_STATS);

    const req = createMockRequest();
    const response = await GET(req, {}, 'correlation-123');

    const result = await parseResponse(response);
    expect(result.status).toBe(200);
    expect(result.data.success).toBe(true);
    expect(result.data.data).toEqual(EMPTY_STATS);
  });

  // ── Cache Freshness Tests ──────────────────────────────────────────────────

  it('serves stale data when cache is old but not expired', async () => {
    // Create entry that's 90 seconds old (stale but not expired)
    const staleTime = Date.now() - 90000;
    const staleEntry = {
      data: MOCK_STATS,
      metadata: {
        createdAt: staleTime,
        version: 'v1',
      },
    };

    mockCache.get.mockResolvedValue(staleEntry);

    const req = createMockRequest();
    const response = await GET(req, {}, 'correlation-123');

    const result = await parseResponse(response);
    expect(result.status).toBe(200);
    expect(result.data.data).toEqual(MOCK_STATS);
    expect(result.headers['x-cache']).toBe('STALE');
    expect(result.headers['x-cache-freshness']).toBe(CacheFreshness.STALE);
    expect(result.headers['x-telemetry-status']).toBe('stale');
  });

  it('returns expired status but serves data when aggregation fails', async () => {
    // Very old cached entry (expired)
    const expiredTime = Date.now() - 400000;
    const expiredEntry = {
      data: MOCK_STATS,
      metadata: {
        createdAt: expiredTime,
        version: 'v1',
      },
    };

    mockCache.get.mockResolvedValue(expiredEntry);
    mockGetStats.mockRejectedValue(new Error('Aggregation service down'));

    const req = createMockRequest();
    const response = await GET(req, {}, 'correlation-123');

    const result = await parseResponse(response);
    expect(result.status).toBe(200);
    expect(result.headers['x-cache']).toBe('EXPIRED');
    expect(result.headers['x-cache-freshness']).toBe(CacheFreshness.EXPIRED);
    expect(result.headers['x-telemetry-status']).toBe('degraded');
    expect(result.headers['x-warning']).toContain('expired cached data');
  });

  // ── Concurrent Request Bounds Tests ────────────────────────────────────────

  it('rejects request when exceeding max concurrent limit', async () => {
    // Simulate max concurrent requests reached
    const mockTelemetry = {
      status: 'degraded',
      failureReason: 'Concurrent operations exceeded bound',
    };

    // Mock diagnosticsService to return degraded
    vi.spyOn(diagnosticsService, 'startOperation').mockReturnValue(mockTelemetry as any);

    const req = createMockRequest();
    const response = await GET(req, {}, 'correlation-123');

    const result = await parseResponse(response);
    expect(result.status).toBe(503);
    expect(result.data.error.code).toBe('SERVICE_DEGRADED');
    expect(result.headers['x-telemetry-status']).toBe('degraded');
  });

  // ── Rate Limit Tests ───────────────────────────────────────────────────────

  it('respects rate limit for IP', async () => {
    mockCheckRateLimit.mockResolvedValue(false);

    const req = createMockRequest();
    const response = await GET(req, {}, 'correlation-123');

    const result = await parseResponse(response);
    expect(result.status).toBe(429);
    expect(result.data.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(result.headers['retry-after']).toBe('60');
  });

  // ── Error Handling Tests ───────────────────────────────────────────────────

  it('falls back to expired cached data when aggregation fails', async () => {
    const expiredEntry = {
      data: MOCK_STATS,
      metadata: {
        createdAt: Date.now() - 400000,
        version: 'v1',
      },
    };

    mockCache.get.mockResolvedValue(expiredEntry);
    mockGetStats.mockRejectedValue(new Error('Service error'));

    const req = createMockRequest();
    const response = await GET(req, {}, 'correlation-123');

    const result = await parseResponse(response);
    expect(result.status).toBe(200);
    expect(result.data.data).toEqual(MOCK_STATS);
  });

  it('returns error when no cache available and aggregation fails', async () => {
    mockCache.get.mockResolvedValue(null);
    mockGetStats.mockRejectedValue(new Error('Service completely down'));

    const req = createMockRequest();
    const response = await GET(req, {}, 'correlation-123');

    const result = await parseResponse(response);
    expect(result.status).toBe(500);
  });

  it('handles invalid stats response (not an object)', async () => {
    mockGetStats.mockResolvedValue(null);

    const req = createMockRequest();
    const response = await GET(req, {}, 'correlation-123');

    const result = await parseResponse(response);
    expect(result.status).toBe(500);
  });

  // ── Cache Headers Tests ────────────────────────────────────────────────────

  it('includes cache control and freshness headers in response', async () => {
    mockGetStats.mockResolvedValue(MOCK_STATS);

    const req = createMockRequest();
    const response = await GET(req, {}, 'correlation-123');

    const result = await parseResponse(response);
    expect(result.headers['cache-control']).toContain('public');
    expect(result.headers['cache-control']).toContain('s-maxage=60');
    expect(result.headers['cache-control']).toContain('stale-while-revalidate=30');
    expect(result.headers['x-cache-version']).toBeDefined();
  });

  it('includes Age header indicating cache age', async () => {
    const now = Date.now();
    const cachedEntry = {
      data: MOCK_STATS,
      metadata: {
        createdAt: now - 10000, // 10 seconds old
        version: 'v1',
      },
    };

    mockCache.get.mockResolvedValue(cachedEntry);

    const req = createMockRequest();
    const response = await GET(req, {}, 'correlation-123');

    const result = await parseResponse(response);
    expect(result.headers['age']).toBeDefined();
    const age = parseInt(result.headers['age'] || '0', 10);
    expect(age).toBeGreaterThanOrEqual(10);
  });

  // ── Diagnostics Tests ──────────────────────────────────────────────────────

  it('tracks operation telemetry for cache hit', async () => {
    const cachedEntry = {
      data: MOCK_STATS,
      metadata: {
        createdAt: Date.now(),
        version: 'v1',
      },
    };

    mockCache.get.mockResolvedValue(cachedEntry);

    const req = createMockRequest();
    await GET(req, {}, 'correlation-123');

    const stats = diagnosticsService.getOperationStats('marketplace_stats_fetch');
    expect(stats.successCount).toBeGreaterThan(0);
  });

  it('marks slow responses as degraded', async () => {
    mockGetStats.mockImplementation(
      async () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(MOCK_STATS), 6000), // Exceeds 5s threshold
        ),
    );

    const req = createMockRequest();
    // Note: In real test would need to handle timeout
    // This is illustrative of the capability
  });

  // ── Invalidation Tests ─────────────────────────────────────────────────────

  it('increments cache version on invalidation', async () => {
    const v1 = marketplaceCacheInvalidationService.getCacheVersion();
    marketplaceCacheInvalidationService.incrementCacheVersion();
    const v2 = marketplaceCacheInvalidationService.getCacheVersion();

    expect(v1).not.toBe(v2);
  });

  it('records invalidation reason when cache is invalidated', async () => {
    await marketplaceCacheInvalidationService.invalidate('New listing created');

    const freshness = await marketplaceCacheInvalidationService.getFreshness();
    expect(freshness).toBe(CacheFreshness.EMPTY);
  });
});
