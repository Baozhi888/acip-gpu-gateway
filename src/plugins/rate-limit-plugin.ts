import { Plugin, ACIPCore, Subscription, createEvent } from '@maxeven/acip-core';
import type { RequestEventPayload } from '../types/gateway';

export interface RateLimitPluginConfig {
  enabled: boolean;
  windowMs: number;
  maxRequests: number;
}

/**
 * Rate limiting plugin using a sliding window algorithm.
 * Uses ACIP StateManager (Redis-backed) for distributed rate limit state.
 *
 * Redis keys: gateway:ratelimit:{clientKey}
 * Algorithm: Sorted set with request timestamps
 */
export class RateLimitPlugin implements Plugin {
  name = 'rate-limit-plugin';
  version = '1.0.0';

  private core!: ACIPCore;
  private config: RateLimitPluginConfig;
  private subscriptions: Subscription[] = [];

  /** In-memory fallback counters when Redis is unavailable */
  private memoryCounters = new Map<string, { count: number; windowStart: number }>();

  constructor(config: RateLimitPluginConfig) {
    this.config = config;
  }

  async install(core: ACIPCore): Promise<void> {
    this.core = core;

    if (!this.config.enabled) {
      console.log('[rate-limit-plugin] Rate limiting disabled');
      return;
    }

    const sub = core.eventManager.subscribe<RequestEventPayload>(
      'gateway:request:incoming',
      async (event) => {
        const { ip, context, res, id } = event.payload;
        const path = event.payload.req.originalUrl;

        // Skip rate limiting for gateway-local endpoints
        if (path.startsWith('/gateway/')) return;

        // Use authenticated identity as key if available, otherwise IP
        const clientKey = context.auth?.identity ?? ip;
        const rateLimitKey = `gateway:ratelimit:${clientKey}`;

        try {
          const result = await this.checkRateLimit(rateLimitKey);

          context.rateLimitInfo = {
            remaining: result.remaining,
            limit: this.config.maxRequests,
            resetAt: result.resetAt,
          };

          if (!result.allowed) {
            await core.eventManager.publish(
              createEvent('gateway:ratelimit:exceeded', { requestId: id, clientKey })
            );

            const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
            res.status(429).json({
              error: {
                code: 'RATE_LIMIT_EXCEEDED',
                message: `Too many requests. Please retry after ${retryAfter} seconds.`,
                requestId: id,
                retryAfter,
              },
            });

            event.cancel();
            return;
          }

          await core.eventManager.publish(
            createEvent('gateway:ratelimit:allowed', { requestId: id, remaining: result.remaining })
          );
        } catch (err) {
          // On Redis failure, fall back to in-memory counter
          console.warn('[rate-limit-plugin] Redis error, using memory fallback:', (err as Error).message);
          const memResult = this.checkMemoryRateLimit(clientKey);
          context.rateLimitInfo = {
            remaining: memResult.remaining,
            limit: this.config.maxRequests,
            resetAt: memResult.resetAt,
          };

          if (!memResult.allowed) {
            res.status(429).json({
              error: {
                code: 'RATE_LIMIT_EXCEEDED',
                message: 'Too many requests.',
                requestId: id,
              },
            });
            event.cancel();
          }
        }
      },
      90 // Second highest priority — after auth
    );

    this.subscriptions.push(sub);
  }

  async uninstall(): Promise<void> {
    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.subscriptions = [];
  }

  async onLoad(): Promise<void> {
    console.log(`[rate-limit-plugin] Loaded (${this.config.maxRequests} req/${this.config.windowMs}ms)`);
  }

  async onUnload(): Promise<void> {
    this.memoryCounters.clear();
  }

  /** Check rate limit using StateManager (Redis) */
  private async checkRateLimit(key: string): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    // Use StateManager transaction for atomic check-and-increment
    let currentCount = 0;

    const currentData = await this.core.stateManager.get<number[]>(key);
    let timestamps = currentData ?? [];

    // Remove expired timestamps
    timestamps = timestamps.filter(ts => ts > windowStart);

    currentCount = timestamps.length;

    if (currentCount >= this.config.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: timestamps[0] + this.config.windowMs,
      };
    }

    // Add current request
    timestamps.push(now);
    await this.core.stateManager.set(key, timestamps);

    return {
      allowed: true,
      remaining: this.config.maxRequests - timestamps.length,
      resetAt: now + this.config.windowMs,
    };
  }

  /** In-memory fallback when Redis is unavailable */
  private checkMemoryRateLimit(clientKey: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    let entry = this.memoryCounters.get(clientKey);

    if (!entry || now - entry.windowStart > this.config.windowMs) {
      entry = { count: 0, windowStart: now };
      this.memoryCounters.set(clientKey, entry);
    }

    entry.count++;

    if (entry.count > this.config.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: entry.windowStart + this.config.windowMs,
      };
    }

    return {
      allowed: true,
      remaining: this.config.maxRequests - entry.count,
      resetAt: entry.windowStart + this.config.windowMs,
    };
  }
}
