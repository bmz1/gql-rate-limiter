import { Redis } from 'ioredis';

declare module 'ioredis' {
  interface RedisCommander {
    shopifylimit(
      tokenKey: string,
      timestampKey: string,
      shopifyStateKey: string,
      concurrencyKey: string,
      cost: number,
      now: number,
      tokensPerSecond: number,
      bucketCapacity: number,
      maxConcurrency: number
    ): Promise<[number, number, number]>;
  }

  interface Redis {
    defineCommand(
      name: string,
      options: {
        numberOfKeys: number;
        lua: string;
      }
    ): void;
  }
}

interface ShopifyThrottle {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

interface RateLimitResponse {
  allowed: boolean;
  waitTimeMs: number;
  remaining: number;
}

export class ShopifyRateLimiter {
  private readonly redis: Redis;
  private readonly syncScript: string;

  constructor(redis: Redis) {
    this.redis = redis;
    this.syncScript = `
      local tokenKey = KEYS[1]
      local timestampKey = KEYS[2]
      local shopifyStateKey = KEYS[3]
      local concurrencyKey = KEYS[4]
      
      -- Parse arguments
      local cost = tonumber(ARGV[1])
      local now = tonumber(ARGV[2])
      local tokensPerSecond = tonumber(ARGV[3])
      local bucketCapacity = tonumber(ARGV[4])
      local maxConcurrency = tonumber(ARGV[5])
      
      -- Get current state and Shopify state
      local currentTokens = tonumber(redis.call('get', tokenKey) or 0)
      local lastUpdate = tonumber(redis.call('get', timestampKey) or now)
      local shopifyState = redis.call('get', shopifyStateKey)
      local currentConcurrency = tonumber(redis.call('get', concurrencyKey) or 0)
      
      -- If we have Shopify state, use it to sync our bucket
      if shopifyState then
        local state = cjson.decode(shopifyState)
        currentTokens = bucketCapacity - state.currentlyAvailable
        tokensPerSecond = state.restoreRate
        bucketCapacity = state.maximumAvailable
      end
      
      -- Calculate tokens drained since last update
      local elapsedSeconds = (now - lastUpdate) / 1000
      local drained = elapsedSeconds * tokensPerSecond
      currentTokens = math.max(0, currentTokens - drained)
      
      -- Dynamic safety margin based on concurrency
      local baseMargin = 100
      local concurrencyMargin = math.min(maxConcurrency, currentConcurrency) * 20
      local safetyMargin = baseMargin + concurrencyMargin
      
      -- Adjust effective capacity based on current concurrency
      local effectiveCapacity = bucketCapacity - safetyMargin
      
      -- Track concurrent requests
      redis.call('incr', concurrencyKey)
      redis.call('expire', concurrencyKey, 10) -- Reset if no requests for 10s
      
      -- Check if operation is allowed
      if currentTokens + cost <= effectiveCapacity then
        -- More conservative token consumption for high concurrency
        local adjustedCost = cost * (1 + (currentConcurrency / maxConcurrency) * 0.2)
        redis.call('set', tokenKey, currentTokens + adjustedCost)
        redis.call('set', timestampKey, now)
        
        local remaining = math.max(0, effectiveCapacity - (currentTokens + adjustedCost))
        return {1, 0, remaining}
      end
      
      -- Calculate wait time with dynamic safety factor
      local tokensNeeded = cost + currentTokens - effectiveCapacity
      local baseFactor = 1.1
      local concurrencyFactor = 1 + (currentConcurrency / maxConcurrency) * 0.2
      local waitTimeMs = math.ceil(
        (tokensNeeded / tokensPerSecond) * 1000 * baseFactor * concurrencyFactor
      )
      
      local remaining = math.max(0, effectiveCapacity - currentTokens)
      return {0, waitTimeMs, remaining}
    `;

    this.redis.defineCommand('shopifylimit', {
      numberOfKeys: 4,
      lua: this.syncScript,
    });
  }

  async checkLimit(
    shop: string,
    cost: number,
    config: {
      bucketCapacity: number;
      tokensPerSecond: number;
      maxConcurrency?: number;
    }
  ): Promise<RateLimitResponse> {
    const tokenKey = `shopify:${shop}:tokens`;
    const timestampKey = `shopify:${shop}:timestamp`;
    const shopifyStateKey = `shopify:${shop}:state`;
    const concurrencyKey = `shopify:${shop}:concurrent`;

    const [allowed, waitTimeMs, remaining] = (await (this.redis as any).shopifylimit(
      tokenKey,
      timestampKey,
      shopifyStateKey,
      concurrencyKey,
      cost,
      Date.now(),
      config.tokensPerSecond,
      config.bucketCapacity,
      config.maxConcurrency || 5
    )) as [number, number, number];

    return {
      allowed: allowed === 1,
      waitTimeMs,
      remaining,
    };
  }

  async syncShopifyState(shop: string, throttleStatus: ShopifyThrottle): Promise<void> {
    const shopifyStateKey = `shopify:${shop}:state`;
    await this.redis.set(shopifyStateKey, JSON.stringify(throttleStatus), 'EX', 30);
  }
}
