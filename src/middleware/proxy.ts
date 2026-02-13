import { createProxyMiddleware as createHPM } from 'http-proxy-middleware';
import type { GatewayConfig, GatewayRequest } from '../types/gateway';

/**
 * Create reverse proxy middleware that forwards requests to the FastAPI backend.
 * Injects X-Request-ID and trace headers for observability.
 */
export function createProxyMiddleware(config: GatewayConfig) {
  return createHPM({
    target: config.fastapi.url,
    changeOrigin: true,
    timeout: config.fastapi.timeout,
    proxyTimeout: config.fastapi.timeout,

    on: {
      proxyReq: (proxyReq, req) => {
        const gwReq = req as GatewayRequest;

        // Inject request ID
        proxyReq.setHeader('X-Request-ID', gwReq.requestId);

        // Inject gateway version
        proxyReq.setHeader('X-Gateway-Version', '0.1.0');

        // Forward client IP
        const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        if (clientIp) {
          proxyReq.setHeader('X-Forwarded-For', clientIp.toString());
        }

        // Use target URL from router plugin if set
        if (gwReq.targetUrl && gwReq.targetUrl !== config.fastapi.url) {
          const url = new URL(gwReq.targetUrl);
          proxyReq.setHeader('Host', url.host);
        }
      },

      proxyRes: (proxyRes, req, res) => {
        const gwReq = req as GatewayRequest;

        // Add timing header
        const duration = Date.now() - gwReq.startTime;
        (res as any).setHeader('X-Gateway-Duration', `${duration}ms`);
      },

      error: (err, req, res) => {
        const gwReq = req as GatewayRequest;
        console.error(`[proxy] Error proxying ${gwReq.method} ${gwReq.originalUrl}:`, err.message);

        if (!res.headersSent && 'status' in res) {
          (res as any).status(502).json({
            error: {
              code: 'BAD_GATEWAY',
              message: 'Failed to reach the inference backend.',
              requestId: gwReq.requestId,
            },
          });
        }
      },
    },
  });
}
