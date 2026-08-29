/**
 * Cache invalidation and freshness management for marketplace stats.
 * Provides explicit invalidation signals and freshness tracking.
 */

import { cache } from '@/lib/backend/cache/factory';
import { CacheKey, CacheTTL } from '@/lib/backend/cache/index';
import { randomUUID } from 'crypto';

export interface CacheMetadata {
  createdAt: number;
  invalidatedAt?: number;
  invalidationReason?: string;
  version: string;
}

export interface CacheEntry<T> {
  data: T;
  metadata: CacheMetadata;
}

/**
 * Bounds for marketplace statistics.
 */
export const MARKETPLACE_CACHE_BOUNDS = {
  // Maximum number of concurrent requests to fetch stats
  MAX_CONCURRENT_REQUESTS: 5,

  // Minimum cache TTL (seconds) - prevents cache thrashing
  MIN_TTL: 10,

  // Maximum cache TTL (seconds) - prevents stale data
  MAX_TTL: 300,

  // Default TTL for marketplace stats (30 seconds)
  DEFAULT_TTL: 30,

  // Maximum age of cached data before considered stale (in milliseconds)
  STALE_AFTER_MS: 60000, // 60 seconds

  // Maximum age before considered completely expired (in milliseconds)
  EXPIRE_AFTER_MS: 300000, // 5 minutes

  // Maximum number of concurrent stat aggregation operations
  MAX_CONCURRENT_AGGREGATIONS: 3,

  // Polling backoff multiplier for retries
  POLLING_BACKOFF_MS: 1000,
} as const;

/**
 * Cache freshness state for client-side awareness.
 */
export enum CacheFreshness {
  // Data is current and within acceptable freshness window
  FRESH = 'FRESH',

  // Data is stale but still usable (within stale-while-revalidate window)
  STALE = 'STALE',

  // Data is expired and should not be used
  EXPIRED = 'EXPIRED',

  // No cached data available
  EMPTY = 'EMPTY',
}

/**
 * Marketplace cache invalidation service.
 * Tracks cache freshness and handles explicit invalidation.
 */
class MarketplaceCacheInvalidationService {
  private concurrentRequests: Map<string, number> = new Map();
  private lastInvalidation: Map<string, number> = new Map();
  private maxConcurrent: Map<string, number> = new Map();
  private invalidationVersion: Map<string, string> = new Map();

  /**
   * Get current freshness status of cached marketplace stats.
   */
  async getFreshness(): Promise<CacheFreshness> {
    const cacheKey = CacheKey.marketplaceStats();
    const cached = await cache.get<CacheEntry<any>>(cacheKey);

    if (!cached || !cached.metadata) {
      return CacheFreshness.EMPTY;
    }

    const age = Date.now() - cached.metadata.createdAt;

    // Check if invalidated
    if (cached.metadata.invalidatedAt) {
      return CacheFreshness.EMPTY;
    }

    // Check if expired
    if (age > MARKETPLACE_CACHE_BOUNDS.EXPIRE_AFTER_MS) {
      return CacheFreshness.EXPIRED;
    }

    // Check if stale
    if (age > MARKETPLACE_CACHE_BOUNDS.STALE_AFTER_MS) {
      return CacheFreshness.STALE;
    }

    return CacheFreshness.FRESH;
  }

  /**
   * Invalidate marketplace stats cache explicitly.
   * Used when listings are created, updated, or cancelled.
   */
  async invalidate(reason: string): Promise<void> {
    const cacheKey = CacheKey.marketplaceStats();

    // Mark invalidation time
    this.lastInvalidation.set(cacheKey, Date.now());

    // Get current cached data (if exists) and mark as invalidated
    const cached = await cache.get<CacheEntry<any>>(cacheKey);
    if (cached && cached.metadata) {
      cached.metadata.invalidatedAt = Date.now();
      cached.metadata.invalidationReason = reason;
    }

    // Delete the cache entry
    await cache.delete(cacheKey);
  }

  /**
   * Track concurrent request attempt for the stats endpoint.
   * Returns false if max concurrent requests exceeded.
   */
  trackConcurrentRequest(operation: string): boolean {
    const cacheKey = `marketplace_request_${operation}`;
    const current = this.concurrentRequests.get(cacheKey) || 0;
    const max = MARKETPLACE_CACHE_BOUNDS.MAX_CONCURRENT_REQUESTS;

    if (current >= max) {
      return false;
    }

    this.concurrentRequests.set(cacheKey, current + 1);

    // Track max seen
    const maxSeen = this.maxConcurrent.get(cacheKey) || 0;
    if (current + 1 > maxSeen) {
      this.maxConcurrent.set(cacheKey, current + 1);
    }

    return true;
  }

  /**
   * Complete tracking of concurrent request.
   */
  completeConcurrentRequest(operation: string): void {
    const cacheKey = `marketplace_request_${operation}`;
    const current = this.concurrentRequests.get(cacheKey) || 0;
    if (current > 0) {
      this.concurrentRequests.set(cacheKey, current - 1);
    }
  }

  /**
   * Get current concurrent request count.
   */
  getConcurrentRequestCount(operation: string): number {
    const cacheKey = `marketplace_request_${operation}`;
    return this.concurrentRequests.get(cacheKey) || 0;
  }

  /**
   * Get max concurrent requests seen for operation.
   */
  getMaxConcurrentRequests(operation: string): number {
    const cacheKey = `marketplace_request_${operation}`;
    return this.maxConcurrent.get(cacheKey) || 0;
  }

  /**
   * Get time since last invalidation.
   */
  getTimeSinceLastInvalidation(): number | undefined {
    const cacheKey = CacheKey.marketplaceStats();
    const lastInvalidTime = this.lastInvalidation.get(cacheKey);

    if (!lastInvalidTime) {
      return undefined;
    }

    return Date.now() - lastInvalidTime;
  }

  /**
   * Get current cache version (changes on invalidation).
   */
  getCacheVersion(): string {
    const cacheKey = CacheKey.marketplaceStats();
    let version = this.invalidationVersion.get(cacheKey);

    if (!version) {
      version = randomUUID();
      this.invalidationVersion.set(cacheKey, version);
    }

    return version;
  }

  /**
   * Increment cache version (call on invalidation).
   */
  incrementCacheVersion(): string {
    const cacheKey = CacheKey.marketplaceStats();
    const newVersion = randomUUID();
    this.invalidationVersion.set(cacheKey, newVersion);
    return newVersion;
  }

  /**
   * Clear all tracking (for testing).
   */
  clear(): void {
    this.concurrentRequests.clear();
    this.lastInvalidation.clear();
    this.maxConcurrent.clear();
    this.invalidationVersion.clear();
  }
}

export const marketplaceCacheInvalidationService = new MarketplaceCacheInvalidationService();
