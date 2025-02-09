import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import Redis from 'ioredis';
import { ShopifyRateLimiter } from '../src/rate-limiter';

const DEFAULT_CONFIG = {
  bucketCapacity: 2000,
  tokensPerSecond: 100,
  maxConcurrency: 5,
};

describe('ShopifyRateLimiter', () => {
  // Unit Tests
  describe('unit tests', () => {
    let redis: Redis;
    let limiter: ShopifyRateLimiter;

    beforeEach(() => {
      redis = {
        defineCommand: vi.fn(),
        shopifylimit: vi.fn(),
        set: vi.fn(),
        quit: vi.fn(),
      } as unknown as Redis;

      limiter = new ShopifyRateLimiter(redis);
    });

    it('should handle successful rate limit check', async () => {
      vi.mocked(redis.shopifylimit).mockResolvedValueOnce([1, 0, 1800]);

      const result = await limiter.checkLimit('test-shop', 50, DEFAULT_CONFIG);

      expect(result).toEqual({
        allowed: true,
        waitTimeMs: 0,
        remaining: 1800,
      });
    });

    it('should handle rate limit exceeded', async () => {
      vi.mocked(redis.shopifylimit).mockResolvedValueOnce([0, 1000, 0]);

      const result = await limiter.checkLimit('test-shop', 50, DEFAULT_CONFIG);

      expect(result).toEqual({
        allowed: false,
        waitTimeMs: 1000,
        remaining: 0,
      });
    });

    it('should sync Shopify state', async () => {
      const throttleStatus = {
        maximumAvailable: 2000,
        currentlyAvailable: 1500,
        restoreRate: 100,
      };

      await limiter.syncShopifyState('test-shop', throttleStatus);

      expect(redis.set).toHaveBeenCalledWith('shopify:test-shop:state', JSON.stringify(throttleStatus), 'EX', 10);
    });
  });

  // Integration Tests
  describe('integration tests', () => {
    let redis: Redis;
    let limiter: ShopifyRateLimiter;

    beforeEach(async () => {
      redis = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT) || 6379,
        db: 15, // Use separate DB for tests
      });

      limiter = new ShopifyRateLimiter(redis);
      await redis.flushdb();
    });

    afterEach(async () => {
      await redis.quit();
    });

    describe('basic functionality', () => {
      it('should allow requests within capacity', async () => {
        const result = await limiter.checkLimit('test-shop', 50, DEFAULT_CONFIG);

        expect(result.allowed).toBe(true);
        expect(result.remaining).toBeGreaterThan(0);
      });

      it('should block requests exceeding capacity', async () => {
        // First use most of the capacity
        const r = await limiter.checkLimit('test-shop2', 1500, DEFAULT_CONFIG);
        // Then try to use more
        const result = await limiter.checkLimit('test-shop2', 600, DEFAULT_CONFIG);
        expect(result.allowed).toBe(false);
        expect(result.waitTimeMs).toBeGreaterThan(0);
      });

      it('should respect Shopify state sync', async () => {
        // Sync a low available state
        await limiter.syncShopifyState('test-shop', {
          maximumAvailable: 2000,
          currentlyAvailable: 100,
          restoreRate: 100,
        });

        const result = await limiter.checkLimit('test-shop', 150, DEFAULT_CONFIG);

        expect(result.allowed).toBe(false);
        expect(result.waitTimeMs).toBeGreaterThan(0);
      });
    });

    describe('multi-store isolation', () => {
      const stores = ['store1', 'store2', 'store3'];

      it('should maintain separate limits for each store', async () => {
        // Use significant capacity for store1
        await limiter.checkLimit('store1', 1500, DEFAULT_CONFIG);

        // Check other stores are unaffected
        const results = await Promise.all([
          limiter.checkLimit('store2', 500, DEFAULT_CONFIG),
          limiter.checkLimit('store3', 500, DEFAULT_CONFIG),
        ]);

        results.forEach(result => {
          expect(result.allowed).toBe(true);
        });
      });

      it('should sync state independently for each store', async () => {
        // Set different states for different stores
        await Promise.all([
          limiter.syncShopifyState('store1', {
            maximumAvailable: 2000,
            currentlyAvailable: 100,
            restoreRate: 100,
          }),
          limiter.syncShopifyState('store2', {
            maximumAvailable: 2000,
            currentlyAvailable: 1500,
            restoreRate: 100,
          }),
        ]);

        const [store1Result, store2Result] = await Promise.all([
          limiter.checkLimit('store1', 200, DEFAULT_CONFIG),
          limiter.checkLimit('store2', 200, DEFAULT_CONFIG),
        ]);

        expect(store1Result.allowed).toBe(false);
        expect(store2Result.allowed).toBe(true);
      });
    });

    describe('concurrency handling', () => {
      it('should handle parallel requests correctly', async () => {
        const PARALLEL_REQUESTS = 20;
        const COST_PER_REQUEST = 100;

        const requests = Array(PARALLEL_REQUESTS)
          .fill(0)
          .map(() =>
            limiter.checkLimit('test-shop', COST_PER_REQUEST, {
              ...DEFAULT_CONFIG,
              maxConcurrency: 10,
            })
          );

        const results = await Promise.all(requests);
        const allowedCount = results.filter(r => r.allowed).length;

        // Should allow fewer requests than theoretical capacity due to safety margins
        expect(allowedCount).toBeLessThan(DEFAULT_CONFIG.bucketCapacity / COST_PER_REQUEST);
        // But should still allow a reasonable number
        expect(allowedCount).toBeGreaterThan(0);
      });

      it('should increase wait times with higher concurrency', async () => {
        // First set high concurrency
        const highConcurrencyPromises = Array(10)
          .fill(0)
          .map(() => limiter.checkLimit('test-shop', 100, DEFAULT_CONFIG));
        await Promise.all(highConcurrencyPromises);

        // Then check wait time for exceeded limit
        const result = await limiter.checkLimit('test-shop', 1000, DEFAULT_CONFIG);

        expect(result.waitTimeMs).toBeGreaterThan(0);
      });

      it('should recover after concurrency drops', async () => {
        // First create high concurrency
        await Promise.all(
          Array(10)
            .fill(0)
            .map(() => limiter.checkLimit('test-shop', 100, DEFAULT_CONFIG))
        );

        // Wait for concurrency to expire
        await new Promise(resolve => setTimeout(resolve, 11000));

        // Should now allow new requests
        const result = await limiter.checkLimit('test-shop', 100, DEFAULT_CONFIG);
        expect(result.allowed).toBe(true);
      });
    });

    describe('edge cases', () => {
      it('should handle zero cost requests', async () => {
        const result = await limiter.checkLimit('test-shop', 0, DEFAULT_CONFIG);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(DEFAULT_CONFIG.bucketCapacity - 80); // Base safety margin
      });

      it('should handle missing maxConcurrency config', async () => {
        const { maxConcurrency, ...configWithoutConcurrency } = DEFAULT_CONFIG;
        const result = await limiter.checkLimit('test-shop', 50, configWithoutConcurrency);
        expect(result.allowed).toBe(true);
      });

      it('should handle very large cost requests', async () => {
        const result = await limiter.checkLimit('test-shop', 5000, DEFAULT_CONFIG);
        expect(result.allowed).toBe(false);
        expect(result.waitTimeMs).toBeGreaterThan(0);
      });
    });
  });
});
