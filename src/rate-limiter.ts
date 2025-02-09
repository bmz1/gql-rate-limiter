import { Redis } from 'ioredis';

declare module 'ioredis' {
  interface RedisCommander {
    /**
     * Executes the Shopify rate-limit check.
     *
     * @param tokenKey - Key tracking the tokens consumed.
     * @param timestampKey - Key tracking the last update timestamp.
     * @param shopifyStateKey - Key containing Shopify throttle state.
     * @param concurrencyKey - Key tracking the current concurrency.
     * @param cost - The token cost for the current operation.
     * @param tokensPerSecond - The token restoration rate.
     * @param bucketCapacity - The maximum capacity of the bucket.
     * @param maxConcurrency - The maximum allowed concurrency.
     * @param baseMargin - The base safety margin.
     * @param concurrencyMultiplier - Multiplier for extra safety margin per concurrent request.
     * @param concurrencyFactor - Factor used to adjust token cost under high concurrency.
     * @param baseFactor - Base factor used in wait time calculation.
     * @returns An array with [allowed, waitTimeMs, remainingTokens].
     */
    shopifylimit(
      tokenKey: string,
      timestampKey: string,
      shopifyStateKey: string,
      concurrencyKey: string,
      cost: number,
      tokensPerSecond: number,
      bucketCapacity: number,
      maxConcurrency: number,
      baseMargin: number,
      concurrencyMultiplier: number,
      concurrencyFactor: number,
      baseFactor: number,
      debug?: boolean
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

/**
 * Represents the Shopify throttle state.
 */
interface ShopifyThrottle {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

/**
 * Response returned from the rate limiter check.
 */
interface RateLimitResponse {
  allowed: boolean;
  waitTimeMs: number;
  remaining: number;
}

/**
 * Configuration options for the rate limiter.
 */
interface RateLimitConfig {
  bucketCapacity: number;
  tokensPerSecond: number;
  maxConcurrency?: number;
  baseMargin?: number;
  concurrencyMultiplier?: number;
  concurrencyFactor?: number;
  baseFactor?: number;
  debug?: boolean;
}

/**
 * ShopifyRateLimiter uses a Lua-scripted token-bucket approach with dynamic safety margins and concurrency tracking.
 */
export class ShopifyRateLimiter {
  private readonly redis: Redis;
  private readonly syncScript: string;

  constructor(redis: Redis) {
    this.redis = redis;
    this.syncScript = `--[[
  Shopify Rate Limiter Lua Script

  Keys:
    KEYS[1] - tokenKey: Tracks consumed tokens
    KEYS[2] - timestampKey: Last update timestamp
    KEYS[3] - shopifyStateKey: Shopify throttle state
    KEYS[4] - concurrencyKey: Concurrent requests counter

  Arguments:
    ARGV[1] - cost: Token cost for operation
    ARGV[2] - tokensPerSecond: Token restore rate
    ARGV[3] - bucketCapacity: Maximum tokens
    ARGV[4] - maxConcurrency: Max concurrent requests
    ARGV[5] - baseMargin: Base safety margin
    ARGV[6] - concurrencyMultiplier: Extra margin per concurrent request
    ARGV[7] - concurrencyFactor: High concurrency cost adjustment
    ARGV[8] - baseFactor: Wait time adjustment
    ARGV[9] - debug: Enable debug logging (1 for true, 0 for false)

  Returns: [allowed, waitTimeMs, remaining]
    allowed: 1 if allowed, 0 if throttled
    waitTimeMs: Suggested wait time if throttled
    remaining: Remaining token capacity
--]]

-- Input validation
local cost = tonumber(ARGV[1])
if not cost then error("Invalid cost") end

local tokensPerSecond = tonumber(ARGV[2])
if not tokensPerSecond then error("Invalid tokensPerSecond") end

local bucketCapacity = tonumber(ARGV[3])
if not bucketCapacity then error("Invalid bucketCapacity") end

local maxConcurrency = tonumber(ARGV[4])
if not maxConcurrency then error("Invalid maxConcurrency") end

local baseMargin = tonumber(ARGV[5])
if not baseMargin then error("Invalid baseMargin") end

local concurrencyMultiplier = tonumber(ARGV[6])
if not concurrencyMultiplier then error("Invalid concurrencyMultiplier") end

local concurrencyFactor = tonumber(ARGV[7])
if not concurrencyFactor then error("Invalid concurrencyFactor") end

local baseFactor = tonumber(ARGV[8])
if not baseFactor then error("Invalid baseFactor") end

local debug = tonumber(ARGV[9]) == 1

-- Helper function for debug logging
local function debugLog(message)
  if debug then
    redis.call('lpush', 'shopify:debug:log', message)
    redis.call('ltrim', 'shopify:debug:log', 0, 999) -- Keep last 1000 entries
  end
end

-- Get current server time in milliseconds
local timeArr = redis.call('TIME')
local now = tonumber(timeArr[1]) * 1000 + math.floor(tonumber(timeArr[2]) / 1000)

-- Get current token count and last update time
local currentTokens = tonumber(redis.call('get', KEYS[1]) or 0)
local lastUpdate = tonumber(redis.call('get', KEYS[2]) or now)

-- Calculate token regeneration
local elapsedSeconds = (now - lastUpdate) / 1000
local drained = elapsedSeconds * tokensPerSecond
currentTokens = math.max(0, currentTokens - drained)

-- Check for Shopify state and update if available
local shopifyState = redis.call('get', KEYS[3])
if shopifyState then
  local success, state = pcall(cjson.decode, shopifyState)
  if success and state then
    if type(state.currentlyAvailable) == 'number' and 
       type(state.restoreRate) == 'number' and 
       type(state.maximumAvailable) == 'number' then
      -- Sync with Shopify's current state
      currentTokens = bucketCapacity - state.currentlyAvailable
      tokensPerSecond = state.restoreRate
      bucketCapacity = state.maximumAvailable
      
      debugLog(string.format(
        'Shopify state sync - Available: %d, Rate: %d, Max: %d',
        state.currentlyAvailable,
        state.restoreRate,
        state.maximumAvailable
      ))
    end
  end
end

-- Get and validate concurrency
local currentConcurrency = tonumber(redis.call('get', KEYS[4]) or 0)
if currentConcurrency < 0 then
  currentConcurrency = 0
  redis.call('set', KEYS[4], 0)
end
local effectiveConcurrency = currentConcurrency + 1

-- Calculate remaining capacity
local remainingCapacity = bucketCapacity - currentTokens
local capacityPercentage = (remainingCapacity / bucketCapacity) * 100

-- Dynamic safety margins based on capacity
local dynamicBaseMargin = baseMargin
local dynamicConcurrencyMultiplier = concurrencyMultiplier

-- Increase margins when capacity is low (below 30%)
if capacityPercentage < 30 then
  local marginMultiplier = 1 + ((30 - capacityPercentage) / 30)
  dynamicBaseMargin = baseMargin * marginMultiplier
  dynamicConcurrencyMultiplier = concurrencyMultiplier * marginMultiplier
  
  -- Extra safety when very low (below 10%)
  if capacityPercentage < 10 then
    dynamicBaseMargin = dynamicBaseMargin * 1.5
    dynamicConcurrencyMultiplier = dynamicConcurrencyMultiplier * 1.5
  end
  
  debugLog(string.format(
    'Low capacity alert - %.2f%% remaining, margins increased by %.2fx',
    capacityPercentage,
    marginMultiplier
  ))
end

-- Calculate final safety margins
local concurrencyMargin = math.min(maxConcurrency, effectiveConcurrency) * dynamicConcurrencyMultiplier
local safetyMargin = dynamicBaseMargin + concurrencyMargin
local effectiveCapacity = bucketCapacity - safetyMargin

-- Calculate adjusted cost based on capacity and concurrency
local capacityFactor = 1 + math.max(0, (30 - capacityPercentage) / 30)
local concurrencyFactor = 1 + (effectiveConcurrency / maxConcurrency)
local adjustedCost = cost * capacityFactor * concurrencyFactor

-- Check if we can proceed
if currentTokens + adjustedCost <= effectiveCapacity then
  debugLog(string.format(
    'Request approved - Capacity: %.2f%%, Tokens: %d, Cost: %.2f, Margin: %.2f',
    capacityPercentage,
    currentTokens,
    adjustedCost,
    safetyMargin
  ))
  
  -- Update tokens and concurrency
  redis.call('set', KEYS[1], currentTokens + adjustedCost)
  redis.call('set', KEYS[2], now)
  redis.call('incr', KEYS[4])
  redis.call('expire', KEYS[4], 10)
  
  local remaining = math.max(0, effectiveCapacity - (currentTokens + adjustedCost))
  return {1, 0, remaining}
end

-- Calculate wait time for throttled requests
local tokensNeeded = adjustedCost + currentTokens - effectiveCapacity
local waitFactor = baseFactor * capacityFactor
local waitTimeMs = math.ceil((tokensNeeded / tokensPerSecond) * 1000 * waitFactor)

debugLog(string.format(
  'Request throttled - Capacity: %.2f%%, Tokens: %d, Needed: %.2f, Wait: %d',
  capacityPercentage,
  currentTokens,
  tokensNeeded,
  waitTimeMs
))

local remaining = math.max(0, effectiveCapacity - currentTokens)
return {0, waitTimeMs, remaining}`;

    // Register the command with Redis. We have 4 keys.
    this.redis.defineCommand('shopifylimit', {
      numberOfKeys: 4,
      lua: this.syncScript,
    });
  }

  private validateConfig(config: RateLimitConfig): void {
    if (config.bucketCapacity <= 0) throw new Error('Invalid bucket capacity');
    if (config.tokensPerSecond <= 0) throw new Error('Invalid tokens per second');
    if (config.maxConcurrency && config.maxConcurrency <= 0) throw new Error('Invalid max concurrency');
  }

  /**
   * Checks the rate limit for a given shop and operation cost.
   * If allowed, the method reserves tokens and increments concurrency.
   *
   * @param shop - The shop identifier.
   * @param cost - The token cost of the operation.
   * @param config - Rate limiting configuration parameters.
   * @returns A promise resolving to a RateLimitResponse indicating whether the operation is allowed,
   *          the wait time (in ms) if not allowed, and the remaining effective capacity.
   */
  async checkLimit(shop: string, cost: number, config: RateLimitConfig): Promise<RateLimitResponse> {
    this.validateConfig(config);
    const tokenKey = `shopify:${shop}:tokens`;
    const timestampKey = `shopify:${shop}:timestamp`;
    const shopifyStateKey = `shopify:${shop}:state`;
    const concurrencyKey = `shopify:${shop}:concurrent`;

    // Note: We no longer pass the current time; the script fetches Redis time.
    const [allowed, waitTimeMs, remaining] = (await (this.redis as any).shopifylimit(
      tokenKey,
      timestampKey,
      shopifyStateKey,
      concurrencyKey,
      cost,
      config.tokensPerSecond,
      config.bucketCapacity,
      config.maxConcurrency || 5,
      config.baseMargin || 70,
      config.concurrencyMultiplier || 10,
      config.concurrencyFactor || 0.2,
      config.baseFactor || 1.1,
      config.debug ? 1 : 0
    )) as [number, number, number];

    return {
      allowed: allowed === 1,
      waitTimeMs,
      remaining,
    };
  }

  /**
   * Safely releases a concurrency slot, preventing negative values
   */
  async releaseConcurrency(shop: string): Promise<void> {
    const concurrencyKey = `shopify:${shop}:concurrent`;

    // Use Lua script to safely decrement and prevent negative values
    const safeDecrScript = `
    local current = tonumber(redis.call('get', KEYS[1]) or '0')
    if current > 0 then
      return redis.call('decr', KEYS[1])
    else
      redis.call('set', KEYS[1], 0)
      return 0
    end
  `;

    await this.redis.eval(
      safeDecrScript,
      1, // number of keys
      concurrencyKey // the key
    );
  }

  /**
   * Synchronizes Shopify throttle state with Redis.
   *
   * @param shop - The shop identifier.
   * @param throttleStatus - The current throttle status from Shopify.
   */
  async syncShopifyState(shop: string, throttleStatus: ShopifyThrottle): Promise<void> {
    const shopifyStateKey = `shopify:${shop}:state`;
    await this.redis.set(shopifyStateKey, JSON.stringify(throttleStatus), 'EX', 10);
  }

  async cleanupShop(shop: string): Promise<void> {
    const keys = [
      `shopify:${shop}:tokens`,
      `shopify:${shop}:timestamp`,
      `shopify:${shop}:state`,
      `shopify:${shop}:concurrent`,
    ];
    await this.redis.del(...keys);
  }
}
