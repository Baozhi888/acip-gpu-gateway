# API Reference / API 接口文档

> Complete API documentation for ACIP GPU Gateway endpoints.

## Base URL

```
http://localhost:3000
```

## Authentication / 鉴权

All `/api/v1/*` endpoints require authentication. Provide one of:

| Header | Description |
|--------|-------------|
| `X-Worker-Token` | Worker token (validated with SHA-256 + salt) |
| `X-API-Key` | Static API key (from configured allowlist) |
| `Authorization` | `Bearer <token>` (optional, for future OAuth) |

Unauthenticated requests receive a `401 Unauthorized` response.

---

## Proxied Endpoints / 代理端点

These endpoints are proxied to the FastAPI backend. The gateway adds authentication, rate limiting, caching, and metrics before forwarding.

这些端点被代理到 FastAPI 后端。网关在转发前添加鉴权、限流、缓存和指标收集。

### POST /api/v1/jobs

Submit a GPU inference job.

**Request:**

```json
{
  "model_name": "llama-7b",
  "input_data": {
    "prompt": "Hello, world!",
    "max_tokens": 100,
    "temperature": 0.7
  },
  "priority": 5,
  "region_preference": "us-west"
}
```

**Response:** `201 Created`

```json
{
  "job_id": "job-abc123",
  "status": "queued",
  "queue_position": 3,
  "estimated_wait": 15,
  "created_at": "2025-01-15T10:30:00Z"
}
```

**Error Responses:**

| Status | Description |
|--------|-------------|
| `400` | Invalid request body |
| `401` | Authentication failed |
| `429` | Rate limit exceeded |
| `502` | FastAPI backend unavailable |

---

### GET /api/v1/jobs/:id

Query job status and result.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Job ID (path parameter) |

**Response:** `200 OK`

```json
{
  "job_id": "job-abc123",
  "status": "completed",
  "model_name": "llama-7b",
  "result": {
    "text": "Hello, world! I am a large language model...",
    "tokens_used": 87,
    "inference_time_ms": 1250
  },
  "worker_id": "worker-gpu-01",
  "created_at": "2025-01-15T10:30:00Z",
  "completed_at": "2025-01-15T10:30:02Z"
}
```

**Job Status Values:**

| Status | Description |
|--------|-------------|
| `queued` | Waiting in queue |
| `processing` | Being processed by a Worker |
| `completed` | Finished successfully |
| `failed` | Failed with error |
| `cancelled` | Cancelled by user |

**Error Responses:**

| Status | Description |
|--------|-------------|
| `401` | Authentication failed |
| `404` | Job not found |
| `429` | Rate limit exceeded |

---

### GET /api/v1/queue/stats

Get queue statistics.

**Response:** `200 OK`

```json
{
  "total_jobs": 150,
  "queued": 12,
  "processing": 5,
  "completed": 130,
  "failed": 3,
  "average_wait_time_seconds": 8.5,
  "average_processing_time_seconds": 2.1
}
```

**Cache:** This endpoint response is cached for 10 seconds by default.

---

## Gateway Endpoints / 网关端点

These endpoints are handled directly by the gateway and are NOT proxied.

这些端点由网关直接处理，不会被代理。

### GET /api/v1/workers

Get aggregated Worker list from Redis. This endpoint reads Worker heartbeat data written by the Python GPU Workers directly from Redis, providing a real-time view.

从 Redis 聚合 Worker 列表。此端点直接从 Redis 读取 Python GPU Worker 写入的心跳数据，提供实时视图。

**Response:** `200 OK`

```json
{
  "workers": [
    {
      "worker_id": "worker-gpu-01",
      "region": "us-west",
      "status": "idle",
      "gpu": {
        "name": "NVIDIA A100",
        "memory_total_mb": 81920,
        "memory_used_mb": 12500,
        "utilization_percent": 15
      },
      "last_heartbeat": "2025-01-15T10:30:00Z",
      "uptime_seconds": 86400,
      "jobs_completed": 1250
    },
    {
      "worker_id": "worker-gpu-02",
      "region": "us-east",
      "status": "busy",
      "gpu": {
        "name": "NVIDIA A100",
        "memory_total_mb": 81920,
        "memory_used_mb": 65000,
        "utilization_percent": 92
      },
      "last_heartbeat": "2025-01-15T10:29:58Z",
      "uptime_seconds": 43200,
      "jobs_completed": 890
    }
  ],
  "total": 2,
  "online": 2,
  "busy": 1,
  "idle": 1
}
```

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `region` | string | — | Filter by region |
| `status` | string | — | Filter by status (online, busy, idle, offline) |

---

### GET /gateway/health

Basic gateway health check.

**Response:** `200 OK`

```json
{
  "status": "healthy",
  "uptime": 86400,
  "version": "0.1.0",
  "timestamp": "2025-01-15T10:30:00Z"
}
```

**Unhealthy Response:** `503 Service Unavailable`

```json
{
  "status": "unhealthy",
  "uptime": 86400,
  "version": "0.1.0",
  "errors": ["Redis connection lost"]
}
```

---

### GET /gateway/health/detailed

Detailed health check including downstream service status.

**Response:** `200 OK`

