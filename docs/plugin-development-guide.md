# Plugin Development Guide / 插件开发指南

> This guide covers how to develop custom plugins for the ACIP GPU Gateway, from basic structure to advanced patterns.

## Table of Contents

- [Plugin Interface / 插件接口](#plugin-interface--插件接口)
- [Plugin Lifecycle / 插件生命周期](#plugin-lifecycle--插件生命周期)
- [Quick Start Template / 快速开始模板](#quick-start-template--快速开始模板)
- [Built-in Plugins / 内置插件](#built-in-plugins--内置插件)
- [Event Naming Convention / 事件命名规范](#event-naming-convention--事件命名规范)
- [Configuration Injection / 配置注入](#configuration-injection--配置注入)
- [State Access / 状态访问](#state-access--状态访问)
- [Telemetry Integration / 遥测集成](#telemetry-integration--遥测集成)
- [Testing Plugins / 插件测试](#testing-plugins--插件测试)
- [Best Practices / 最佳实践](#best-practices--最佳实践)

---

## Plugin Interface / 插件接口

Every gateway plugin must implement the ACIP `Plugin` interface:

每个网关插件必须实现 ACIP 的 `Plugin` 接口：

```typescript
import { Plugin, ACIPCore } from '@maxeven/acip-core';

interface Plugin {
  /** Unique plugin identifier / 插件唯一标识 */
  name: string;

  /** Semantic version / 语义化版本 */
  version: string;

  /** Optional dependencies on other plugins / 可选的插件依赖 */
  dependencies?: string[];

  /**
   * Called when the plugin is registered with the core.
   * Use this to subscribe to events and initialize resources.
   * 插件注册到核心时调用。用于订阅事件和初始化资源。
   */
  install(core: ACIPCore): Promise<void>;

  /**
   * Called when the plugin is removed.
   * Clean up all subscriptions and resources.
   * 插件移除时调用。清理所有订阅和资源。
   */
  uninstall(): Promise<void>;

  /**
   * Called after all plugins are registered and dependencies resolved.
   * 所有插件注册完成且依赖解析后调用。
   */
  onLoad(): Promise<void>;

  /**
   * Called before the gateway shuts down.
   * 网关关闭前调用。
   */
  onUnload(): Promise<void>;

  /**
   * Optional: Called when the plugin transitions to active state.
   * 可选：插件进入活跃状态时调用。
   */
  onActivate?(): Promise<void>;

  /**
   * Optional: Called when the plugin is deactivated.
   * 可选：插件被停用时调用。
   */
  onDeactivate?(): Promise<void>;

  /**
   * Optional: Expose an API for other plugins to consume.
   * 可选：暴露 API 供其他插件使用。
   */
  getAPI?(): any;
}
```

### ACIPCore Context / ACIPCore 上下文

The `install()` method receives the full `ACIPCore` instance:

```typescript
interface ACIPCore {
  instanceId: string;            // Unique gateway instance ID
  eventManager: EventManager;    // Event publish/subscribe
  stateManager: StateManager;    // Persistent state (Redis)
  telemetryService: TelemetryService;  // Metrics and tracing
  resourceMonitor: ResourceMonitor;    // CPU/memory monitoring
  pluginManager: PluginManager;        // Plugin management
}
```

---

## Plugin Lifecycle / 插件生命周期

```
 1. Plugin class instantiated (constructor)
    │
 2. pluginManager.register(plugin)
    │   → plugin.install(core) is called
    │   → Status: Registered
    │
 3. pluginManager.loadAllPlugins()
    │   → Dependencies resolved (topological sort)
    │   → plugin.onLoad() called in dependency order
    │   → Status: Loaded
    │
 4. pluginManager.activatePlugin(name)
    │   → plugin.onActivate() called (if defined)
    │   → Status: Active
    │
 5. [Plugin is running, handling events]
    │
 6. pluginManager.deactivatePlugin(name)
    │   → plugin.onDeactivate() called (if defined)
    │   → Status: Loaded
    │
 7. pluginManager.unregister(name)
    │   → plugin.onUnload() called
    │   → plugin.uninstall() called
    │   → Status: Unloaded
```

### Key Points / 关键点

- **`install()`** is where you set up event subscriptions. Store the `core` reference for later use.
- **`onLoad()`** is called after ALL plugins are registered. Safe to access other plugins' APIs here.
- **`onActivate()`** signals the plugin is ready to process requests. Start timers/watchers here.
- **`onUnload()`** should clean up timers, close connections, and release resources.
- **`uninstall()`** should unsubscribe from all events.

---

## Quick Start Template / 快速开始模板

### Minimal Plugin / 最小插件

```typescript
import { Plugin, ACIPCore, createEvent, Subscription } from '@maxeven/acip-core';

export class MyPlugin implements Plugin {
  name = 'my-plugin';
  version = '1.0.0';

  private core!: ACIPCore;
  private subscriptions: Subscription[] = [];

  async install(core: ACIPCore): Promise<void> {
    this.core = core;

    // Subscribe to incoming requests
    const sub = core.eventManager.subscribe(
      'gateway:request:incoming',
      async (event) => {
        const { method, path } = event.payload;
        console.log(`[my-plugin] ${method} ${path}`);
      },
      50  // priority (higher = earlier execution)
    );
    this.subscriptions.push(sub);
  }

  async uninstall(): Promise<void> {
    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.subscriptions = [];
  }

  async onLoad(): Promise<void> {
    console.log('[my-plugin] Loaded');
  }

  async onUnload(): Promise<void> {
    console.log('[my-plugin] Unloading');
  }
}
```

### Plugin with Configuration / 带配置的插件

```typescript
import { Plugin, ACIPCore, Subscription } from '@maxeven/acip-core';

export interface LoggingPluginConfig {
  logBody: boolean;
  logHeaders: boolean;
  excludePaths: string[];
}

const DEFAULT_CONFIG: LoggingPluginConfig = {
  logBody: false,
  logHeaders: false,
  excludePaths: ['/gateway/health', '/gateway/metrics'],
};

export class LoggingPlugin implements Plugin {
  name = 'logging-plugin';
  version = '1.0.0';

  private core!: ACIPCore;
  private config: LoggingPluginConfig;
  private subscriptions: Subscription[] = [];

  constructor(config: Partial<LoggingPluginConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async install(core: ACIPCore): Promise<void> {
    this.core = core;

    const sub = core.eventManager.subscribe(
      'gateway:request:incoming',
      async (event) => {
        const { method, path, headers, body } = event.payload;

        if (this.config.excludePaths.includes(path)) return;

        const logEntry: Record<string, any> = { method, path };
        if (this.config.logHeaders) logEntry.headers = headers;
        if (this.config.logBody) logEntry.body = body;

        console.log('[logging]', JSON.stringify(logEntry));
      },
      10  // Low priority — runs after auth, rate limiting, etc.
    );
    this.subscriptions.push(sub);
  }

  async uninstall(): Promise<void> {
    this.subscriptions.forEach(sub => sub.unsubscribe());
  }

  async onLoad(): Promise<void> {}
  async onUnload(): Promise<void> {}
}
```

### Plugin with Dependencies / 带依赖的插件

```typescript
import { Plugin, ACIPCore } from '@maxeven/acip-core';

export class AnalyticsPlugin implements Plugin {
  name = 'analytics-plugin';
  version = '1.0.0';
  dependencies = ['auth-plugin', 'metrics-plugin'];  // Required plugins

  private core!: ACIPCore;

  async install(core: ACIPCore): Promise<void> {
    this.core = core;
  }

  async onLoad(): Promise<void> {
    // Safe to access dependency APIs here — dependencies are guaranteed loaded
    const authAPI = this.core.pluginManager.getPluginAPI('auth-plugin');
    const metricsAPI = this.core.pluginManager.getPluginAPI('metrics-plugin');

    console.log('[analytics] Dependencies loaded, auth and metrics APIs available');
  }

  async uninstall(): Promise<void> {}
  async onUnload(): Promise<void> {}
}
```

### Plugin with Exposed API / 暴露 API 的插件

```typescript
import { Plugin, ACIPCore } from '@maxeven/acip-core';

export class WorkerInfoPlugin implements Plugin {
  name = 'worker-info-plugin';
  version = '1.0.0';

  private core!: ACIPCore;
  private workers: Map<string, any> = new Map();

  async install(core: ACIPCore): Promise<void> {
    this.core = core;

    core.eventManager.subscribe('gateway:worker:updated', async (event) => {
      this.workers.set(event.payload.workerId, event.payload);
    });

    core.eventManager.subscribe('gateway:worker:offline', async (event) => {
      this.workers.delete(event.payload.workerId);
    });
  }

  async uninstall(): Promise<void> {}
  async onLoad(): Promise<void> {}
  async onUnload(): Promise<void> {}

  // Expose API for other plugins
  getAPI() {
    return {
      getWorkerCount: () => this.workers.size,
      getWorker: (id: string) => this.workers.get(id),
      getAllWorkers: () => Array.from(this.workers.values()),
      getWorkersByRegion: (region: string) =>
        Array.from(this.workers.values()).filter(w => w.region === region),
    };
  }
}
```

---

## Built-in Plugins / 内置插件

### auth-plugin

**Purpose / 用途**: Authenticate incoming requests using Token or API Key.

**Events Subscribed / 订阅事件**:
- `gateway:request:incoming` (priority: 100)

**Events Published / 发布事件**:
- `gateway:auth:validated` — On success
- `gateway:auth:rejected` — On failure

**Configuration / 配置**:
| Env Variable | Default | Description |
|-------------|---------|-------------|
| `AUTH_ENABLED` | `true` | Enable/disable authentication |
| `AUTH_TOKEN_SALT` | `distributed-gpu-inference-v1` | Salt for SHA-256 token hashing |
| `AUTH_API_KEYS` | — | Comma-separated valid API keys |

---

### rate-limit-plugin

**Purpose / 用途**: Enforce request rate limits using a Redis-backed sliding window.

**Events Subscribed / 订阅事件**:
- `gateway:request:incoming` (priority: 90)

**Events Published / 发布事件**:
- `gateway:ratelimit:allowed`
- `gateway:ratelimit:exceeded`

**Configuration / 配置**:
| Env Variable | Default | Description |
|-------------|---------|-------------|
| `RATE_LIMIT_ENABLED` | `true` | Enable/disable rate limiting |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window size in milliseconds |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Max requests per window |

**Algorithm / 算法**: Sliding window with Redis sorted sets.

```
ZADD gateway:ratelimit:{key} {timestamp} {requestId}
ZREMRANGEBYSCORE gateway:ratelimit:{key} -inf {timestamp - windowMs}
ZCARD gateway:ratelimit:{key}
EXPIRE gateway:ratelimit:{key} {windowMs / 1000 + 1}
```

---

### cache-plugin

**Purpose / 用途**: Cache GET responses to reduce backend load.

**Events Subscribed / 订阅事件**:
- `gateway:request:incoming` (priority: 80) — Check cache
- `gateway:request:completed` (priority: 5) — Store response

**Events Published / 发布事件**:
- `gateway:cache:hit`
- `gateway:cache:miss`
- `gateway:cache:stored`

**Configuration / 配置**:
| Env Variable | Default | Description |
|-------------|---------|-------------|
| `CACHE_ENABLED` | `true` | Enable/disable caching |
| `CACHE_TTL_SECONDS` | `60` | Cache TTL in seconds |
| `CACHE_MAX_SIZE` | `1000` | Max cached entries |

---

### router-plugin

**Purpose / 用途**: Select the optimal FastAPI instance based on Worker availability and region affinity.

**Events Subscribed / 订阅事件**:
- `gateway:request:incoming` (priority: 70)
- `gateway:worker:updated`

**Events Published / 发布事件**:
- `gateway:router:selected`
- `gateway:router:failover`

**Configuration / 配置**:
| Env Variable | Default | Description |
|-------------|---------|-------------|
| `ROUTER_STRATEGY` | `round-robin` | Routing strategy |
| `ROUTER_HEALTH_CHECK_INTERVAL` | `10000` | Health check interval (ms) |

**Strategies / 策略**:
- `round-robin` — Rotate through available instances
- `least-connections` — Route to least loaded instance
- `region-affinity` — Prefer instance in same region as client

---

### metrics-plugin

**Purpose / 用途**: Expose Prometheus-compatible metrics.

**Events Subscribed / 订阅事件**:
- `gateway:request:completed` (priority: 10)
- All `gateway:*` events for comprehensive metrics

**Exposed Endpoint / 暴露端点**: `GET /gateway/metrics`

**Configuration / 配置**:
| Env Variable | Default | Description |
|-------------|---------|-------------|
| `METRICS_ENABLED` | `true` | Enable/disable metrics |
| `METRICS_PATH` | `/gateway/metrics` | Metrics endpoint path |

---

### health-plugin

**Purpose / 用途**: Provide health check endpoints for the gateway and downstream services.

**Exposed Endpoints / 暴露端点**:
- `GET /gateway/health` — Gateway health
- `GET /gateway/health/detailed` — Detailed health with downstream checks

**Health Check Response / 健康检查响应**:
```json
{
  "status": "healthy",
  "uptime": 86400,
  "version": "0.1.0",
  "checks": {
    "redis": { "status": "healthy", "latency": 2 },
    "fastapi": { "status": "healthy", "latency": 15 },
    "plugins": { "loaded": 6, "active": 6, "errors": 0 }
  }
}
```

---

## Event Naming Convention / 事件命名规范

All events follow the pattern: **`gateway:<domain>:<action>`**

所有事件遵循模式：**`gateway:<域>:<动作>`**

### Domains / 域

| Domain | Description |
|--------|-------------|
| `request` | HTTP request lifecycle |
| `auth` | Authentication events |
| `ratelimit` | Rate limiting events |
| `cache` | Caching events |
| `router` | Routing decisions |
| `worker` | Worker status changes |
| `job` | Job lifecycle |
| `health` | Health check events |
| `plugin` | Plugin system events |

### Creating Custom Events / 创建自定义事件

```typescript
import { createEvent } from '@maxeven/acip-core';

// Always use the gateway: prefix for gateway events
const event = createEvent('gateway:myfeature:action', {
  key: 'value',
  timestamp: Date.now(),
});

core.eventManager.publish(event);
```

### Event Filtering / 事件过滤

```typescript
// Subscribe with a filter — only handle POST requests
core.eventManager.subscribe(
  'gateway:request:incoming',
  async (event) => { /* handler */ },
  50,
  (event) => event.payload.method === 'POST'  // filter
);
```

---

## Configuration Injection / 配置注入

Plugins receive configuration through their constructor:

插件通过构造函数接收配置：

```typescript
// Gateway creates plugins with config
const gateway = new GatewayCore();
gateway.registerPlugin(new AuthPlugin({
  enabled: true,
  salt: process.env.AUTH_TOKEN_SALT,
  apiKeys: process.env.AUTH_API_KEYS?.split(',') ?? [],
}));
```

For runtime configuration changes, use the StateManager:

```typescript
// Read config from Redis
const config = await core.stateManager.get<MyConfig>('gateway:config:my-plugin');

// Watch for config changes
await core.stateManager.subscribe('gateway:config:my-plugin', (newConfig) => {
  this.config = newConfig;
  console.log('Configuration updated dynamically');
});
```

---

## State Access / 状态访问

### Reading State / 读取状态

```typescript
// Read a Worker's status from Redis (written by Python backend)
const workerStatus = await core.stateManager.get<WorkerStatus>('worker:gpu-01:status');
```

### Writing State / 写入状态

```typescript
// Always use the gateway: prefix for gateway-owned keys
await core.stateManager.set('gateway:myplugin:data', { count: 42 });
```

### Atomic Transactions / 原子事务

```typescript
// Atomic read-modify-write
await core.stateManager.transaction('gateway:myplugin:counter', (current) => {
  return (current ?? 0) + 1;
});
```

---

## Telemetry Integration / 遥测集成

### Recording Metrics / 记录指标

```typescript
import { MetricType } from '@maxeven/acip-core';

// Counter
core.telemetryService.recordMetric({
  name: 'my_plugin_processed_total',
  type: MetricType.Counter,
  value: 1,
  tags: { result: 'success' },
});

// Histogram
core.telemetryService.recordMetric({
  name: 'my_plugin_duration_ms',
  type: MetricType.Histogram,
  value: elapsed,
});
```

### Distributed Tracing / 分布式追踪

```typescript
// Create a span for your plugin's processing
const span = core.telemetryService.startSpan('my-plugin:process');
try {
  // Do work...
  span.setAttribute('my-plugin.result', 'success');
} catch (error) {
  span.recordException(error as Error);
  throw error;
} finally {
  span.end();
}
```

---

## Testing Plugins / 插件测试

### Unit Test Example / 单元测试示例

```typescript
import { createCore, createEvent } from '@maxeven/acip-core';
import { MyPlugin } from '../src/plugins/my-plugin';

describe('MyPlugin', () => {
  let core: ReturnType<typeof createCore>;
  let plugin: MyPlugin;

  beforeEach(async () => {
    core = createCore();  // Uses in-memory defaults
    plugin = new MyPlugin();
    await core.pluginManager.register(plugin);
    await core.pluginManager.loadAllPlugins();
  });

  afterEach(async () => {
    await core.pluginManager.shutdown();
  });

  it('should handle incoming requests', async () => {
    const event = createEvent('gateway:request:incoming', {
      id: 'test-1',
      method: 'GET',
      path: '/api/v1/jobs',
      headers: {},
      query: {},
      ip: '127.0.0.1',
      timestamp: Date.now(),
    });

    await core.eventManager.publish(event);

    // Assert plugin behavior...
  });

  it('should expose API', () => {
    const api = plugin.getAPI?.();
    expect(api).toBeDefined();
    expect(typeof api.someMethod).toBe('function');
  });
});
```

### Integration Test with Redis / Redis 集成测试

```typescript
import { createCore, RedisStateManager } from '@maxeven/acip-core';
import { RateLimitPlugin } from '../src/plugins/rate-limit-plugin';

describe('RateLimitPlugin (integration)', () => {
  let core: ReturnType<typeof createCore>;

  beforeEach(async () => {
    const stateManager = new RedisStateManager(
      'redis://localhost:6379',
      /* eventManager */ core.eventManager,
      /* telemetryService */ core.telemetryService
    );
    core = createCore({ stateManager });
  });

  // Tests with real Redis...
});
```

---

## Best Practices / 最佳实践

### Do / 推荐

1. **Store the `core` reference** in `install()` for use throughout the plugin lifecycle.
2. **Track all subscriptions** and unsubscribe in `uninstall()` to prevent memory leaks.
3. **Use the `gateway:` prefix** for all events and Redis keys your plugin creates.
4. **Handle errors gracefully** — a plugin error should not crash the gateway.
5. **Use priorities wisely** — auth (100) > rate limit (90) > cache (80) > routing (70) > metrics (10).
6. **Use `createEvent()`** helper instead of manually constructing event objects.
7. **Record telemetry** for operations that may need debugging in production.

### Don't / 避免

1. **Don't import other plugins directly** — use events or `getPluginAPI()`.
2. **Don't block the event loop** — use `async/await` for I/O operations.
3. **Don't write to Redis keys without the `gateway:` prefix** — this avoids collisions with Python backend.
4. **Don't skip `onUnload()` cleanup** — connections and timers must be released.
5. **Don't throw from event handlers without catching** — unhandled rejections affect other plugins.
6. **Don't store large data in events** — events should contain references (IDs), not full payloads.
