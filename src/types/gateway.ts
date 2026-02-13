import type { Request, Response } from 'express';
import type { ACIPCore } from '@maxeven/acip-core';

/** Gateway configuration loaded from environment */
export interface GatewayConfig {
  port: number;
  host: string;
  env: string;

  fastapi: {
    url: string;
    timeout: number;
  };

  redis: {
    url: string;
    password?: string;
    db: number;
    keyPrefix: string;
  };

  auth: {
    enabled: boolean;
    tokenSalt: string;
    apiKeys: string[];
  };

  rateLimit: {
    enabled: boolean;
    windowMs: number;
    maxRequests: number;
  };

  cache: {
    enabled: boolean;
    ttlSeconds: number;
    maxSize: number;
  };

  router: {
    strategy: RouterStrategy;
    healthCheckInterval: number;
  };

  metrics: {
    enabled: boolean;
    path: string;
  };

  otel: {
    enabled: boolean;
    serviceName: string;
    zipkinEndpoint?: string;
  };

  logLevel: string;

  cors: {
    origin: string;
    methods: string;
  };
}

export type RouterStrategy = 'round-robin' | 'least-connections' | 'region-affinity';

/** Extended Express Request with gateway context */
export interface GatewayRequest extends Request {
  /** Unique request ID (UUID v4) */
  requestId: string;

  /** Start timestamp for duration calculation */
  startTime: number;

  /** Authenticated user/worker info (set by auth plugin) */
  auth?: {
    type: 'token' | 'api-key' | 'bearer';
    identity: string;
  };

  /** Target FastAPI URL (set by router plugin) */
  targetUrl?: string;

  /** Whether response was served from cache */
  cached?: boolean;
}

/** Extended Express Response with gateway context */
export interface GatewayResponse extends Response {
  /** Whether this response was served from cache */
  fromCache?: boolean;
}

/** Request event payload published on 'gateway:request:incoming' */
export interface RequestEventPayload {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string>;
  body?: unknown;
  ip: string;
  timestamp: number;

  /** Mutable context: plugins attach data here */
  context: RequestContext;

  /** Express request reference for middleware interop */
  req: GatewayRequest;
  res: GatewayResponse;
}

/** Shared mutable context carried through the request pipeline */
export interface RequestContext {
  auth?: {
    type: 'token' | 'api-key' | 'bearer';
    identity: string;
  };
  targetUrl?: string;
  cached?: boolean;
  cachedResponse?: CachedResponse;
  rateLimitInfo?: {
    remaining: number;
    limit: number;
    resetAt: number;
  };
}

/** Request completed event payload */
export interface RequestCompletedPayload {
  id: string;
  method: string;
  path: string;
  statusCode: number;
  duration: number;
  targetUrl: string;
  cached: boolean;
  cancelled: boolean;
}

/** Cached response structure */
export interface CachedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  cachedAt: number;
}

/** Health check result */
export interface HealthCheckResult {
  status: 'healthy' | 'unhealthy' | 'degraded';
  uptime: number;
  version: string;
  timestamp: string;
  checks?: {
    redis?: { status: string; latency_ms: number };
    fastapi?: { status: string; latency_ms: number; url: string };
    plugins?: { loaded: number; active: number; errors: number; details?: Record<string, string> };
  };
  resources?: {
    memory_used_mb: number;
    cpu_percent: number;
  };
  errors?: string[];
}

/** Plugin status info */
export interface PluginStatusInfo {
  name: string;
  version: string;
  status: string;
  dependencies: string[];
}
