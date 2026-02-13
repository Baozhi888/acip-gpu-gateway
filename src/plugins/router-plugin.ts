import { Plugin, ACIPCore, Subscription, createEvent } from '@maxeven/acip-core';
import type { RequestEventPayload, RouterStrategy } from '../types/gateway';
import type { WorkerRegistry } from '../services/worker-registry';
import type { WorkerStatus } from '../types/worker';

export interface RouterPluginConfig {
  strategy: RouterStrategy;
  healthCheckInterval: number;
}

export interface FastAPIConfig {
  url: string;
  timeout: number;
}

/**
 * Smart routing plugin.
 * Selects the optimal FastAPI backend instance based on Worker availability
 * and configurable routing strategy.
 */
export class RouterPlugin implements Plugin {
  name = 'router-plugin';
  version = '1.0.0';

  private core!: ACIPCore;
  private routerConfig: RouterPluginConfig;
  private fastapiConfig: FastAPIConfig;
  private workerRegistry: WorkerRegistry;
  private subscriptions: Subscription[] = [];

  /** Round-robin index for simple rotation */
  private rrIndex = 0;

  /** List of known FastAPI backend URLs (for multi-instance setups) */
  private backends: string[];

  constructor(routerConfig: RouterPluginConfig, fastapiConfig: FastAPIConfig, workerRegistry: WorkerRegistry) {
    this.routerConfig = routerConfig;
    this.fastapiConfig = fastapiConfig;
    this.workerRegistry = workerRegistry;
    // Default to single backend; multi-instance can be configured via env
    this.backends = [fastapiConfig.url];
  }

  async install(core: ACIPCore): Promise<void> {
    this.core = core;

    const sub = core.eventManager.subscribe<RequestEventPayload>(
      'gateway:request:incoming',
      async (event) => {
        const { context, id } = event.payload;
        const path = event.payload.req.originalUrl;

        // Skip routing for gateway-local endpoints
        if (path.startsWith('/gateway/')) return;

        const targetUrl = this.selectTarget();
        context.targetUrl = targetUrl;

        await core.eventManager.publish(
          createEvent('gateway:router:selected', {
            requestId: id,
            targetUrl,
            strategy: this.routerConfig.strategy,
          })
        );
      },
      70 // After auth, rate limiting, and cache
    );

    this.subscriptions.push(sub);
  }

  async uninstall(): Promise<void> {
    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.subscriptions = [];
  }

  async onLoad(): Promise<void> {
    console.log(`[router-plugin] Loaded (strategy: ${this.routerConfig.strategy}, backends: ${this.backends.length})`);
  }

  async onUnload(): Promise<void> {}

  /** Select target FastAPI URL based on configured strategy */
  private selectTarget(clientRegion?: string): string {
    if (this.backends.length === 1) {
      return this.backends[0];
    }

    switch (this.routerConfig.strategy) {
      case 'round-robin':
        return this.selectRoundRobin();
      case 'least-connections':
        return this.selectLeastConnections();
      case 'region-affinity':
        return this.selectByRegion(clientRegion) ?? this.selectRoundRobin();
      default:
        return this.backends[0];
    }
  }

  private selectRoundRobin(): string {
    const target = this.backends[this.rrIndex % this.backends.length];
    this.rrIndex++;
    return target;
  }

  private selectLeastConnections(): string {
    // In a full implementation, this would track active connections per backend
    // For now, fall back to round-robin
    return this.selectRoundRobin();
  }

  private selectByRegion(clientRegion?: string): string | null {
    if (!clientRegion) return null;

    // In a full implementation, this would use the RegionResolver
    // to find the closest backend based on region distance matrix
    return null;
  }

  getAPI() {
    return {
      getBackends: () => [...this.backends],
      getStrategy: () => this.routerConfig.strategy,
      selectTarget: (region?: string) => this.selectTarget(region),
    };
  }
}
