/** Worker status as stored in Redis by Python GPU Workers */
export interface WorkerStatus {
  worker_id: string;
  region: string;
  status: WorkerState;
  gpu: WorkerGPUInfo;
  last_heartbeat: string;
  uptime_seconds: number;
  jobs_completed: number;
  current_job?: string;
  capabilities?: string[];
}

export type WorkerState = 'online' | 'offline' | 'busy' | 'idle';

/** GPU information from Worker heartbeat */
export interface WorkerGPUInfo {
  name: string;
  memory_total_mb: number;
  memory_used_mb: number;
  utilization_percent: number;
}

/** Worker event payload published on gateway:worker:* events */
export interface WorkerEventPayload {
  workerId: string;
  region: string;
  gpu: string;
  status: WorkerState;
  lastHeartbeat: number;
}

/** Aggregated Worker list response */
export interface WorkerListResponse {
  workers: WorkerStatus[];
  total: number;
  online: number;
  busy: number;
  idle: number;
}

/** Worker heartbeat data read from Redis */
export interface WorkerHeartbeat {
  worker_id: string;
  timestamp: number;
}
