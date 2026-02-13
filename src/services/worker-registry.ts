import { ACIPCore, createEvent } from '@maxeven/acip-core';
import type { GatewayConfig } from '../types/gateway';
import type { WorkerStatus, WorkerState, WorkerListResponse } from '../types/worker';

/**
 * Worker Registry service.
 * Reads Worker heartbeat data from Redis (written by Python GPU Workers)
 * and maintains an in-memory snapshot for fast access.
 *
 * Publishes events when Worker status changes.
 */
export class WorkerRegistry {
  private core: ACIPCore;
  private config: GatewayConfig;

  /** In-memory Worker snapshot */
  private workers = new Map<string, WorkerStatus>();

  /** Polling interval handle */
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  /** Polling frequency in ms */
  private pollIntervalMs = 5000;

  constructor(core: ACIPCore, config: GatewayConfig) {
    this.core = core;
    this.config = config;
  }

  /** Start polling Redis for Worker status */
  async start(): Promise<void> {
    // Initial fetch
    await this.refreshWorkers();

    // Start periodic polling
    this.pollInterval = setInterval(async () => {
      try {
        await this.refreshWorkers();
      } catch (err) {
        console.warn('[worker-registry] Poll error:', (err as Error).message);
      }
    }, this.pollIntervalMs);

    console.log(`[worker-registry] Started (polling every ${this.pollIntervalMs}ms)`);
  }

  /** Stop polling */
  async stop(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    console.log('[worker-registry] Stopped');
  }

  /** Refresh Worker list from Redis */
  private async refreshWorkers(): Promise<void> {
    try {
      // Attempt to read all worker keys from Redis via StateManager
      // Python workers write to keys like worker:{id}:status
      const knownWorkerIds = await this.discoverWorkerIds();

      const previousIds = new Set(this.workers.keys());
      const currentIds = new Set<string>();

      for (const workerId of knownWorkerIds) {
        currentIds.add(workerId);

        const statusData = await this.core.stateManager.get<WorkerStatus>(`worker:${workerId}:status`);

        if (!statusData) continue;

        const previousStatus = this.workers.get(workerId);
        this.workers.set(workerId, statusData);

        // Detect status changes
        if (!previousStatus) {
          // New Worker
          await this.core.eventManager.publish(
            createEvent('gateway:worker:online', {
              workerId,
              region: statusData.region,
              gpu: statusData.gpu?.name ?? 'unknown',
              status: statusData.status,
              lastHeartbeat: Date.now(),
            })
          );
        } else if (previousStatus.status !== statusData.status) {
          // Status changed
          await this.core.eventManager.publish(
            createEvent('gateway:worker:updated', {
              workerId,
              region: statusData.region,
              gpu: statusData.gpu?.name ?? 'unknown',
              status: statusData.status,
              lastHeartbeat: Date.now(),
            })
          );
        }
      }

      // Detect offline Workers (previously known but no longer present)
      for (const oldId of previousIds) {
        if (!currentIds.has(oldId)) {
          const worker = this.workers.get(oldId);
          this.workers.delete(oldId);

          await this.core.eventManager.publish(
            createEvent('gateway:worker:offline', {
              workerId: oldId,
              region: worker?.region ?? 'unknown',
              gpu: worker?.gpu?.name ?? 'unknown',
              status: 'offline' as WorkerState,
              lastHeartbeat: Date.now(),
            })
          );
        }
      }
    } catch (err) {
      // StateManager might not support key scanning; keep existing snapshot
      console.debug('[worker-registry] Refresh failed:', (err as Error).message);
    }
  }

  /** Discover Worker IDs from Redis key patterns */
  private async discoverWorkerIds(): Promise<string[]> {
    // ACIP StateManager doesn't have a native scan/keys method,
    // so we maintain a known workers index via a well-known key
    const index = await this.core.stateManager.get<string[]>('worker:index');
    return index ?? [];
  }

  /** Get Worker list with optional filters */
  async getWorkerList(filters?: { region?: string; status?: string }): Promise<WorkerListResponse> {
    let workers = Array.from(this.workers.values());

    if (filters?.region) {
      workers = workers.filter(w => w.region === filters.region);
    }

    if (filters?.status) {
      workers = workers.filter(w => w.status === filters.status);
    }

    const online = workers.filter(w => w.status !== 'offline').length;
    const busy = workers.filter(w => w.status === 'busy').length;
    const idle = workers.filter(w => w.status === 'idle').length;

    return {
      workers,
      total: workers.length,
      online,
      busy,
      idle,
    };
  }

  /** Get a specific Worker by ID */
  getWorker(workerId: string): WorkerStatus | undefined {
    return this.workers.get(workerId);
  }

  /** Get all Workers as a Map */
  getAllWorkers(): Map<string, WorkerStatus> {
    return new Map(this.workers);
  }

  /** Get Worker count by region */
  getWorkerCountByRegion(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const worker of this.workers.values()) {
      counts.set(worker.region, (counts.get(worker.region) ?? 0) + 1);
    }
    return counts;
  }
}
