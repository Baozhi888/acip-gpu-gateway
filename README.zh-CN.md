# ACIP GPU 推理网关

> 基于 [ACIP Core](https://www.npmjs.com/package/@maxeven/acip-core) 插件架构构建的智能 API 网关，专为分布式 GPU 推理平台设计。

[English](./README.md)

## 概述

ACIP GPU Gateway 是一个放置在现有 FastAPI GPU 推理服务前面的 API 网关。它通过 ACIP 的插件机制提供可插拔的鉴权、限流、缓存、智能路由和可观测性能力——**无需修改任何 Python 后端代码**。

```
客户端 → [ACIP Gateway :3000] → [FastAPI Server :8000] → [GPU Workers]
              │                        │
              ├── 鉴权插件              ├── PostgreSQL
              ├── 限流插件              └── Redis (共享)
              ├── 缓存插件                    │
              ├── 路由插件                    │
              ├── 指标插件                    │
              └── 健康检查插件                │
                    │                        │
                    └────── Redis ←───────────┘
```

## 核心价值

- **插件化架构** — 每个网关能力都是一个 ACIP 插件，支持运行时启用、禁用、替换。
- **事件驱动** — 组件之间通过 ACIP EventManager 通信，零耦合。
- **Redis 状态共享** — 网关读取 Python Worker 写入的心跳数据，同时写入自己的限流/缓存/会话数据，共用同一 Redis 实例，命名空间隔离。
- **Token 体系兼容** — 复用 Python 后端的 SHA-256 + salt 鉴权方案，无需迁移。
- **OpenTelemetry 集成** — 生成 trace ID 并传播到 FastAPI，实现端到端分布式追踪。
- **Prometheus 指标** — 内置 `/gateway/metrics` 端点，直接对接 Grafana 仪表盘。

## 快速开始

### 环境要求

- Node.js >= 18
- Redis >= 6
- 运行中的 FastAPI GPU 推理服务

### 安装

```bash
git clone <repo-url> acip-gpu-gateway
cd acip-gpu-gateway
npm install
```

### 配置

```bash
cp .env.example .env
# 编辑 .env 文件，配置 Redis 地址、FastAPI 地址等
```

### 开发模式

```bash
npm run dev
```

网关将在 `http://localhost:3000` 启动，并自动热重载。

### 生产部署

```bash
npm run build
npm start
```

### Docker 部署

```bash
docker compose up -d
```

## 架构设计

完整架构文档请参阅 [docs/architecture.md](./docs/architecture.md)。

### 请求生命周期

```
HTTP 请求
  → Express 中间件 (CORS, Helmet)
  → ACIP 事件: 'gateway:request:incoming'
  → 鉴权插件: 验证 Token / API Key
  → 限流插件: 检查频率限制
  → 缓存插件: 检查缓存命中
  → 路由插件: 选择目标 FastAPI 实例（区域亲和）
  → 反向代理 → FastAPI Server
  → 响应回写
  → ACIP 事件: 'gateway:request:completed'
  → 指标插件: 记录 Prometheus 指标
```

### Redis 键空间规划

| 键模式 | 所有者 | 说明 |
|--------|--------|------|
| `worker:*` | Python Worker | Worker 心跳、状态、GPU 信息 |
| `queue:*` | Python Server | 任务队列状态 |
| `gateway:ratelimit:*` | Gateway | 限流计数器 |
| `gateway:cache:*` | Gateway | 响应缓存 |
| `gateway:session:*` | Gateway | 会话数据 |

## 内置插件

| 插件 | 说明 | 关键配置 |
|------|------|----------|
| `auth-plugin` | 鉴权 — 兼容 Python 后端 Token 体系 | `AUTH_TOKEN_SALT`, `AUTH_API_KEYS` |
| `rate-limit-plugin` | 限流 — 基于 Redis 的滑动窗口算法 | `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS` |
| `cache-plugin` | 缓存 — 响应级别缓存 | `CACHE_TTL_SECONDS`, `CACHE_MAX_SIZE` |
| `router-plugin` | 路由 — 区域亲和性 + 负载均衡 | `ROUTER_STRATEGY` |
| `metrics-plugin` | 指标 — Prometheus 格式导出 | `METRICS_PATH` |
| `health-plugin` | 健康检查 — 网关 + 下游服务状态 | — |

## API 端点

### 代理端点（转发到 FastAPI）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/jobs` | POST | 提交推理任务 |
| `/api/v1/jobs/:id` | GET | 查询任务状态 |
| `/api/v1/queue/stats` | GET | 队列统计信息 |

### 网关端点（本地处理）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/workers` | GET | Worker 列表（从 Redis 聚合） |
| `/gateway/health` | GET | 网关健康检查 |
| `/gateway/metrics` | GET | Prometheus 指标 |
| `/gateway/plugins` | GET | 插件状态列表 |
| `/gateway/config` | GET | 运行时配置查看 |

完整 API 文档请参阅 [docs/api-reference.md](./docs/api-reference.md)。

## 自定义插件开发

```typescript
import { Plugin, ACIPCore, createEvent } from '@maxeven/acip-core';

export class MyCustomPlugin implements Plugin {
  name = 'my-custom-plugin';
  version = '1.0.0';

  private core!: ACIPCore;

  async install(core: ACIPCore): Promise<void> {
    this.core = core;

    // 订阅请求事件
    core.eventManager.subscribe('gateway:request:incoming', async (event) => {
      console.log(`收到请求: ${event.payload.method} ${event.payload.path}`);
    });
  }

  async uninstall(): Promise<void> {}
  async onLoad(): Promise<void> { console.log('插件加载完成'); }
  async onUnload(): Promise<void> { console.log('插件已卸载'); }
}
```

完整的插件开发指南请参阅 [docs/plugin-development-guide.md](./docs/plugin-development-guide.md)。

## 项目结构

```
acip-gpu-gateway/
├── src/
│   ├── index.ts                  # 入口文件
│   ├── gateway.ts                # 网关核心类（基于 ACIP Core）
│   ├── config.ts                 # 配置管理
│   ├── server.ts                 # HTTP 服务器 (Express)
│   ├── plugins/                  # 内置插件
│   │   ├── auth-plugin.ts        # 鉴权插件
│   │   ├── rate-limit-plugin.ts  # 限流插件
│   │   ├── cache-plugin.ts       # 缓存插件
│   │   ├── router-plugin.ts      # 路由插件
│   │   ├── metrics-plugin.ts     # 指标插件
│   │   └── health-plugin.ts      # 健康检查插件
│   ├── middleware/                # HTTP 中间件
│   │   ├── proxy.ts              # 反向代理
│   │   ├── request-signing.ts    # 请求签名
│   │   └── cors.ts               # CORS 处理
│   ├── services/                 # 业务服务
│   │   ├── worker-registry.ts    # Worker 注册表
│   │   ├── job-tracker.ts        # 任务追踪器
│   │   └── region-resolver.ts    # 区域解析器
│   └── types/                    # 类型定义
│       ├── gateway.ts
│       ├── worker.ts
│       └── job.ts
├── tests/
├── docs/
├── Dockerfile
└── docker-compose.yml
```

## 文档

- [架构设计文档](./docs/architecture.md)
- [插件开发指南](./docs/plugin-development-guide.md)
- [API 接口文档](./docs/api-reference.md)
- [部署指南](./docs/deployment-guide.md)
- [集成指南](./docs/integration-guide.md)

## 许可证

MIT
