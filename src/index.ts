import { loadConfig } from './config';
import { GatewayCore } from './gateway';
import { createServer } from './server';

async function main() {
  const config = loadConfig();
  const gateway = new GatewayCore(config);

  // Start gateway (register plugins, connect to Redis, etc.)
  await gateway.start();

  // Create and start HTTP server
  const app = createServer(gateway);

  const server = app.listen(config.port, config.host, () => {
    console.log(`[gateway] ACIP GPU Gateway listening on ${config.host}:${config.port}`);
    console.log(`[gateway] Environment: ${config.env}`);
    console.log(`[gateway] FastAPI backend: ${config.fastapi.url}`);
    console.log(`[gateway] Health check: http://${config.host}:${config.port}/gateway/health`);
    console.log(`[gateway] Metrics: http://${config.host}:${config.port}${config.metrics.path}`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[gateway] Received ${signal}, shutting down gracefully...`);
    server.close(async () => {
      await gateway.stop();
      process.exit(0);
    });

    // Force exit after 10 seconds
    setTimeout(() => {
      console.error('[gateway] Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[gateway] Fatal error:', err);
  process.exit(1);
});
