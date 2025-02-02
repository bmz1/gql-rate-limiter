# Shopify GraphQL Rate Limiter

A Redis-based distributed rate limiter specifically designed for Shopify's GraphQL API. Handles concurrent requests, multiple stores, and automatically syncs with Shopify's throttle status.

## Features

- 🚀 Distributed rate limiting using Redis
- 🔄 Automatic sync with Shopify's throttle status
- 📊 Dynamic concurrency handling
- 🏢 Multi-store support
- 🔬 Precise cost tracking
- ⚡ High performance with Lua scripts

## Installation

```bash
npm install @bmz1/gql-rate-limiter
# or
yarn add @bmz1/gql-rate-limiter
```

### Requirements

- Redis 6.0 or higher
- Node.js 16.0 or higher
- TypeScript 4.5 or higher (for TypeScript users)

## Quick Start

```typescript
import { Redis } from 'ioredis';
import { ShopifyRateLimiter } from '@bmz1/gql-rate-limiter';

// Initialize Redis client
const redis = new Redis();

// Create rate limiter instance
const limiter = new ShopifyRateLimiter(redis);

// Use in your Shopify API calls
async function makeGraphQLRequest() {
  const result = await limiter.checkLimit(
    'my-shop.myshopify.com',
    20, // Expected query cost
    {
      bucketCapacity: 2000,
      tokensPerSecond: 100,
      maxConcurrency: 5
    }
  );

  if (!result.allowed) {
    console.log(`Rate limit exceeded. Wait ${result.waitTimeMs}ms`);
    await new Promise(resolve => setTimeout(resolve, result.waitTimeMs));
  }

  // Make your Shopify GraphQL request here...
  const response = await shopifyClient.query(/* ... */);

  // Sync actual cost with Shopify
  await limiter.syncShopifyState(
    'my-shop.myshopify.com',
    response.extensions.cost.throttleStatus
  );
}
```

## API Reference

### ShopifyRateLimiter

#### Constructor

```typescript
constructor(redis: Redis)
```

#### Methods

##### checkLimit

```typescript
async checkLimit(
  shop: string,
  cost: number,
  config: {
    bucketCapacity: number;
    tokensPerSecond: number;
    maxConcurrency?: number;
  }
): Promise<RateLimitResponse>
```

Parameters:
- `shop`: Shopify store domain or storeId
- `cost`: Expected query cost
- `config`: Rate limit configuration
  - `bucketCapacity`: Maximum token capacity (usually 2000)
  - `tokensPerSecond`: Token restore rate (usually 100)
  - `maxConcurrency`: Maximum concurrent requests (default: 5)

Returns:
```typescript
interface RateLimitResponse {
  allowed: boolean;     // Whether request is allowed
  waitTimeMs: number;   // Time to wait if not allowed
  remaining: number;    // Remaining tokens
}
```

##### syncShopifyState

```typescript
async syncShopifyState(
  shop: string,
  throttleStatus: ShopifyThrottle
): Promise<void>
```

Parameters:
- `shop`: Shopify store domain
- `throttleStatus`: Shopify's throttle status
  ```typescript
  interface ShopifyThrottle {
    maximumAvailable: number;
    currentlyAvailable: number;
    restoreRate: number;
  }
  ```

## Advanced Usage

### Queue Processing

```typescript
import pLimit from 'p-limit';

async function processQueue() {
  const limit = pLimit(5); // Match with maxConcurrency
  const tasks = requests.map(req => limit(() => 
    processWithRateLimit(req)
  ));
  
  await Promise.all(tasks);
}

async function processWithRateLimit(request) {
  const result = await limiter.checkLimit(/* ... */);
  if (!result.allowed) {
    await new Promise(resolve => 
      setTimeout(resolve, result.waitTimeMs + 500)
    );
  }
  // Process request...
}
```

### Multi-store Setup

The rate limiter automatically handles multiple stores independently:

```typescript
// Store 1
await limiter.checkLimit('store1.myshopify.com', 20, config);

// Store 2 (won't be affected by Store 1's limits)
await limiter.checkLimit('store2.myshopify.com', 20, config);
```

## Running Tests

```bash
# Start Redis for testing
docker-compose up -d

# Run all tests
npm test

# Run with coverage
npm test -- --coverage
```

## How It Works

The rate limiter uses a combination of:
1. Leaky bucket algorithm
2. Redis Lua scripts for atomicity
3. Dynamic safety margins based on concurrency
4. Automatic synchronization with Shopify's throttle status

Key features:
- Atomic operations using Lua scripts
- Distributed locking via Redis
- Concurrent request tracking
- Adaptive rate limiting based on actual Shopify feedback

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License

## Acknowledgments

- Inspired by Shopify's GraphQL rate limiting mechanism
- Built with Redis and ioredis
- Testing powered by Vitest
