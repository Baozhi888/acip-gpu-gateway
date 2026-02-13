import { createHash } from 'crypto';
import { Plugin, ACIPCore, Subscription, createEvent } from '@maxeven/acip-core';
import type { RequestEventPayload, RequestCompletedPayload, CachedResponse } from '../types/gateway';

export interface CachePluginConfig {
  enabled: boolean;
  ttlSeconds: number;
  maxSize: number;
}

/**
 * Response caching plugin.
 * Caches GET responses in Redis with configurable TTL.
 *
 * Redis keys: gateway:cache:{hash}, gateway:cache:keys
 */
export class CachePlugin implements Plugin {
  name = 'cache-plugin';
  version = '1.0.0';

  private core!: ACIPCore;
  private config: CachePluginConfig;
  private subscriptions: Subscription[] = [];

  constructor(config: CachePluginConfig) {
    this.config = config;
  }

  async install(core: ACIPCore): Promise<void> {
    this.core = core;

    if (!this.config.enabled) {
      console.log('[cache-plugin] Caching disabled');
      return;
    }

    // Check cache on incoming request (priority 80)
    const incomingSub = core.eventManager.subscribe<RequestEventPayload>(
      'gateway:request:incoming',
      async (event) => {
        const { method, path, context, res, id } = event.payload;

        // Only cache GET requests
        if (method !== 'GET') return;

        // Skip caching for gateway-local endpoints
        if (path.startsWith('/gateway/')) return;

        const cacheKey = this.computeCacheKey(method, path, event.payload.query);

        try {
          const cached = await core.stateManager.get<CachedResponse>(cacheKey);

          if (cached && this.isNotExpired(cached)) {
            // Cache hit
            context.cached = true;
            context.cachedResponse = cached;

            await core.eventManager.publish(
              createEvent('gateway:cache:hit', { requestId: id, cacheKey })
            );

            res.setHeader('X-Gateway-Cache', 'HIT');
            res.status(cached.statusCode);

            for (const [key, value] of Object.entries(cached.headers)) {
              if (key.toLowerCase() !== 'transfer-encoding') {
                res.setHeader(key, value);
              }
            }

            res.json(cached.body);
            event.cancel();
            return;
          }

          // Cache miss
          res.setHeader('X-Gateway-Cache', 'MISS');
          await core.eventManager.publish(
            createEvent('gateway:cache:miss', { requestId: id, cacheKey })
          );
        } catch (err) {
          console.warn('[cache-plugin] Cache read error:', (err as Error).message);
          res.setHeader('X-Gateway-Cache', 'ERROR');
        }
      },
      80 // After auth and rate limiting
    );

    this.subscriptions.push(incomingSub);

    // Store cacheable responses (priority 5 — runs after everything else)
    const completedSub = core.eventManager.subscribe<RequestCompletedPayload>(
      'gateway:request:completed',
      async (event) => {
        const { method, path, statusCode, cached } = event.payload;

        // Only cache successful GET responses
        if (method !== 'GET' || statusCode !== 200 || cached) return;

        // The actual response body storage is handled in the proxy middleware
        // via response interceptor. This event confirms caching intent.
      },
      5
    );

    this.subscriptions.push(completedSub);
  }

  async uninstall(): Promise<void> {
    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.subscriptions = [];
  }

  async onLoad(): Promise<void> {
    console.log(`[cache-plugin] Loaded (TTL: ${this.config.ttlSeconds}s, max: ${this.config.maxSize})`);
  }

  async onUnload(): Promise<void> {}

  /** Store a response in cache */
  async storeResponse(method: string, path: string, query: Record<string, string>, response: CachedResponse): Promise<void> {
    if (!this.config.enabled || method !== 'GET') return;

    const cacheKey = this.computeCacheKey(method, path, query);

    try {
      await this.core.stateManager.set(cacheKey, {
        ...response,
        cachedAt: Date.now(),
      });

      await this.core.eventManager.publish(
        createEvent('gateway:cache:stored', { cacheKey })
      );
    } catch (err) {
      console.warn('[cache-plugin] Cache write error:', (err as Error).message);
    }
  }

  /** Compute a cache key from method, path, and query params */
  private computeCacheKey(method: string, path: string, query: Record<string, string>): string {
    const sortedQuery = Object.keys(query)
      .sort()
      .map(k => `${k}=${query[k]}`)
      .join('&');
    const raw = `${method}:${path}?${sortedQuery}`;
    const hash = createHash('md5').update(raw).digest('hex');
    return `gateway:cache:${hash}`;
  }

  /** Check if a cached response is still within TTL */
  private isNotExpired(cached: CachedResponse): boolean {
    return Date.now() - cached.cachedAt < this.config.ttlSeconds * 1000;
  }

  getAPI() {
    return {
      storeResponse: this.storeResponse.bind(this),
      invalidate: async (pattern: string) => {
        // Could implement pattern-based cache invalidation
        console.log(`[cache-plugin] Invalidation requested for pattern: ${pattern}`);
      },
    };
  }
}
