import dotenv from 'dotenv';
import type { GatewayConfig, RouterStrategy } from './types/gateway';

dotenv.config();

function env(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

function envInt(key: string, defaultValue: number): number {
  const val = process.env[key];
  return val ? parseInt(val, 10) : defaultValue;
}

function envBool(key: string, defaultValue: boolean): boolean {
  const val = process.env[key];
  if (!val) return defaultValue;
  return val.toLowerCase() === 'true' || val === '1';
}

export function loadConfig(): GatewayConfig {
  return {
    port: envInt('GATEWAY_PORT', 3000),
    host: env('GATEWAY_HOST', '0.0.0.0'),
    env: env('NODE_ENV', 'development'),

    fastapi: {
      url: env('FASTAPI_URL', 'http://localhost:8000'),
      timeout: envInt('FASTAPI_TIMEOUT', 30000),
    },

    redis: {
      url: env('REDIS_URL', 'redis://localhost:6379'),
      password: process.env.REDIS_PASSWORD || undefined,
      db: envInt('REDIS_DB', 0),
      keyPrefix: env('REDIS_KEY_PREFIX', 'gateway:'),
    },

    auth: {
      enabled: envBool('AUTH_ENABLED', true),
      tokenSalt: env('AUTH_TOKEN_SALT', 'distributed-gpu-inference-v1'),
      apiKeys: env('AUTH_API_KEYS', '')
        .split(',')
        .map(k => k.trim())
        .filter(Boolean),
    },

    rateLimit: {
      enabled: envBool('RATE_LIMIT_ENABLED', true),
      windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60000),
      maxRequests: envInt('RATE_LIMIT_MAX_REQUESTS', 100),
    },

    cache: {
      enabled: envBool('CACHE_ENABLED', true),
      ttlSeconds: envInt('CACHE_TTL_SECONDS', 60),
      maxSize: envInt('CACHE_MAX_SIZE', 1000),
    },

    router: {
      strategy: env('ROUTER_STRATEGY', 'round-robin') as RouterStrategy,
      healthCheckInterval: envInt('ROUTER_HEALTH_CHECK_INTERVAL', 10000),
    },

    metrics: {
      enabled: envBool('METRICS_ENABLED', true),
      path: env('METRICS_PATH', '/gateway/metrics'),
    },

    otel: {
      enabled: envBool('OTEL_ENABLED', false),
      serviceName: env('OTEL_SERVICE_NAME', 'acip-gpu-gateway'),
      zipkinEndpoint: process.env.OTEL_ZIPKIN_ENDPOINT || undefined,
    },

    logLevel: env('LOG_LEVEL', 'info'),

    cors: {
      origin: env('CORS_ORIGIN', '*'),
      methods: env('CORS_METHODS', 'GET,POST,PUT,DELETE,OPTIONS'),
    },
  };
}
