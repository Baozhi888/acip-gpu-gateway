import { createHash, timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

export interface RequestSigningConfig {
  secret: string;
  headerName: string;
  algorithm: string;
}

const DEFAULT_CONFIG: RequestSigningConfig = {
  secret: '',
  headerName: 'X-Gateway-Signature',
  algorithm: 'sha256',
};

/**
 * Request signing middleware.
 * Signs outgoing proxied requests and verifies incoming signed requests.
 * Used for gateway-to-backend authentication when multiple gateways share a secret.
 */
export function createRequestSigningMiddleware(config: Partial<RequestSigningConfig> = {}) {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };

  if (!finalConfig.secret) {
    // No secret configured — skip signing
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  return (req: Request, _res: Response, next: NextFunction) => {
    // Sign the request
    const payload = `${req.method}:${req.originalUrl}:${Date.now()}`;
    const signature = createHash(finalConfig.algorithm)
      .update(`${payload}:${finalConfig.secret}`)
      .digest('hex');

    req.headers[finalConfig.headerName.toLowerCase()] = signature;
    next();
  };
}

/**
 * Verify a request signature.
 * Returns true if the signature matches the expected value.
 */
export function verifySignature(
  method: string,
  url: string,
  timestamp: number,
  signature: string,
  secret: string,
  algorithm = 'sha256'
): boolean {
  const payload = `${method}:${url}:${timestamp}`;
  const expected = createHash(algorithm)
    .update(`${payload}:${secret}`)
    .digest('hex');

  // Use timing-safe comparison to prevent timing attacks
  const sigBuf = Buffer.from(signature, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');

  if (sigBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(sigBuf, expectedBuf);
}
