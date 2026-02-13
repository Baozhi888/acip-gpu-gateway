import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { createEvent } from '@maxeven/acip-core';

import type { GatewayConfig, GatewayRequest, RequestEventPayload, RequestCompletedPayload } from './types/gateway';
import type { GatewayCore } from './gateway';
import { createProxyMiddleware } from './middleware/proxy';
import { createCorsMiddleware } from './middleware/cors';

export function createServer(gateway: GatewayCore) {
  const app = express();
  const config = gateway.getConfig();
  const core = gateway.getCore();

  // --- Base middleware ---
  app.use(helmet());
  app.use(createCorsMiddleware(config));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // --- Attach request ID and start time ---
  app.use((req, _res, next) => {
    const gwReq = req as GatewayRequest;
    gwReq.requestId = (req.headers['x-request-id'] as string) || uuidv4();
    gwReq.startTime = Date.now();
    next();
  });

  // --- Gateway-local endpoints (not proxied) ---

  // Health check
  app.get('/gateway/health', async (_req, res) => {
    const healthPlugin = core.pluginManager.getPluginAPI('health-plugin');
    if (healthPlugin) {
      const result = await healthPlugin.getHealth();
      const status = result.status === 'healthy' ? 200 : 503;
      res.status(status).json(result);
    } else {
      res.json({ status: 'healthy', version: '0.1.0', uptime: process.uptime() });
    }
  });

  app.get('/gateway/health/detailed', async (_req, res) => {
    const healthPlugin = core.pluginManager.getPluginAPI('health-plugin');
    if (healthPlugin) {
      const result = await healthPlugin.getDetailedHealth();
      const status = result.status === 'healthy' ? 200 : 503;
      res.status(status).json(result);
    } else {
      res.status(501).json({ error: 'Health plugin not loaded' });
    }
  });

  // Metrics endpoint (handled by metrics plugin)
  app.get(config.metrics.path, async (_req, res) => {
    const metricsPlugin = core.pluginManager.getPluginAPI('metrics-plugin');
    if (metricsPlugin) {
      const metrics = await metricsPlugin.getMetrics();
      res.set('Content-Type', 'text/plain; charset=utf-8');
      res.send(metrics);
    } else {
      res.status(501).send('# Metrics plugin not loaded\n');
    }
  });

  // Plugin status
  app.get('/gateway/plugins', (_req, res) => {
    const allInfo = core.pluginManager.getAllPluginInfo();
    const plugins = Array.from(allInfo.values()).map(info => ({
      name: info.plugin.name,
      version: info.plugin.version,
      status: info.status,
      dependencies: info.dependencies,
    }));

    const active = plugins.filter(p => p.status === 'active').length;
    const loaded = plugins.filter(p => p.status === 'loaded').length;
    const errorCount = plugins.filter(p => p.status === 'error').length;

    res.json({ plugins, total: plugins.length, active, loaded, error: errorCount });
  });

  // Runtime config (masked)
  app.get('/gateway/config', (_req, res) => {
    res.json({
      gateway: { port: config.port, host: config.host, env: config.env },
      fastapi: { url: config.fastapi.url, timeout: config.fastapi.timeout },
      redis: { url: config.redis.url.replace(/\/\/.*@/, '//***@'), keyPrefix: config.redis.keyPrefix },
      auth: { enabled: config.auth.enabled, apiKeysCount: config.auth.apiKeys.length },
      rateLimit: { enabled: config.rateLimit.enabled, windowMs: config.rateLimit.windowMs, maxRequests: config.rateLimit.maxRequests },
      cache: { enabled: config.cache.enabled, ttlSeconds: config.cache.ttlSeconds, maxSize: config.cache.maxSize },
      router: { strategy: config.router.strategy, healthCheckInterval: config.router.healthCheckInterval },
    });
  });

  // Workers list (aggregated from Redis)
  app.get('/api/v1/workers', async (req, res) => {
    try {
      const region = req.query.region as string | undefined;
      const status = req.query.status as string | undefined;
      const result = await gateway.workerRegistry.getWorkerList({ region, status });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch workers' } });
    }
  });

  // --- Proxied API endpoints ---
  // All /api/v1/* requests (except /api/v1/workers handled above) go through the event pipeline

  app.use('/api/v1', async (req, res, next) => {
    const gwReq = req as GatewayRequest;

    // Publish incoming request event (plugins process this)
    const requestEvent = createEvent<RequestEventPayload>('gateway:request:incoming', {
      id: gwReq.requestId,
      method: req.method,
      path: req.originalUrl,
      headers: req.headers as Record<string, string>,
      query: req.query as Record<string, string>,
      body: req.body,
      ip: req.ip || req.socket.remoteAddress || 'unknown',
      timestamp: gwReq.startTime,
      context: {},
      req: gwReq,
      res: res as any,
    });

    await core.eventManager.publish(requestEvent);

    // If event was cancelled (auth failed, rate limited, cache hit), response is already sent
    if (requestEvent.isCancelled) {
      return;
    }

    // Set headers for downstream
    res.setHeader('X-Request-ID', gwReq.requestId);
    res.setHeader('X-Gateway-Version', '0.1.0');

    // Rate limit headers
    const rlInfo = requestEvent.payload.context.rateLimitInfo;
    if (rlInfo) {
      res.setHeader('X-RateLimit-Limit', rlInfo.limit);
      res.setHeader('X-RateLimit-Remaining', rlInfo.remaining);
      res.setHeader('X-RateLimit-Reset', rlInfo.resetAt);
    }

    next();
  });

  // Proxy middleware for remaining /api/v1/* requests
  app.use('/api/v1', createProxyMiddleware(config));

  // --- Error handler ---
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[gateway] Unhandled error:', err.message);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: config.env === 'production' ? 'Internal server error' : err.message,
      },
    });
  });

  return app;
}