```json
{
  "status": "healthy",
  "uptime": 86400,
  "version": "0.1.0",
  "timestamp": "2025-01-15T10:30:00Z",
  "checks": {
    "redis": {
      "status": "healthy",
      "latency_ms": 2
    },
    "fastapi": {
      "status": "healthy",
      "latency_ms": 15,
      "url": "http://localhost:8000"
    },
    "plugins": {
      "loaded": 6,
      "active": 6,
      "errors": 0,
      "details": {
        "auth-plugin": "active",
        "rate-limit-plugin": "active",
        "cache-plugin": "active",
        "router-plugin": "active",
        "metrics-plugin": "active",
        "health-plugin": "active"
      }
    }
  },
  "resources": {
    "memory_used_mb": 85,
    "cpu_percent": 12
  }
}
```

---

### GET /gateway/metrics

Prometheus-compatible metrics endpoint.

**Response:** `200 OK` (Content-Type: `text/plain`)

```
# HELP gateway_requests_total Total number of requests
# TYPE gateway_requests_total counter
gateway_requests_total{method="GET",path="/api/v1/jobs",status="200"} 1250
gateway_requests_total{method="POST",path="/api/v1/jobs",status="201"} 340

# HELP gateway_request_duration_seconds Request duration in seconds
# TYPE gateway_request_duration_seconds histogram
gateway_request_duration_seconds_bucket{method="GET",path="/api/v1/jobs",le="0.01"} 800
gateway_request_duration_seconds_bucket{method="GET",path="/api/v1/jobs",le="0.1"} 1200
gateway_request_duration_seconds_bucket{method="GET",path="/api/v1/jobs",le="1"} 1250

# HELP gateway_active_connections Current active connections
# TYPE gateway_active_connections gauge
gateway_active_connections 12

# HELP gateway_cache_hits_total Total cache hits
# TYPE gateway_cache_hits_total counter
gateway_cache_hits_total 450

# HELP gateway_workers_online Number of online workers
# TYPE gateway_workers_online gauge
gateway_workers_online{region="us-west"} 3
gateway_workers_online{region="us-east"} 2
```

---

### GET /gateway/plugins

List all registered plugins and their status.

**Response:** `200 OK`

```json
{
  "plugins": [
    {
      "name": "auth-plugin",
      "version": "1.0.0",
      "status": "active",
      "dependencies": []
    },
    {
      "name": "rate-limit-plugin",
      "version": "1.0.0",
      "status": "active",
      "dependencies": []
    },
    {
      "name": "cache-plugin",
      "version": "1.0.0",
      "status": "active",
      "dependencies": []
    },
    {
      "name": "router-plugin",
      "version": "1.0.0",
      "status": "active",
      "dependencies": []
    },
    {
      "name": "metrics-plugin",
      "version": "1.0.0",
      "status": "active",
      "dependencies": []
    },
    {
      "name": "health-plugin",
      "version": "1.0.0",
      "status": "active",
      "dependencies": []
    }
  ],
  "total": 6,
  "active": 6,
  "loaded": 0,
  "error": 0
}
```

---

### GET /gateway/config

View runtime gateway configuration (sensitive values are masked).

**Response:** `200 OK`

```json
{
  "gateway": {
    "port": 3000,
    "host": "0.0.0.0",
    "env": "production"
  },
  "fastapi": {
    "url": "http://localhost:8000",
    "timeout": 30000
  },
  "redis": {
    "url": "redis://localhost:6379",
    "keyPrefix": "gateway:"
  },
  "auth": {
    "enabled": true,
    "apiKeysCount": 3
  },
  "rateLimit": {
    "enabled": true,
    "windowMs": 60000,
    "maxRequests": 100
  },
  "cache": {
    "enabled": true,
    "ttlSeconds": 60,
    "maxSize": 1000
  },
  "router": {
    "strategy": "round-robin",
    "healthCheckInterval": 10000
  }
}
```

---

## Common Headers / 通用 Header

### Request Headers / 请求头

| Header | Description |
|--------|-------------|
| `X-Worker-Token` | Worker authentication token |
| `X-API-Key` | API key authentication |
| `X-Request-ID` | Client-provided request ID (optional, gateway generates if missing) |

### Response Headers / 响应头

| Header | Description |
|--------|-------------|
| `X-Request-ID` | Unique request identifier |
| `X-Gateway-Cache` | `HIT` or `MISS` — indicates cache status |
| `X-RateLimit-Limit` | Max requests per window |
| `X-RateLimit-Remaining` | Remaining requests in current window |
| `X-RateLimit-Reset` | Window reset time (Unix timestamp) |
| `X-Gateway-Version` | Gateway version |

---

## Error Format / 错误格式

All error responses follow a consistent JSON format:

所有错误响应遵循统一的 JSON 格式：

```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests. Please retry after 45 seconds.",
    "requestId": "req-abc123",
    "retryAfter": 45
  }
}
```

### Error Codes / 错误码

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Missing or invalid authentication |
| `FORBIDDEN` | 403 | Valid auth but insufficient permissions |
| `NOT_FOUND` | 404 | Resource not found |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests |
| `BAD_GATEWAY` | 502 | FastAPI backend unreachable |
| `GATEWAY_TIMEOUT` | 504 | FastAPI backend timeout |
| `INTERNAL_ERROR` | 500 | Unexpected gateway error |
