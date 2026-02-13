# Integration Guide / 集成指南

> How to integrate ACIP GPU Gateway with the existing Distributed GPU Inference platform.

## Table of Contents

- [Overview / 概述](#overview--概述)
- [Integration Steps / 集成步骤](#integration-steps--集成步骤)
- [Redis Key Space Planning / Redis 键空间规划](#redis-key-space-planning--redis-键空间规划)
- [Token Compatibility / Token 兼容性验证](#token-compatibility--token-兼容性验证)
- [OpenTelemetry Trace Chaining / OTel 链路串联](#opentelemetry-trace-chaining--otel-链路串联)
- [Zero-Downtime Migration / 零停机迁移](#zero-downtime-migration--零停机迁移)
- [Troubleshooting / 问题排查](#troubleshooting--问题排查)

---

## Overview / 概述

The integration adds ACIP GPU Gateway in front of the existing FastAPI server without requiring any changes to the Python backend.

集成方案在现有 FastAPI 服务前面添加 ACIP GPU Gateway，无需修改任何 Python 后端代码。

### Before / 集成前

```
Client → FastAPI Server (:8000) → GPU Workers
                │
                └── Redis
```

### After / 集成后

```
Client → ACIP Gateway (:3000) → FastAPI Server (:8000) → GPU Workers
              │                        │
              └── Redis (shared) ──────┘
```

### What Changes / 变更内容

| Component | Change |
|-----------|--------|
| Client | Point to Gateway port (3000) instead of FastAPI (8000) |
| FastAPI | No changes |
| GPU Workers | No changes |
| Redis | No changes (gateway uses separate key namespace) |
| Firewall | Optionally restrict direct FastAPI access from external |

---

## Integration Steps / 集成步骤

### Step 1: Deploy Gateway / 部署网关

```bash
# Clone and configure
git clone https://github.com/Baozhi888/acip-gpu-gateway.git acip-gpu-gateway
cd acip-gpu-gateway
cp .env.example .env
```

Edit `.env`:
```bash
# Point to your existing FastAPI server
FASTAPI_URL=http://your-fastapi-host:8000

# Use the SAME Redis instance as your Python backend
REDIS_URL=redis://your-redis-host:6379

# Use the SAME salt as your Python backend
AUTH_TOKEN_SALT=distributed-gpu-inference-v1
```

```bash
npm install
npm run build
npm start
```

### Step 2: Verify Connectivity / 验证连通性

```bash
# Health check
curl http://localhost:3000/gateway/health

# Expected: {"status":"healthy","version":"0.1.0",...}

# Test proxy (without auth for initial test)
curl http://localhost:3000/api/v1/queue/stats

# Should return the same data as:
curl http://localhost:8000/api/v1/queue/stats
```

### Step 3: Verify Token Compatibility / 验证 Token 兼容

```bash
# Use the same token that works with your FastAPI server
curl -H "X-Worker-Token: your-worker-token" \
     http://localhost:3000/api/v1/jobs
```

### Step 4: Verify Worker Status / 验证 Worker 状态

```bash
# This endpoint reads Worker data directly from Redis
curl http://localhost:3000/api/v1/workers

# Should list all active Workers
```

### Step 5: Switch Client Traffic / 切换客户端流量

Update your client configuration to point to `http://gateway-host:3000` instead of `http://fastapi-host:8000`.

### Step 6: Restrict Direct FastAPI Access / 限制 FastAPI 直接访问 (Optional)

```bash
# If using iptables:
iptables -A INPUT -p tcp --dport 8000 -s gateway-host -j ACCEPT
iptables -A INPUT -p tcp --dport 8000 -j DROP
```

---

## Redis Key Space Planning / Redis 键空间规划

The gateway and Python backend share one Redis instance. Key namespace isolation prevents collisions.

网关和 Python 后端共享一个 Redis 实例。键命名空间隔离防止冲突。

### Namespace Map / 命名空间映射

```
Redis Instance
├── worker:*                    ← Written by Python GPU Workers
│   ├── worker:{id}:status     — Worker status JSON
│   ├── worker:{id}:gpu        — GPU info JSON
│   └── worker:{id}:heartbeat  — Heartbeat timestamp
│
├── queue:*                     ← Written by Python FastAPI Server
│   ├── queue:stats            — Queue statistics
│   └── queue:job:{id}         — Job data
│
├── gateway:ratelimit:*         ← Written by Gateway
│   └── gateway:ratelimit:{ip} — Sorted set of request timestamps
│
├── gateway:cache:*             ← Written by Gateway
│   ├── gateway:cache:{hash}   — Cached response JSON
│   └── gateway:cache:keys     — Index of cached keys
│
├── gateway:session:*           ← Written by Gateway
│   └── gateway:session:{tok}  — Session metadata
│
└── gateway:config              ← Written by Gateway
    └── gateway:config          — Runtime config JSON
```

### Key Isolation Rules / 键隔离规则

1. **Gateway NEVER writes** to `worker:*` or `queue:*` prefixes.
2. **Python backend NEVER reads** from `gateway:*` prefix (it doesn't know about it).
3. **Gateway reads** from `worker:*` and `queue:*` (read-only observation).
4. All gateway-owned keys use the `gateway:` prefix exclusively.

### Redis Memory Estimation / Redis 内存估算

| Key Type | Count | Avg Size | Total |
|----------|-------|----------|-------|
| `worker:*` | ~50 Workers × 3 keys | ~500 B | ~75 KB |
| `queue:*` | ~1000 active jobs | ~1 KB | ~1 MB |
| `gateway:ratelimit:*` | ~1000 clients | ~200 B | ~200 KB |
| `gateway:cache:*` | ~1000 entries | ~5 KB | ~5 MB |
| **Total** | | | **~6.3 MB** |

Redis memory overhead is negligible. The default `maxmemory 256mb` is sufficient.

### Monitoring Key Space / 监控键空间

```bash
# Check gateway key count
redis-cli KEYS "gateway:*" | wc -l

# Check cache size
redis-cli SCARD "gateway:cache:keys"

# Check Worker heartbeats
redis-cli KEYS "worker:*:heartbeat"

# Memory usage for a namespace
redis-cli --bigkeys --pattern "gateway:*"
```

---

## Token Compatibility / Token 兼容性验证

The gateway uses the **exact same** SHA-256 + salt algorithm as the Python backend.

网关使用与 Python 后端**完全相同**的 SHA-256 + salt 算法。

### Python Backend Implementation / Python 后端实现

```python
import hashlib

SALT = "distributed-gpu-inference-v1"

def hash_token(token: str) -> str:
    return hashlib.sha256(f"{token}{SALT}".encode()).hexdigest()

def validate_token(token: str, expected_hash: str) -> bool:
    return hash_token(token) == expected_hash
```

### Gateway Implementation / 网关实现

```typescript
import { createHash } from 'crypto';

const SALT = 'distributed-gpu-inference-v1';

function hashToken(token: string): string {
  return createHash('sha256').update(`${token}${SALT}`).digest('hex');
}

function validateToken(token: string, expectedHash: string): boolean {
  return hashToken(token) === expectedHash;
}
```

### Verification Script / 验证脚本

Run this to verify both implementations produce identical hashes:

运行此脚本验证两种实现产生相同的哈希值：

```bash
# Python
python3 -c "
import hashlib
token = 'test-token-123'
salt = 'distributed-gpu-inference-v1'
print(hashlib.sha256(f'{token}{salt}'.encode()).hexdigest())
"

# Node.js
node -e "
const crypto = require('crypto');
const token = 'test-token-123';
const salt = 'distributed-gpu-inference-v1';
console.log(crypto.createHash('sha256').update(token + salt).digest('hex'));
"

# Both should output the same hash
```

### Migration Notes / 迁移注意事项

- **No token migration needed** — Same algorithm, same salt, same result.
- **API Key support** — The gateway adds a simpler `X-API-Key` mechanism as an alternative. This does NOT require changes to the Python backend.
- **Salt configuration** — Ensure `AUTH_TOKEN_SALT` in `.env` matches the Python backend's salt value exactly.

---

## OpenTelemetry Trace Chaining / OTel 链路串联

The gateway generates trace context and propagates it to FastAPI for end-to-end distributed tracing.

网关生成追踪上下文并传播到 FastAPI，实现端到端分布式追踪。

### How It Works / 工作原理

```
1. Client sends request (no trace context)
   │
2. Gateway creates root span
   │   spanName: "gateway:proxy"
   │   traceId: "4bf92f3577b34da6a3ce929d0e0e4736"
   │   spanId:  "00f067aa0ba902b7"
   │
3. Gateway injects W3C traceparent header into proxied request
   │   traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
   │
4. FastAPI receives request with trace context
   │   (FastAPI's OpenTelemetry middleware picks up traceparent)
   │
5. FastAPI creates child span
   │   Same traceId, new spanId
   │
6. Full trace visible in Zipkin/Jaeger:
       Gateway Span ──────────────────────
                     FastAPI Span ────────
                                  Worker Span ──
```

### Gateway Configuration / 网关配置

```bash
# .env
OTEL_ENABLED=true
OTEL_SERVICE_NAME=acip-gpu-gateway
OTEL_ZIPKIN_ENDPOINT=http://zipkin:9411/api/v2/spans
```

### FastAPI Configuration / FastAPI 配置

If your FastAPI server already uses OpenTelemetry, no changes are needed. The gateway's `traceparent` header is picked up automatically by standard OTLP middleware.

If not already configured:

```python
# In your FastAPI app
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

FastAPIInstrumentor.instrument_app(app)
```

### Headers Injected / 注入的 Header

| Header | Format | Example |
|--------|--------|---------|
| `traceparent` | W3C Trace Context | `00-{traceId}-{spanId}-01` |
| `X-Request-ID` | UUID v4 | `550e8400-e29b-41d4-a716-446655440000` |

---

## Zero-Downtime Migration / 零停机迁移

Follow these steps to migrate from direct FastAPI access to gateway-proxied access without any service interruption.

按照以下步骤从直接访问 FastAPI 迁移到通过网关代理访问，不会产生任何服务中断。

### Phase 1: Deploy Gateway (Shadow Mode) / 部署网关（影子模式）

Deploy the gateway alongside the existing FastAPI server. Don't route any production traffic through it yet.

```bash
# Deploy gateway
docker compose up -d gateway

# Verify gateway can reach FastAPI
curl http://gateway:3000/gateway/health
curl http://gateway:3000/api/v1/queue/stats
```

### Phase 2: Parallel Testing / 并行测试

Run a small percentage of traffic through the gateway while most traffic still goes directly to FastAPI.

```nginx
# Nginx split traffic (10% to gateway)
upstream backend {
    server fastapi:8000 weight=9;
    server gateway:3000 weight=1;
}
```

Monitor for:
- Same response status codes
- Similar latency (gateway adds ~1-5ms overhead)
- No errors in gateway logs

### Phase 3: Gradual Rollover / 逐步切换

Increase gateway traffic percentage:

```nginx
# 50% to gateway
upstream backend {
    server fastapi:8000 weight=1;
    server gateway:3000 weight=1;
}
```

### Phase 4: Full Cutover / 完全切换

Route all traffic through the gateway:

```nginx
upstream backend {
    server gateway:3000;
}
```

### Phase 5: Restrict Direct Access / 限制直接访问

Optionally block external access to FastAPI:

```bash
# Only allow gateway to reach FastAPI
iptables -A INPUT -p tcp --dport 8000 -s gateway-ip -j ACCEPT
iptables -A INPUT -p tcp --dport 8000 -j DROP
```

### Rollback Plan / 回退方案

If issues arise, immediately revert Nginx configuration to point directly to FastAPI:

```nginx
upstream backend {
    server fastapi:8000;
}
```

The Python backend is unchanged, so rollback is instant.

---

## Troubleshooting / 问题排查

### Gateway Cannot Reach FastAPI / 网关无法连接 FastAPI

```bash
# Check connectivity
curl -v http://fastapi-host:8000/docs

# Check gateway logs
docker compose logs gateway | grep "proxy"

# Verify FASTAPI_URL in .env
```

### Redis Connection Failed / Redis 连接失败

```bash
# Test Redis from gateway host
redis-cli -u redis://redis-host:6379 PING

# Check gateway health
curl http://localhost:3000/gateway/health
# Should show Redis status in detailed health check
```

### Token Validation Fails / Token 验证失败

```bash
# Verify salt matches
echo $AUTH_TOKEN_SALT  # Gateway
# Compare with Python: grep -r "SALT" your-python-project/

# Test hash generation (both should produce same output)
node -e "console.log(require('crypto').createHash('sha256').update('your-token' + 'your-salt').digest('hex'))"
python3 -c "import hashlib; print(hashlib.sha256('your-tokenyour-salt'.encode()).hexdigest())"
```

### Workers Not Showing / Worker 列表为空

```bash
# Check if Workers are writing to Redis
redis-cli KEYS "worker:*"

# Check gateway's Redis key prefix
redis-cli KEYS "gateway:*"

# If Workers use a different key pattern, check Python code:
# grep -r "redis" your-python-project/ | grep "worker"
```

### Rate Limiting Too Aggressive / 限流过于激进

```bash
# Check current rate limit counters
redis-cli ZCARD "gateway:ratelimit:your-ip"

# Increase limits in .env
RATE_LIMIT_MAX_REQUESTS=500
RATE_LIMIT_WINDOW_MS=60000

# Or disable temporarily
RATE_LIMIT_ENABLED=false
```

### Cache Returning Stale Data / 缓存返回过期数据

```bash
# Clear all cached responses
redis-cli KEYS "gateway:cache:*" | xargs redis-cli DEL

# Reduce TTL
CACHE_TTL_SECONDS=10

# Or disable caching
CACHE_ENABLED=false
```
