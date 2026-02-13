import { ACIPCore, createEvent } from '@maxeven/acip-core';
import type { GatewayConfig } from '../types/gateway';
import type { JobStatus, JobState, JobEventPayload } from '../types/job';

/**
 * Job Tracker service.
 * Monitors job status from Redis and publishes lifecycle events.
 */
export class JobTracker {
  private core: ACIPCore;
  private config: GatewayConfig;

  /** In-memory cache of recently tracked jobs */
  private jobs = new Map<string, JobStatus>();

  constructor(core: ACIPCore, config: GatewayConfig) {
    this.core = core;
    this.config = config;
  }

  /** Track a newly submitted job */
  async trackJob(jobId: string): Promise<void> {
    try {
      const status = await this.core.stateManager.get<JobStatus>(`queue:job:${jobId}`);
      if (status) {
        this.jobs.set(jobId, status);

        await this.core.eventManager.publish(
          createEvent<JobEventPayload>('gateway:job:submitted', {
            jobId,
            status: status.status,
            modelName: status.model_name,
            workerId: status.worker_id,
          })
        );
      }
    } catch (err) {
      console.warn(`[job-tracker] Failed to track job ${jobId}:`, (err as Error).message);
    }
  }

  /** Get the status of a tracked job */
  async getJobStatus(jobId: string): Promise<JobStatus | undefined> {
    // Try in-memory cache first
    const cached = this.jobs.get(jobId);
    if (cached && (cached.status === 'completed' || cached.status === 'failed')) {
      return cached;
    }

    // Fetch from Redis
    try {
      const status = await this.core.stateManager.get<JobStatus>(`queue:job:${jobId}`);
      if (status) {
        const previousStatus = this.jobs.get(jobId)?.status;
        this.jobs.set(jobId, status);

        // Publish status change events
        if (previousStatus && previousStatus !== status.status) {
          await this.publishStatusChange(status);
        }

        return status;
      }
    } catch (err) {
      console.warn(`[job-tracker] Failed to get job ${jobId}:`, (err as Error).message);
    }

    return cached;
  }

  /** Publish job status change event */
  private async publishStatusChange(job: JobStatus): Promise<void> {
    let eventType: string;

    switch (job.status) {
      case 'completed':
        eventType = 'gateway:job:completed';
        break;
      case 'failed':
        eventType = 'gateway:job:failed';
        break;
      default:
        eventType = 'gateway:job:submitted'; // processing, queued, etc.
    }

    await this.core.eventManager.publish(
      createEvent<JobEventPayload>(eventType, {
        jobId: job.job_id,
        status: job.status,
        workerId: job.worker_id,
        modelName: job.model_name,
        duration: job.completed_at && job.created_at
          ? new Date(job.completed_at).getTime() - new Date(job.created_at).getTime()
          : undefined,
      })
    );
  }

  /** Clean up completed/failed jobs older than maxAge (ms) from memory */
  pruneOldJobs(maxAgeMs = 3600000): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.status === 'completed' || job.status === 'failed') {
        const completedAt = job.completed_at ? new Date(job.completed_at).getTime() : 0;
        if (now - completedAt > maxAgeMs) {
          this.jobs.delete(id);
        }
      }
    }
  }

  /** Get count of tracked jobs by status */
  getJobCounts(): Record<JobState, number> {
    const counts: Record<string, number> = {
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    for (const job of this.jobs.values()) {
      counts[job.status] = (counts[job.status] ?? 0) + 1;
    }

    return counts as Record<JobState, number>;
  }
}
