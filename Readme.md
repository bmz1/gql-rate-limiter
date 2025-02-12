# GraphQL Rate Limiter

A sophisticated Redis-based rate limiter specifically designed for Shopify API applications, featuring dynamic token bucket implementation with concurrency control and adaptive safety margins.

## Features

- Token bucket algorithm with dynamic safety margins
- Automatic synchronization with Shopify's throttle state
- Concurrency tracking and management
- Adaptive cost calculation based on capacity and concurrent requests
- Debug logging capabilities
- TypeScript support with full type definitions

## Installation

```bash
npm install @bmz_1/graphql-rate-limiter ioredis
```

## Quick Start

```typescript
import { Redis } from 'ioredis';
import { ShopifyRateLimiter } from '@bmz_1/graphql-rate-limiter';

// Initialize Redis client
const redis = new Redis();

// Create rate limiter instance
const rateLimiter = new ShopifyRateLimiter(redis);

// Configure and use the rate limiter
const config = {
  bucketCapacity: 1000,
  tokensPerSecond: 50,
  maxConcurrency: 5
};

try {
  const result = await rateLimiter.checkLimit('my-shop.myshopify.com', 10, config);
  if (result.allowed) {
    // Proceed with API call
    try {
      // Your API call here
    } finally {
      // Always release concurrency after operation
      await rateLimiter.releaseConcurrency('my-shop.myshopify.com');
    }
  } else {
    // Wait for suggested time
    await new Promise(resolve => setTimeout(resolve, result.waitTimeMs));
  }
} catch (error) {
  console.error('Rate limiting error:', error);
}
```

## Configuration Options

The rate limiter accepts the following configuration parameters:

```typescript
interface RateLimitConfig {
  bucketCapacity: number;          // Maximum token capacity
  tokensPerSecond: number;         // Token restoration rate
  maxConcurrency?: number;         // Maximum concurrent requests (default: 5)
  baseMargin?: number;             // Base safety margin (default: 70)
  concurrencyMultiplier?: number;  // Safety margin per concurrent request (default: 10)
  concurrencyFactor?: number;      // High concurrency cost adjustment (default: 0.2)
  baseFactor?: number;             // Wait time calculation factor (default: 1.1)
  debug?: boolean;                 // Enable debug logging (default: false)
}
```

## API Reference

### ShopifyRateLimiter Class

#### Constructor

```typescript
constructor(redis: Redis)
```

Creates a new instance of the rate limiter.

- `redis`: An instance of ioredis client

#### Methods

##### `checkLimit(shop: string, cost: number, config: RateLimitConfig): Promise<RateLimitResponse>`

Checks if an operation is allowed under the current rate limits.

Parameters:
- `shop`: Shopify store domain
- `cost`: Token cost for the operation
- `config`: Rate limiting configuration

Returns:
```typescript
interface RateLimitResponse {
  allowed: boolean;     // Whether the operation is allowed
  waitTimeMs: number;   // Suggested wait time if throttled
  remaining: number;    // Remaining token capacity
}
```

##### `releaseConcurrency(shop: string): Promise<void>`

Safely releases a concurrency slot for the specified shop.

##### `syncShopifyState(shop: string, throttleStatus: ShopifyThrottle): Promise<void>`

Synchronizes the rate limiter with Shopify's current throttle state.

Parameters:
- `throttleStatus`:
```typescript
interface ShopifyThrottle {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}
```

##### `cleanupShop(shop: string): Promise<void>`

Cleans up all rate limiting data for a specific shop.

## Advanced Features

### Dynamic Safety Margins

The rate limiter implements dynamic safety margins that automatically adjust based on:
- Current capacity utilization
- Number of concurrent requests
- Shopify's throttle state

When capacity drops below 30%, safety margins are automatically increased to prevent throttling.

### Adaptive Cost Calculation

Request costs are dynamically adjusted based on:
- Current capacity utilization
- Concurrent request count
- Base operation cost

This ensures better resource distribution under high load.

### Shopify State Synchronization

The rate limiter can sync with Shopify's throttle state to maintain accurate limits:

```typescript
// After receiving Shopify's throttle headers
await rateLimiter.syncShopifyState('my-shop.myshopify.com', {
  maximumAvailable: 1000,
  currentlyAvailable: 950,
  restoreRate: 50
});
```

### Debug Logging

Enable debug logging for detailed insights:

```typescript
const result = await rateLimiter.checkLimit('my-shop.myshopify.com', 10, {
  ...config,
  debug: true
});
```

## Best Practices

1. Always release concurrency after operations:
```typescript
try {
  // Your API call
} finally {
  await rateLimiter.releaseConcurrency(shop);
}
```

2. Implement exponential backoff for retries:
```typescript
let retries = 0;
while (retries < maxRetries) {
  const result = await rateLimiter.checkLimit(shop, cost, config);
  if (result.allowed) {
    return await makeApiCall();
  }
  await new Promise(resolve => setTimeout(resolve, result.waitTimeMs * Math.pow(2, retries)));
  retries++;
}
```

3. Regularly sync with Shopify's throttle state:
```typescript
// After each API call, update with values from headers
await rateLimiter.syncShopifyState(shop, {
  maximumAvailable: parseInt(headers['x-shopify-shop-api-call-limit'].split('/')[1]),
  currentlyAvailable: parseInt(headers['x-shopify-shop-api-call-limit'].split('/')[0]),
  restoreRate: 50 // Adjust based on your API version and limit
});
```

## Error Handling

The rate limiter throws errors for invalid configurations:
- Invalid bucket capacity
- Invalid tokens per second
- Invalid max concurrency

Always wrap rate limiter calls in try-catch blocks and implement appropriate error handling.

## License

MIT

## Contributing

Contributions are welcome! Please submit issues and pull requests on GitHub.
