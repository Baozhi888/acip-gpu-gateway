import {
  createCore,
  ACIPCore,
  RedisStateManager,
  EventManager,
} from '@maxeven/acip-core';
import type { GatewayConfig } from './types/gateway';

import { AuthPlugin } from './plugins/auth-plugin';
import { RateLimitPlugin } from './plugins/rate-limit-plugin';
import { CachePlugin } from './plugins/cache-plugin';
import { RouterPlugin } from './plugins/router-plugin';
import { MetricsPlugin } from './plugins/metrics-plugin';
import { HealthPlugin } from './plugins/health-plugin';

import { WorkerRegistry } from './services/worker-registry';
import { JobTracker } from './services/job-tracker';
import { RegionResolver } from './services/region-resolver';

export class GatewayCore {
  private core: ACIPCore;
  private config: GatewayConfig;

  public workerRegistry: WorkerRegistry;
  public jobTracker: JobTracker;
  public regionResolver: RegionResolver;

  constructor(config: GatewayConfig) {
    this.config = config;

    // Create ACIP Core with Redis-backed state if available
    const coreConfig: Record<string, unknown> = {};

    if (config.otel.enabled && config.otel.zipkinEndpoint) {
      (coreConfig as any).openTelemetryConfig = {
        serviceName: config.otel.serviceName,
        zipkinEndpoint: config.otel.zipkinEndpoint,
      };
    }

    this.core = createCore(coreConfig);

    // Initialize services
    this.workerRegistry = new WorkerRegistry(this.core, config);
    this.jobTracker = new JobTracker(this.core, config);
    this.regionResolver = new RegionResolver(config);
  }

  /** Get the underlying ACIP Core instance */
  getCore(): ACIPCore {
    return this.core;
  }

  /** Get the gateway configuration */
  getConfig(): GatewayConfig {
    return this.config;
  }

  /** Register all built-in plugins and start the gateway */
  async start(): Promise<void> {
    console.log(`[gateway] Starting ACIP GPU Gateway (instance: ${this.core.instanceId})`);

    // Register built-in plugins
    await this.registerBuiltinPlugins();

    // Load and activate all plugins
    await this.core.pluginManager.loadAllPlugins();
    console.log('[gateway] All plugins loaded');

    // Start services
    await this.workerRegistry.start();
    console.log('[gateway] Worker registry started');
  }

  /** Gracefully shut down the gateway */
  async stop(): Promise<void> {
    console.log('[gateway] Shutting down...');

    await this.workerRegistry.stop();
    await this.core.pluginManager.shutdown();

    console.log('[gateway] Shutdown complete');
  }

  private async registerBuiltinPlugins(): Promise<void> {
    const plugins = [
      new AuthPlugin(this.config.auth),
      new RateLimitPlugin(this.config.rateLimit),
      new CachePlugin(this.config.cache),
      new RouterPlugin(this.config.router, this.config.fastapi, this.workerRegistry),
      new MetricsPlugin(this.config.metrics),
      new HealthPlugin(this.config, this.workerRegistry),
    ];

    for (const plugin of plugins) {
      await this.core.pluginManager.register(plugin);
      console.log(`[gateway] Registered plugin: ${plugin.name} v${plugin.version}`);
    }
  }
}
