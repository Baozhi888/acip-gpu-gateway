/** Job submission request */
export interface JobSubmitRequest {
  model_name: string;
  input_data: Record<string, unknown>;
  priority?: number;
  region_preference?: string;
}

/** Job status as stored in Redis / returned by FastAPI */
export interface JobStatus {
  job_id: string;
  status: JobState;
  model_name: string;
  result?: JobResult;
  worker_id?: string;
  queue_position?: number;
  estimated_wait?: number;
  created_at: string;
  completed_at?: string;
  error?: string;
}

export type JobState = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

/** Job result returned on completion */
export interface JobResult {
  text?: string;
  data?: unknown;
  tokens_used?: number;
  inference_time_ms?: number;
}

/** Job event payload published on gateway:job:* events */
export interface JobEventPayload {
  jobId: string;
  status: JobState;
  workerId?: string;
  modelName: string;
  duration?: number;
}

/** Queue statistics from FastAPI */
export interface QueueStats {
  total_jobs: number;
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  average_wait_time_seconds: number;
  average_processing_time_seconds: number;
}
