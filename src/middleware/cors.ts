import cors from 'cors';
import type { GatewayConfig } from '../types/gateway';

/**
 * Create CORS middleware from gateway configuration.
 */
export function createCorsMiddleware(config: GatewayConfig) {
  return cors({
    origin: config.cors.origin === '*' ? true : config.cors.origin.split(',').map(o => o.trim()),
    methods: config.cors.methods.split(',').map(m => m.trim()),
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-API-Key',
      'X-Worker-Token',
      'X-Request-ID',
    ],
    exposedHeaders: [
      'X-Request-ID',
      'X-Gateway-Cache',
      'X-Gateway-Version',
      'X-Gateway-Duration',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
    ],
    credentials: true,
    maxAge: 86400, // 24 hours preflight cache
  });
}
