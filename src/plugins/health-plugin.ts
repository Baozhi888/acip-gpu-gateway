import { Plugin, ACIPCore } from '@maxeven/acip-core';
import type { GatewayConfig, HealthCheckResult } from '../types/gateway';
import type { WorkerRegistry } from '../services/worker-registry';

/**
 * Health check plugin.
 * Provides basic and detailed health check endpoints.
 */
export class HealthPlugin implements Plugin {
  name = 'health-plugin';
  version = '1.0.0';

  private core!: ACIPCore;
  private config: GatewayConfig;
  private workerRegistry: WorkerRegistry;
  private startTime = Date.now();

  constructor(config: GatewayConfig, workerRegistry: WorkerRegistry) {
    this.config = config;
    this.workerRegistry = workerRegistry;
  }

  async install(core: ACIPCore): Promise<void> {
    this.core = core;
  }

  async uninstall(): Promise<void> {}

  async onLoad(): Promise<void> {
    console.log('[health-plugin] Loaded');
  }

  async onUnload(): Promise<void> {}

  /** Basic health check */
  private async getHealth(): Promise<HealthCheckResult> {
    const errors: string[] = [];

    // Check Redis connectivity
    try {
      await this.core.stateManager.get('gateway:health:ping');
    } catch {
      errors.push('Redis connection failed');
    }

    return {
      status: errors.length === 0 ? 'healthy' : 'unhealthy',
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /** Detailed health check with downstream services */
  private async getDetailedHealth(): Promise<HealthCheckResult> {
    const base = await this.getHealth();
    const checks: HealthCheckResult['checks'] = {};

    // Check Redis
    try {
      const redisStart = Date.now();
      await this.core.stateManager.set('gateway:health:ping', Date.now());
      await this.core.stateManager.get('gateway:health:ping');
      checks.redis = { status: 'healthy', latency_ms: Date.now() - redisStart };
    } catch {
      checks.redis = { status: 'unhealthy', latency_ms: -1 };
    }

    // Check FastAPI
    try {
      const fastapiStart = Date.now();
      const response = await fetch(`${this.config.fastapi.url}/docs`, {
        signal: AbortSignal.timeout(5000),
      });
      checks.fastapi = {
        status: response.ok ? 'healthy' : 'degraded',
        latency_ms: Date.now() - fastapiStart,
        url: this.config.fastapi.url,
      };
    } catch {
      checks.fastapi = {
        status: 'unhealthy',
        latency_ms: -1,
        url: this.config.fastapi.url,
      };
    }

    // Check plugins
    const allPluginInfo = this.core.pluginManager.getAllPluginInfo();
    const pluginDetails: Record<string, string> = {};
    let errorCount = 0;
    let activeCount = 0;

    for (const [name, info] of allPluginInfo) {
      pluginDetails[name] = info.status;
      if (info.status === 'error') errorCount++;
      if (info.status === 'active' || info.status === 'loaded') activeCount++;
    }

    checks.plugins = {
      loaded: allPluginInfo.size,
      active: activeCount,
      errors: errorCount,
      details: pluginDetails,
    };

    // Resource monitoring
    let resources: HealthCheckResult['resources'];
    try {
      const mem = await this.core.resourceMonitor.getMemoryUsage();
      const cpu = await this.core.resourceMonitor.getCpuUsage();
      resources = {
        memory_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
        cpu_percent: Math.round((cpu.user + cpu.system) * 100) / 100,
      };
    } catch {
      // Resource monitoring not available
    }

    // Determine overall status
    let status: 'healthy' | 'unhealthy' | 'degraded' = 'healthy';
    if (checks.redis?.status === 'unhealthy') status = 'unhealthy';
    else if (checks.fastapi?.status === 'unhealthy') status = 'degraded';
    else if (errorCount > 0) status = 'degraded';

    return {
      ...base,
      status,
      checks,
      resources,
    };
  }

  getAPI() {
    return {
      getHealth: () => this.getHealth(),
      getDetailedHealth: () => this.getDetailedHealth(),
    };
  }
}
