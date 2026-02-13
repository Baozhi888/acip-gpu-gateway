import { Plugin, ACIPCore, Subscription } from '@maxeven/acip-core';
import type { RequestCompletedPayload } from '../types/gateway';

export interface MetricsPluginConfig {
  enabled: boolean;
  path: string;
}

interface MetricCounters {
  requestsTotal: Map<string, number>;
  requestDurations: number[];
  cacheHits: number;
  cacheMisses: number;
  rateLimitRejected: number;
  authFailures: Map<string, number>;
  proxyErrors: Map<string, number>;
  pluginErrors: Map<string, number>;
  activeConnections: number;
  workersOnline: Map<string, number>;
}

/**
 * Prometheus metrics plugin.
 * Collects request metrics and exposes them in Prometheus text format.
 */
export class MetricsPlugin implements Plugin {
  name = 'metrics-plugin';
  version = '1.0.0';

  private core!: ACIPCore;
  private config: MetricsPluginConfig;
  private subscriptions: Subscription[] = [];
  private metrics: MetricCounters = {
    requestsTotal: new Map(),
    requestDurations: [],
    cacheHits: 0,
    cacheMisses: 0,
    rateLimitRejected: 0,
    authFailures: new Map(),
    proxyErrors: new Map(),
    pluginErrors: new Map(),
    activeConnections: 0,
    workersOnline: new Map(),
  };

  constructor(config: MetricsPluginConfig) {
    this.config = config;
  }

  async install(core: ACIPCore): Promise<void> {
    this.core = core;

    if (!this.config.enabled) {
      console.log('[metrics-plugin] Metrics disabled');
      return;
    }

    // Track completed requests
    const completedSub = core.eventManager.subscribe<RequestCompletedPayload>(
      'gateway:request:completed',
      async (event) => {
        const { method, path, statusCode, duration, cached } = event.payload;
        const key = `${method}:${path}:${statusCode}`;
        this.metrics.requestsTotal.set(key, (this.metrics.requestsTotal.get(key) ?? 0) + 1);
        this.metrics.requestDurations.push(duration);

        // Keep duration array bounded
        if (this.metrics.requestDurations.length > 10000) {
          this.metrics.requestDurations = this.metrics.requestDurations.slice(-5000);
        }
      },
      10 // Low priority — record after all processing
    );

    // Track cache events
    const cacheHitSub = core.eventManager.subscribe('gateway:cache:hit', async () => {
      this.metrics.cacheHits++;
    });

    const cacheMissSub = core.eventManager.subscribe('gateway:cache:miss', async () => {
      this.metrics.cacheMisses++;
    });

    // Track rate limit rejections
    const rlSub = core.eventManager.subscribe('gateway:ratelimit:exceeded', async () => {
      this.metrics.rateLimitRejected++;
    });

    // Track auth failures
    const authSub = core.eventManager.subscribe('gateway:auth:rejected', async (event) => {
      const reason = (event.payload as any).reason ?? 'unknown';
      this.metrics.authFailures.set(reason, (this.metrics.authFailures.get(reason) ?? 0) + 1);
    });

    // Track Worker status
    const workerSub = core.eventManager.subscribe('gateway:worker:updated', async (event) => {
      const { region, status } = event.payload as any;
      if (status === 'online' || status === 'idle' || status === 'busy') {
        this.metrics.workersOnline.set(region, (this.metrics.workersOnline.get(region) ?? 0) + 1);
      }
    });

    this.subscriptions.push(completedSub, cacheHitSub, cacheMissSub, rlSub, authSub, workerSub);
  }

  async uninstall(): Promise<void> {
    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.subscriptions = [];
  }

  async onLoad(): Promise<void> {
    console.log(`[metrics-plugin] Loaded (endpoint: ${this.config.path})`);
  }

  async onUnload(): Promise<void> {}

  /** Render metrics in Prometheus text format */
  private renderMetrics(): string {
    const lines: string[] = [];

    // Request totals
    lines.push('# HELP gateway_requests_total Total number of requests');
    lines.push('# TYPE gateway_requests_total counter');
    for (const [key, count] of this.metrics.requestsTotal) {
      const [method, path, status] = key.split(':');
      lines.push(`gateway_requests_total{method="${method}",path="${path}",status="${status}"} ${count}`);
    }

    // Request duration histogram (simplified — buckets)
    lines.push('# HELP gateway_request_duration_seconds Request duration in seconds');
    lines.push('# TYPE gateway_request_duration_seconds histogram');
    const buckets = [0.01, 0.05, 0.1, 0.5, 1, 5, 10];
    const durations = this.metrics.requestDurations.map(d => d / 1000); // ms to seconds
    for (const bucket of buckets) {
      const count = durations.filter(d => d <= bucket).length;
      lines.push(`gateway_request_duration_seconds_bucket{le="${bucket}"} ${count}`);
    }
    lines.push(`gateway_request_duration_seconds_bucket{le="+Inf"} ${durations.length}`);
    const sum = durations.reduce((a, b) => a + b, 0);
    lines.push(`gateway_request_duration_seconds_sum ${sum.toFixed(6)}`);
    lines.push(`gateway_request_duration_seconds_count ${durations.length}`);

    // Cache
    lines.push('# HELP gateway_cache_hits_total Total cache hits');
    lines.push('# TYPE gateway_cache_hits_total counter');
    lines.push(`gateway_cache_hits_total ${this.metrics.cacheHits}`);

    lines.push('# HELP gateway_cache_misses_total Total cache misses');
    lines.push('# TYPE gateway_cache_misses_total counter');
    lines.push(`gateway_cache_misses_total ${this.metrics.cacheMisses}`);

    // Rate limiting
    lines.push('# HELP gateway_ratelimit_rejected_total Rate-limited requests');
    lines.push('# TYPE gateway_ratelimit_rejected_total counter');
    lines.push(`gateway_ratelimit_rejected_total ${this.metrics.rateLimitRejected}`);

    // Auth failures
    lines.push('# HELP gateway_auth_failures_total Authentication failures');
    lines.push('# TYPE gateway_auth_failures_total counter');
    for (const [reason, count] of this.metrics.authFailures) {
      lines.push(`gateway_auth_failures_total{reason="${reason}"} ${count}`);
    }

    // Workers online
    lines.push('# HELP gateway_workers_online Number of online workers');
    lines.push('# TYPE gateway_workers_online gauge');
    for (const [region, count] of this.metrics.workersOnline) {
      lines.push(`gateway_workers_online{region="${region}"} ${count}`);
    }

    return lines.join('\n') + '\n';
  }

  getAPI() {
    return {
      getMetrics: async () => this.renderMetrics(),
      getCounters: () => ({ ...this.metrics }),
    };
  }
}
