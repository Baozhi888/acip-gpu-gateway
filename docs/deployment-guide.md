# Deployment Guide / 部署指南

> How to deploy the ACIP GPU Gateway in various environments.

## Table of Contents

- [Prerequisites / 前置条件](#prerequisites--前置条件)
- [Docker Deployment / Docker 部署](#docker-deployment--docker-部署)
- [Docker Compose / Docker Compose 编排](#docker-compose--docker-compose-编排)
- [Bare-Metal Deployment / 裸机部署](#bare-metal-deployment--裸机部署)
- [Environment Variables / 环境变量](#environment-variables--环境变量)
- [Nginx Reverse Proxy / Nginx 反向代理](#nginx-reverse-proxy--nginx-反向代理)
- [Production Checklist / 生产环境清单](#production-checklist--生产环境清单)
- [Monitoring Setup / 监控配置](#monitoring-setup--监控配置)

---

## Prerequisites / 前置条件

| Requirement | Minimum | Recommended |
|------------|---------|-------------|
| Node.js | 18.x | 20.x LTS |
| Redis | 6.x | 7.x |
| Memory | 256 MB | 512 MB |
| CPU | 1 core | 2 cores |
| FastAPI Server | Running on accessible host | — |

---

## Docker Deployment / Docker 部署

### Dockerfile

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production=false
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --production && npm cache clean --force

COPY --from=builder /app/dist ./dist

EXPOSE 3000

USER node

CMD ["node", "dist/index.js"]
```

### Build and Run / 构建和运行

```bash
# Build image
docker build -t acip-gpu-gateway .

# Run container
docker run -d \
  --name acip-gateway \
  -p 3000:3000 \
  -e REDIS_URL=redis://host.docker.internal:6379 \
  -e FASTAPI_URL=http://host.docker.internal:8000 \
  -e AUTH_TOKEN_SALT=distributed-gpu-inference-v1 \
  acip-gpu-gateway
```

---

## Docker Compose / Docker Compose 编排

This configuration runs the gateway alongside the existing GPU inference stack:

此配置将网关与现有 GPU 推理堆栈一起运行：

### docker-compose.yml

```yaml
version: '3.8'

services:
  gateway:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - GATEWAY_PORT=3000
      - REDIS_URL=redis://redis:6379
      - FASTAPI_URL=http://fastapi:8000
      - AUTH_ENABLED=true
      - AUTH_TOKEN_SALT=distributed-gpu-inference-v1
      - RATE_LIMIT_ENABLED=true
      - RATE_LIMIT_MAX_REQUESTS=100
      - CACHE_ENABLED=true
      - CACHE_TTL_SECONDS=60
      - METRICS_ENABLED=true
      - LOG_LEVEL=info
    depends_on:
      redis:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/gateway/health"]
      interval: 10s
      timeout: 5s
      retries: 3

  # --- Existing services (reference only) ---
  # Uncomment if you want the gateway to manage these services

  # fastapi:
  #   image: your-fastapi-image:latest
  #   ports:
  #     - "8000:8000"
  #   environment:
  #     - REDIS_URL=redis://redis:6379
  #     - DATABASE_URL=postgresql://user:pass@postgres:5432/gpuinfer
  #   depends_on:
  #     - redis
  #     - postgres

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  # postgres:
  #   image: postgres:16-alpine
  #   environment:
  #     - POSTGRES_DB=gpuinfer
  #     - POSTGRES_USER=user
  #     - POSTGRES_PASSWORD=pass
  #   volumes:
  #     - postgres-data:/var/lib/postgresql/data

volumes:
  redis-data:
  # postgres-data:
```

### Start / 启动

```bash
# Start all services
docker compose up -d

# View logs
docker compose logs -f gateway

# Stop
docker compose down
```

---

## Bare-Metal Deployment / 裸机部署

```bash
# Clone and install
git clone https://github.com/Baozhi888/acip-gpu-gateway.git acip-gpu-gateway
cd acip-gpu-gateway
npm ci --production=false
npm run build

# Configure
cp .env.example .env
# Edit .env with production values

# Start with environment
NODE_ENV=production node dist/index.js
```

### Process Manager (PM2) / 进程管理

```bash
npm install -g pm2

# Start
pm2 start dist/index.js --name acip-gateway --env production

# Cluster mode (use all CPU cores)
pm2 start dist/index.js --name acip-gateway -i max --env production

# Auto-restart on crash
pm2 startup
pm2 save
```

### SystemD Service / SystemD 服务

```ini
# /etc/systemd/system/acip-gateway.service
[Unit]
Description=ACIP GPU Inference Gateway
After=network.target redis.service

[Service]
Type=simple
User=node
WorkingDirectory=/opt/acip-gpu-gateway
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=/opt/acip-gpu-gateway/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable acip-gateway
sudo systemctl start acip-gateway
```

---

## Environment Variables / 环境变量

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GATEWAY_PORT` | No | `3000` | Gateway HTTP port |
| `GATEWAY_HOST` | No | `0.0.0.0` | Bind host |
| `NODE_ENV` | No | `development` | Environment mode |
| `FASTAPI_URL` | **Yes** | `http://localhost:8000` | FastAPI backend URL |
| `FASTAPI_TIMEOUT` | No | `30000` | Proxy timeout (ms) |
| `REDIS_URL` | **Yes** | `redis://localhost:6379` | Redis connection URL |
| `REDIS_PASSWORD` | No | — | Redis password |
| `REDIS_DB` | No | `0` | Redis database number |
| `REDIS_KEY_PREFIX` | No | `gateway:` | Prefix for gateway Redis keys |
| `AUTH_ENABLED` | No | `true` | Enable authentication |
| `AUTH_TOKEN_SALT` | No | `distributed-gpu-inference-v1` | Token hashing salt |
| `AUTH_API_KEYS` | No | — | Comma-separated API keys |
| `RATE_LIMIT_ENABLED` | No | `true` | Enable rate limiting |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Rate limit window |
| `RATE_LIMIT_MAX_REQUESTS` | No | `100` | Max requests per window |
| `CACHE_ENABLED` | No | `true` | Enable response caching |
| `CACHE_TTL_SECONDS` | No | `60` | Cache TTL |
| `CACHE_MAX_SIZE` | No | `1000` | Max cache entries |
| `ROUTER_STRATEGY` | No | `round-robin` | Routing strategy |
| `ROUTER_HEALTH_CHECK_INTERVAL` | No | `10000` | Health check interval (ms) |
| `METRICS_ENABLED` | No | `true` | Enable Prometheus metrics |
| `METRICS_PATH` | No | `/gateway/metrics` | Metrics endpoint path |
| `OTEL_ENABLED` | No | `false` | Enable OpenTelemetry |
| `OTEL_SERVICE_NAME` | No | `acip-gpu-gateway` | OTel service name |
| `OTEL_ZIPKIN_ENDPOINT` | No | — | Zipkin collector endpoint |
| `LOG_LEVEL` | No | `info` | Logging level |
| `CORS_ORIGIN` | No | `*` | CORS allowed origins |

---

## Nginx Reverse Proxy / Nginx 反向代理

For production deployments, place Nginx in front of the gateway for TLS termination, static assets, and connection management.

生产环境部署时，在网关前面放置 Nginx 进行 TLS 终止、静态资源处理和连接管理。

```nginx
upstream acip_gateway {
    server 127.0.0.1:3000;
    # For multi-instance deployment:
    # server 127.0.0.1:3001;
    # server 127.0.0.1:3002;
    keepalive 32;
}

server {
    listen 443 ssl http2;
    server_name gpu-api.example.com;

    ssl_certificate     /etc/letsencrypt/live/gpu-api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gpu-api.example.com/privkey.pem;

    # Security headers
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";

    # Proxy to gateway
    location / {
        proxy_pass http://acip_gateway;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Timeouts
        proxy_connect_timeout 5s;
        proxy_send_timeout 30s;
        proxy_read_timeout 60s;
    }

    # Prometheus metrics — restrict access
    location /gateway/metrics {
        proxy_pass http://acip_gateway;
        allow 10.0.0.0/8;
        allow 172.16.0.0/12;
        deny all;
    }
}

server {
    listen 80;
    server_name gpu-api.example.com;
    return 301 https://$server_name$request_uri;
}
```

---

## Production Checklist / 生产环境清单

### Security / 安全

- [ ] Set `NODE_ENV=production`
- [ ] Configure `AUTH_ENABLED=true` with strong API keys
- [ ] Use TLS (Nginx SSL or direct Node.js TLS)
- [ ] Restrict `/gateway/metrics` and `/gateway/config` to internal IPs
- [ ] Set `CORS_ORIGIN` to specific domains (not `*`)
- [ ] Rotate `AUTH_TOKEN_SALT` periodically (coordinate with Python backend)
- [ ] Remove default/example API keys

### Performance / 性能

- [ ] Enable response caching (`CACHE_ENABLED=true`)
- [ ] Tune rate limits for expected traffic
- [ ] Use PM2 cluster mode or multiple Docker containers
- [ ] Configure Redis `maxmemory` and eviction policy
- [ ] Set appropriate proxy timeouts

### Reliability / 可靠性

- [ ] Configure health checks in orchestrator
- [ ] Set up automatic restart (PM2, Docker restart policy, SystemD)
- [ ] Enable Redis persistence (AOF or RDB)
- [ ] Configure Redis Sentinel or Cluster for HA
- [ ] Test failover scenarios

### Monitoring / 监控

- [ ] Configure Prometheus to scrape `/gateway/metrics`
- [ ] Set up Grafana dashboards
- [ ] Enable OpenTelemetry for distributed tracing
- [ ] Configure alerting on `gateway_proxy_errors_total` spike
- [ ] Monitor Redis memory usage
- [ ] Set up log aggregation (ELK, Loki, etc.)

---

## Monitoring Setup / 监控配置

### Prometheus Scrape Config / Prometheus 抓取配置

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'acip-gateway'
    scrape_interval: 15s
    static_configs:
      - targets: ['gateway:3000']
    metrics_path: '/gateway/metrics'
```

### Grafana Dashboard / Grafana 仪表盘

Import recommended panels:

1. **Request Rate** — `rate(gateway_requests_total[5m])`
2. **Error Rate** — `rate(gateway_requests_total{status=~"5.."}[5m])`
3. **P99 Latency** — `histogram_quantile(0.99, rate(gateway_request_duration_seconds_bucket[5m]))`
4. **Cache Hit Rate** — `rate(gateway_cache_hits_total[5m]) / (rate(gateway_cache_hits_total[5m]) + rate(gateway_cache_misses_total[5m]))`
5. **Active Workers** — `gateway_workers_online`
6. **Rate Limited** — `rate(gateway_ratelimit_rejected_total[5m])`
