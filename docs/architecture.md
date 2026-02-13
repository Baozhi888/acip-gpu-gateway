# Architecture Design / 架构设计

> This document describes the system architecture of ACIP GPU Gateway, how it integrates with the existing Distributed GPU Inference platform, and the design rationale behind key decisions.

## Table of Contents

- [System Overview / 系统概览](#system-overview--系统概览)
- [High-Level Architecture / 高层架构](#high-level-architecture--高层架构)
- [Request Lifecycle / 请求生命周期](#request-lifecycle--请求生命周期)
- [Plugin Architecture / 插件架构](#plugin-architecture--插件架构)
- [Event System / 事件系统](#event-system--事件系统)
- [State Management / 状态管理](#state-management--状态管理)
- [Redis Key Space / Redis 键空间](#redis-key-space--redis-键空间)
- [Authentication Compatibility / 鉴权兼容性](#authentication-compatibility--鉴权兼容性)
- [Observability / 可观测性](#observability--可观测性)
- [Deployment Topology / 部署拓扑](#deployment-topology--部署拓扑)
- [Design Decisions / 设计决策](#design-decisions--设计决策)

---

## System Overview / 系统概览

ACIP GPU Gateway is a **Node.js API Gateway** placed in front of the existing Python FastAPI GPU Inference Server. It leverages the ACIP Core framework to provide a **pluggable, event-driven** middleware layer.

ACIP GPU Gateway 是一个放置在现有 Python FastAPI GPU 推理服务前面的 **Node.js API 网关**。它利用 ACIP Core 框架提供 **可插拔、事件驱动** 的中间件层。

### Core Principles / 核心原则

1. **Zero Backend Changes / 零后端改动** — The Python FastAPI server requires no modification.
2. **Plugin-First / 插件优先** — Every gateway capability is an ACIP plugin that can be enabled, disabled, or replaced independently.
3. **Event-Driven / 事件驱动** — Components communicate exclusively through the ACIP EventManager, maintaining loose coupling.
4. **Shared State / 共享状态** — Gateway and Python backend share a single Redis instance with strict namespace isolation.
5. **Observable / 可观测** — Full OpenTelemetry + Prometheus integration out of the box.

---

## High-Level Architecture / 高层架构

```
                         ┌─────────────────────────────────────────────┐
                         │              ACIP GPU Gateway               │
                         │                  (:3000)                    │
                         │                                             │
  ┌──────────┐          │  ┌───────────┐  ┌───────────────────────┐  │
  │  Client   │──────────┼─▶│  Express   │  │    ACIP Core          │  │
  │ (Browser, │          │  │  Server    │  │  ┌─────────────────┐  │  │
  │  CLI,     │          │  │            │  │  │  EventManager   │  │  │
  │  SDK)     │          │  │  ┌──────┐  │  │  ├─────────────────┤  │  │
  └──────────┘          │  │  │CORS  │  │  │  │  PluginManager  │  │  │
                         │  │  │Helmet│  │  │  ├─────────────────┤  │  │
                         │  │  └──────┘  │  │  │  StateManager   │  │  │
                         │  │            │  │  │  (Redis)        │  │  │
                         │  └──────┬─────┘  │  ├─────────────────┤  │  │
                         │         │        │  │  TelemetryService│  │  │
                         │         ▼        │  ├─────────────────┤  │  │
                         │  ┌──────────────┐│  │ ResourceMonitor │  │  │
                         │  │   Plugins    ││  └─────────────────┘  │  │
                         │  │              ││                        │  │
                         │  │ Auth         ││                        │  │
                         │  │ RateLimit    ││                        │  │
                         │  │ Cache        │◀─── Event Bus ─────────┘  │
                         │  │ Router       ││                          │
                         │  │ Metrics      ││                          │
                         │  │ Health       ││                          │
                         │  └──────┬───────┘│                          │
                         │         │        │                          │
                         └─────────┼────────┼──────────────────────────┘
                                   │        │
                            Proxy  │        │  Redis PubSub
                                   ▼        ▼
                         ┌─────────────────────┐      ┌──────────────┐
                         │   FastAPI Server     │      │    Redis     │
                         │      (:8000)         │◀────▶│   (:6379)   │
                         │                      │      │              │
                         │  /api/v1/jobs        │      │ worker:*     │
                         │  /api/v1/queue/stats  │      │ queue:*      │
                         │  /api/v1/workers     │      │ gateway:*    │
                         └──────────┬───────────┘      └──────────────┘
                                    │
                            ┌───────┴───────┐
                            ▼               ▼
                     ┌────────────┐  ┌────────────┐
                     │ GPU Worker │  │ GPU Worker │
                     │  (cuda:0)  │  │  (cuda:1)  │
                     └────────────┘  └────────────┘
```

### Component Responsibilities / 组件职责

| Component | Responsibility |
|-----------|---------------|
| **Express Server** | HTTP handling, middleware chain (CORS, Helmet, body parsing) |
| **ACIP Core** | Plugin lifecycle, event bus, state management, telemetry, resource monitoring |
| **Plugins** | Business logic — auth, rate limiting, caching, routing, metrics, health checks |
| **Proxy Middleware** | Reverse proxy to one or more FastAPI backend instances |
| **Redis** | Shared state store — Worker heartbeats (read), gateway state (write) |

---

## Request Lifecycle / 请求生命周期

Below is the detailed flow of a single HTTP request through the gateway:

```
 1. Client sends HTTP request
    │
 2. Express receives request
    │
 3. ├── helmet() — Security headers
    ├── cors() — CORS handling
    └── express.json() — Body parsing
    │
 4. Gateway publishes event:
    │   eventManager.publish(createEvent('gateway:request:incoming', {
    │     id: requestId,
    │     method, path, headers, body, ip, timestamp
    │   }))
    │
 5. AuthPlugin handler (priority: 100)
    │   ├── Extract token from X-Worker-Token or X-API-Key header
    │   ├── Validate using SHA-256 + salt (same as Python backend)
    │   └── On failure: event.cancel() → 401 response
    │
 6. RateLimitPlugin handler (priority: 90)
    │   ├── Compute rate limit key (IP or API key)
    │   ├── Redis INCR + EXPIRE (sliding window)
    │   └── On limit exceeded: event.cancel() → 429 response
    │
 7. CachePlugin handler (priority: 80)
    │   ├── Compute cache key from method + path + query
    │   ├── Check Redis for cached response
    │   └── On cache hit: attach cached response, event.cancel()
    │
 8. RouterPlugin handler (priority: 70)
    │   ├── Read Worker states from Redis
    │   ├── Apply routing strategy (round-robin / region-affinity)
    │   └── Set target FastAPI URL on request context
    │
 9. Proxy Middleware
    │   ├── Forward request to selected FastAPI instance
    │   ├── Inject X-Request-ID and traceparent headers
    │   └── Stream response back to client
    │
10. Gateway publishes event:
    │   eventManager.publish(createEvent('gateway:request:completed', {
    │     id: requestId, statusCode, duration, targetUrl
    │   }))
    │
11. MetricsPlugin handler
    │   ├── Record request count (counter)
    │   ├── Record latency (histogram)
    │   └── Record status code distribution (counter)
    │
12. CachePlugin post-handler
        └── If cacheable: store response in Redis with TTL
```

### Event Cancellation / 事件取消

ACIP events support cancellation via `event.cancel()`. When a plugin cancels an incoming request event:

- Subsequent plugin handlers with lower priority are skipped.
- The gateway returns an error response (401, 429, etc.) directly without proxying.
- The `gateway:request:completed` event is still published (with `cancelled: true` flag) to ensure metrics are recorded.

---

## Plugin Architecture / 插件架构

### ACIP Plugin Interface / ACIP 插件接口

Every gateway plugin implements the ACIP `Plugin` interface:

```typescript
interface Plugin {
  name: string;
  version: string;
  dependencies?: string[];

  install(core: ACIPCore): Promise<void>;   // Subscribe to events, initialize resources
  uninstall(): Promise<void>;               // Clean up subscriptions and resources
  onLoad(): Promise<void>;                  // Called after all plugins are registered
  onUnload(): Promise<void>;                // Called before shutdown
  onActivate?(): Promise<void>;             // Optional: transition to active state
  onDeactivate?(): Promise<void>;           // Optional: transition to inactive state
  getAPI?(): any;                           // Optional: expose API to other plugins
}
```

### Plugin Lifecycle / 插件生命周期

```
                  register()
  Pending ──────────────────▶ Registered
                                  │
                            loadAllPlugins()
                                  │
                                  ▼
                               Loaded
                                  │
                           activatePlugin()
                                  │
                                  ▼
                               Active ◀────── deactivatePlugin() ──▶ Loaded
                                  │
                           unregister()
                                  │
                                  ▼
                              Unloaded
```

### Plugin Priority / 插件优先级

Event subscriptions accept a `priority` parameter. Higher priority handlers execute first:

| Plugin | Priority | Rationale |
|--------|----------|-----------|
| `auth-plugin` | 100 | Must validate before any processing |
| `rate-limit-plugin` | 90 | Reject overloaded requests early |
| `cache-plugin` | 80 | Return cached responses before routing |
| `router-plugin` | 70 | Select target only for non-cached requests |
| `metrics-plugin` | 10 | Record metrics after all processing |
| `health-plugin` | — | Handles dedicated routes, not event-based |

### Inter-Plugin Communication / 插件间通信

Plugins communicate exclusively through events — never by direct import:

```typescript
// Plugin A publishes
core.eventManager.publish(createEvent('gateway:auth:validated', { userId, scope }));

// Plugin B subscribes
core.eventManager.subscribe('gateway:auth:validated', (event) => {
  // React to authentication result
});
```

Plugins can also expose APIs through `getAPI()` for synchronous access:

```typescript
// Router plugin exposes API
getAPI() {
  return {
    getActiveWorkers: () => this.workerList,
    getTargetUrl: (region?: string) => this.selectTarget(region),
  };
}

// Another plugin accesses it
const routerAPI = core.pluginManager.getPluginAPI('router-plugin');
const workers = routerAPI.getActiveWorkers();
```

---

## Event System / 事件系统

### Event Naming Convention / 事件命名规范

All gateway events follow the pattern: `gateway:<domain>:<action>`

```
gateway:request:incoming        — HTTP request received
gateway:request:completed       — Request processing finished
gateway:request:error           — Request processing error

gateway:auth:validated          — Authentication succeeded
gateway:auth:rejected           — Authentication failed

gateway:ratelimit:allowed       — Request within rate limit
gateway:ratelimit:exceeded      — Rate limit exceeded

gateway:cache:hit               — Cache hit
gateway:cache:miss              — Cache miss
gateway:cache:stored            — Response cached

gateway:router:selected         — Target backend selected
gateway:router:failover         — Failover to alternate backend

gateway:worker:online           — Worker came online
gateway:worker:offline          — Worker went offline
gateway:worker:updated          — Worker status changed

gateway:job:submitted           — Job submitted
gateway:job:completed           — Job completed
gateway:job:failed              — Job failed

gateway:health:check            — Health check performed
gateway:health:degraded         — Service health degraded

gateway:plugin:error            — Plugin error occurred
```

### Event Payload Types / 事件载荷类型

```typescript
// Request events
interface RequestEventPayload {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body?: any;
  ip: string;
  timestamp: number;
}

interface RequestCompletedPayload {
  id: string;
  statusCode: number;
  duration: number;
  targetUrl: string;
  cached: boolean;
  cancelled: boolean;
}

// Worker events
interface WorkerEventPayload {
  workerId: string;
  region: string;
  gpu: string;
  status: 'online' | 'offline' | 'busy' | 'idle';
  lastHeartbeat: number;
}
```

---

## State Management / 状态管理

### ACIP StateManager with Redis / 基于 Redis 的 ACIP 状态管理

The gateway uses ACIP's `RedisStateManager` for all persistent state:

```typescript
import { RedisStateManager } from '@maxeven/acip-core';

const stateManager = new RedisStateManager(
  process.env.REDIS_URL,
  eventManager,
  telemetryService
);
```

The `RedisStateManager` provides:

- **`get<T>(key)`** / **`set<T>(key, value)`** — Basic key-value operations
- **`delete(key)`** — Key removal
- **`subscribe(key, callback)`** — Redis PubSub-based reactive state subscriptions
- **`transaction(key, updateFn)`** — Atomic read-modify-write with distributed locking

### State Subscription for Worker Monitoring / Worker 监控的状态订阅

```typescript
// Subscribe to Worker status changes from Python backend
stateManager.subscribe('worker:*', (value) => {
  eventManager.publish(createEvent('gateway:worker:updated', value));
});
```

---

## Redis Key Space / Redis 键空间

The gateway and Python backend share one Redis instance. Strict namespace isolation prevents key collisions.

网关和 Python 后端共享一个 Redis 实例。严格的命名空间隔离防止键冲突。

### Key Namespace Map / 键命名空间映射

| Prefix | Owner | Format | TTL | Description |
|--------|-------|--------|-----|-------------|
| `worker:{id}:status` | Python Worker | JSON | 30s (heartbeat) | Worker current status |
| `worker:{id}:gpu` | Python Worker | JSON | 30s | GPU memory / utilization |
| `worker:{id}:heartbeat` | Python Worker | timestamp | 30s | Last heartbeat time |
| `queue:stats` | Python Server | JSON | — | Queue depth, pending jobs |
| `queue:job:{id}` | Python Server | JSON | variable | Job status and result |
| `gateway:ratelimit:{key}` | Gateway | sorted set | window size | Sliding window timestamps |
| `gateway:cache:{hash}` | Gateway | JSON | config TTL | Cached API responses |
| `gateway:cache:keys` | Gateway | set | — | Index of all cache keys |
| `gateway:session:{token}` | Gateway | JSON | 1h | Session metadata |
| `gateway:config` | Gateway | JSON | — | Runtime configuration |
| `gateway:metrics:snapshot` | Gateway | JSON | 60s | Last metrics snapshot |

### Key Access Pattern / 键访问模式

```
Gateway READS:              Gateway WRITES:
├── worker:*:status         ├── gateway:ratelimit:*
├── worker:*:gpu            ├── gateway:cache:*
├── worker:*:heartbeat      ├── gateway:session:*
├── queue:stats             ├── gateway:config
└── queue:job:*             └── gateway:metrics:snapshot
```

### Redis Commands Used / 使用的 Redis 命令

| Operation | Redis Commands | Plugin |
|-----------|---------------|--------|
| Rate limit check | `ZADD`, `ZRANGEBYSCORE`, `ZREMRANGEBYSCORE`, `ZCARD` | rate-limit-plugin |
| Cache get/set | `GET`, `SET`, `SADD`, `SMEMBERS`, `DEL` | cache-plugin |
| Worker status | `GET`, `KEYS`, `MGET` | worker-registry |
| Session | `GET`, `SET`, `EXPIRE` | auth-plugin |

---

## Authentication Compatibility / 鉴权兼容性

The gateway reuses the **exact same authentication scheme** as the Python backend to avoid any migration.

网关复用 Python 后端**完全相同的鉴权方案**，避免任何迁移成本。

### Token Validation Algorithm / Token 验证算法

Python backend implementation:

```python
import hashlib
SALT = "distributed-gpu-inference-v1"

def validate_token(token: str, expected_hash: str) -> bool:
    computed = hashlib.sha256(f"{token}{SALT}".encode()).hexdigest()
    return computed == expected_hash
```

Gateway equivalent (TypeScript):

```typescript
import { createHash } from 'crypto';

const SALT = 'distributed-gpu-inference-v1';

function validateToken(token: string, expectedHash: string): boolean {
  const computed = createHash('sha256')
    .update(`${token}${SALT}`)
    .digest('hex');
  return computed === expectedHash;
}
```

### Supported Authentication Methods / 支持的鉴权方式

1. **Worker Token** — `X-Worker-Token` header, validated with SHA-256 + salt
2. **API Key** — `X-API-Key` header, checked against configured allowlist
3. **Bearer Token** — `Authorization: Bearer <token>` header (optional, for future OAuth integration)

---

## Observability / 可观测性

### OpenTelemetry Integration / OpenTelemetry 集成

```
Client ──▶ Gateway ──▶ FastAPI ──▶ GPU Worker
  │           │           │           │
  │     traceparent  traceparent      │
  │     header       header           │
  │           │           │           │
  └───────────┴───────────┴───────────┘
              Distributed Trace
```

The gateway:

1. Creates a root span for each request using ACIP's `TelemetryService.startSpan()`
2. Injects `traceparent` header (W3C Trace Context format) into the proxied request
3. Records span attributes: method, path, status code, target URL, cache hit, duration
4. Exports traces to Zipkin/Jaeger via ACIP's `OpenTelemetryService`

### Prometheus Metrics / Prometheus 指标

The `metrics-plugin` exposes the following metrics at `/gateway/metrics`:

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `gateway_requests_total` | Counter | method, path, status | Total request count |
| `gateway_request_duration_seconds` | Histogram | method, path | Request latency distribution |
| `gateway_active_connections` | Gauge | — | Current active connections |
| `gateway_cache_hits_total` | Counter | — | Cache hit count |
| `gateway_cache_misses_total` | Counter | — | Cache miss count |
| `gateway_ratelimit_rejected_total` | Counter | — | Rate-limited requests |
| `gateway_auth_failures_total` | Counter | reason | Authentication failures |
| `gateway_workers_online` | Gauge | region | Online Workers by region |
| `gateway_proxy_errors_total` | Counter | target | Proxy errors by target |
| `gateway_plugin_errors_total` | Counter | plugin | Plugin errors by plugin name |

### Logging / 日志

Structured JSON logging with levels: `debug`, `info`, `warn`, `error`.

```json
{
  "level": "info",
  "timestamp": "2025-01-15T10:30:00.000Z",
  "requestId": "req-abc123",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "message": "Request completed",
  "method": "POST",
  "path": "/api/v1/jobs",
  "statusCode": 200,
  "duration": 145,
  "cached": false
}
```

---

## Deployment Topology / 部署拓扑

### Single-Node Deployment / 单节点部署

```
┌──────────────────────────────────────────────┐
│                    Host                       │
│                                               │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐ │
│  │ Gateway  │  │ FastAPI  │  │   Redis    │ │
│  │ :3000    │─▶│ :8000    │◀▶│   :6379    │ │
│  └──────────┘  └──────────┘  └────────────┘ │
│                      │                        │
│                ┌─────┴─────┐                  │
│                │ GPU Worker│                  │
│                └───────────┘                  │
└──────────────────────────────────────────────┘
```

### Multi-Node / HA Deployment / 多节点高可用部署

```
                    ┌──────────┐
                    │  Nginx   │
                    │  (LB)    │
                    └────┬─────┘
                 ┌───────┴───────┐
          ┌──────┴──────┐ ┌──────┴──────┐
          │  Gateway A  │ │  Gateway B  │
          │  :3000      │ │  :3000      │
          └──────┬──────┘ └──────┬──────┘
                 │               │
          ┌──────┴───────────────┴──────┐
          │         Redis Cluster        │
          └──────────────┬──────────────┘
                 ┌───────┴───────┐
          ┌──────┴──────┐ ┌──────┴──────┐
          │  FastAPI A  │ │  FastAPI B  │
          │  Region: US │ │  Region: EU │
          └──────┬──────┘ └──────┬──────┘
                 │               │
          ┌──────┴──────┐ ┌──────┴──────┐
          │ GPU Workers │ │ GPU Workers │
          │ US Cluster  │ │ EU Cluster  │
          └─────────────┘ └─────────────┘
```

---

## Design Decisions / 设计决策

### Why ACIP Core? / 为什么选择 ACIP Core？

| Consideration | Decision |
|--------------|----------|
| Plugin system | ACIP provides a mature plugin lifecycle with dependency resolution, hot-plugging, and version constraints |
| Event bus | EventManager supports typed events, priorities, filters, and cancellation — ideal for request pipeline |
| State management | RedisStateManager with PubSub subscriptions enables real-time Worker monitoring |
| Telemetry | Built-in OpenTelemetry support with span management |
| Resource monitoring | CPU/memory monitoring for gateway self-protection |

### Why Express (not Fastify)? / 为什么选择 Express 而不是 Fastify？

- `http-proxy-middleware` has first-class Express support
- Larger middleware ecosystem
- Simpler mental model for plugin-based request interception
- Performance difference is negligible for a gateway that proxies to Python

### Why not modify the Python backend? / 为什么不修改 Python 后端？

- **Separation of Concerns** — Gateway concerns (auth, rate limiting, caching) belong at the edge, not in the application server.
- **Independent Scaling** — Gateway can scale horizontally without scaling the compute-heavy Python backend.
- **Technology Freedom** — Node.js is better suited for I/O-heavy gateway tasks; Python is better for GPU compute.
- **Risk Isolation** — Gateway bugs cannot affect inference logic.

### Event-Driven vs Middleware Chain / 事件驱动 vs 中间件链

We chose ACIP's event system over Express middleware chaining because:

1. **Decoupling** — Plugins don't need to know about each other or their execution order (beyond priority).
2. **Hot-Plugging** — Plugins can be registered/unregistered without restarting the server.
3. **Cross-Cutting Events** — Non-request events (Worker online/offline, health degradation) fit naturally.
4. **Testability** — Each plugin can be tested in isolation with a mock EventManager.
