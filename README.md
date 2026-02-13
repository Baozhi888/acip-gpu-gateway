# ACIP GPU Inference Gateway

> An intelligent API Gateway for Distributed GPU Inference platforms, built on the [ACIP Core](https://www.npmjs.com/package/@maxeven/acip-core) plugin architecture.

[中文文档](./README.zh-CN.md)

## Overview

ACIP GPU Gateway sits in front of your existing FastAPI-based GPU inference server, adding pluggable authentication, rate limiting, caching, smart routing, and observability — all without modifying a single line of your Python backend.

```
Client → [ACIP Gateway :3000] → [FastAPI Server :8000] → [GPU Workers]
              │                        │
              ├── AuthPlugin           ├── PostgreSQL
              ├── RateLimitPlugin      └── Redis (shared)
              ├── CachePlugin                │
              ├── RouterPlugin               │
              ├── MetricsPlugin              │
              └── HealthPlugin               │
                    │                        │
                    └────── Redis ←───────────┘
```

## Key Features

- **Plugin Architecture** — Every gateway capability is an ACIP plugin. Enable, disable, or replace any component at runtime.
- **Event-Driven** — Components communicate through ACIP's EventManager, keeping coupling near zero.
- **Shared Redis State** — The gateway reads Worker heartbeat data written by Python workers and writes its own rate-limit / cache / session data — all in the same Redis instance with namespace isolation.
- **Token Compatibility** — Reuses the Python backend's SHA-256 + salt authentication scheme. No migration needed.
- **OpenTelemetry Ready** — Generates trace IDs and propagates them to FastAPI for end-to-end distributed tracing.
- **Prometheus Metrics** — Built-in `/gateway/metrics` endpoint for Grafana dashboards.

## Quick Start

### Prerequisites

- Node.js >= 18
- Redis >= 6
- A running FastAPI GPU Inference Server

### Installation

```bash
git clone <repo-url> acip-gpu-gateway
cd acip-gpu-gateway
npm install
```

### Configuration

```bash
cp .env.example .env
# Edit .env with your Redis URL, FastAPI address, etc.
```

### Development

```bash
npm run dev
```

### Production

```bash
npm run build
npm start
```

### Docker

```bash
docker compose up -d
```

## Architecture

See [docs/architecture.md](./docs/architecture.md) for the full system design.

### Request Lifecycle

```
HTTP Request
  → Express Middleware (CORS, Helmet)
  → ACIP Event: 'gateway:request:incoming'
  → AuthPlugin: validate Token / API Key
  → RateLimitPlugin: check rate limit
  → CachePlugin: check cache hit
  → RouterPlugin: select target FastAPI instance
  → Proxy → FastAPI Server
  → Response
  → ACIP Event: 'gateway:request:completed'
  → MetricsPlugin: record metrics
```

## Built-in Plugins

| Plugin | Description |
|--------|-------------|
| `auth-plugin` | Token / API Key authentication compatible with Python backend |
| `rate-limit-plugin` | Redis-backed sliding window rate limiter |
| `cache-plugin` | Response caching with configurable TTL |
| `router-plugin` | Smart routing with region affinity and load balancing |
| `metrics-plugin` | Prometheus metrics exporter |
| `health-plugin` | Health check endpoints for gateway and downstream services |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/jobs` | POST | Submit inference job (proxied) |
| `/api/v1/jobs/:id` | GET | Query job status (proxied) |
| `/api/v1/queue/stats` | GET | Queue statistics (proxied) |
| `/api/v1/workers` | GET | Worker list (gateway aggregated from Redis) |
| `/gateway/health` | GET | Gateway health check |
| `/gateway/metrics` | GET | Prometheus metrics |
| `/gateway/plugins` | GET | Plugin status |
| `/gateway/config` | GET | Runtime configuration |

See [docs/api-reference.md](./docs/api-reference.md) for complete API documentation.

## Documentation

- [Architecture Design](./docs/architecture.md)
- [Plugin Development Guide](./docs/plugin-development-guide.md)
- [API Reference](./docs/api-reference.md)
- [Deployment Guide](./docs/deployment-guide.md)
- [Integration Guide](./docs/integration-guide.md)

## Developing Custom Plugins

```typescript
import { Plugin, ACIPCore, createEvent } from '@maxeven/acip-core';

export class MyPlugin implements Plugin {
  name = 'my-plugin';
  version = '1.0.0';

  private core!: ACIPCore;

  async install(core: ACIPCore): Promise<void> {
    this.core = core;
    core.eventManager.subscribe('gateway:request:incoming', async (event) => {
      // Your logic here
    });
  }

  async uninstall(): Promise<void> {}
  async onLoad(): Promise<void> {}
  async onUnload(): Promise<void> {}
}
```

See [docs/plugin-development-guide.md](./docs/plugin-development-guide.md) for the full guide.

## License

MIT
