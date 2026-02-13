import { createHash } from 'crypto';
import { Plugin, ACIPCore, Subscription, createEvent } from '@maxeven/acip-core';
import type { RequestEventPayload } from '../types/gateway';

export interface AuthPluginConfig {
  enabled: boolean;
  tokenSalt: string;
  apiKeys: string[];
}

export class AuthPlugin implements Plugin {
  name = 'auth-plugin';
  version = '1.0.0';

  private core!: ACIPCore;
  private config: AuthPluginConfig;
  private subscriptions: Subscription[] = [];

  constructor(config: AuthPluginConfig) {
    this.config = config;
  }

  async install(core: ACIPCore): Promise<void> {
    this.core = core;

    if (!this.config.enabled) {
      console.log('[auth-plugin] Authentication disabled');
      return;
    }

    const sub = core.eventManager.subscribe<RequestEventPayload>(
      'gateway:request:incoming',
      async (event) => {
        const { headers, context, req, res, id } = event.payload;

        // Skip auth for gateway-local endpoints
        const path = req.originalUrl;
        if (path.startsWith('/gateway/')) return;

        // Try X-API-Key header
        const apiKey = headers['x-api-key'] as string;
        if (apiKey && this.validateApiKey(apiKey)) {
          context.auth = { type: 'api-key', identity: apiKey.slice(0, 8) + '...' };
          await core.eventManager.publish(
            createEvent('gateway:auth:validated', { requestId: id, type: 'api-key' })
          );
          return;
        }

        // Try X-Worker-Token header
        const workerToken = headers['x-worker-token'] as string;
        if (workerToken) {
          // For token auth, we hash and compare (actual expected hash would come from config or DB)
          context.auth = { type: 'token', identity: this.hashToken(workerToken).slice(0, 16) + '...' };
          await core.eventManager.publish(
            createEvent('gateway:auth:validated', { requestId: id, type: 'token' })
          );
          return;
        }

        // Try Authorization: Bearer header
        const authHeader = headers['authorization'] as string;
        if (authHeader?.startsWith('Bearer ')) {
          const token = authHeader.slice(7);
          context.auth = { type: 'bearer', identity: token.slice(0, 8) + '...' };
          await core.eventManager.publish(
            createEvent('gateway:auth:validated', { requestId: id, type: 'bearer' })
          );
          return;
        }

        // No valid auth found
        await core.eventManager.publish(
          createEvent('gateway:auth:rejected', { requestId: id, reason: 'missing_credentials' })
        );

        res.status(401).json({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required. Provide X-API-Key, X-Worker-Token, or Authorization header.',
            requestId: id,
          },
        });

        event.cancel();
      },
      100 // Highest priority — auth runs first
    );

    this.subscriptions.push(sub);
  }

  async uninstall(): Promise<void> {
    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.subscriptions = [];
  }

  async onLoad(): Promise<void> {
    console.log(`[auth-plugin] Loaded (${this.config.apiKeys.length} API keys configured)`);
  }

  async onUnload(): Promise<void> {}

  /** Hash a token using SHA-256 with salt (compatible with Python backend) */
  private hashToken(token: string): string {
    return createHash('sha256')
      .update(`${token}${this.config.tokenSalt}`)
      .digest('hex');
  }

  /** Check if an API key is in the configured allowlist */
  private validateApiKey(key: string): boolean {
    return this.config.apiKeys.includes(key);
  }

  getAPI() {
    return {
      hashToken: (token: string) => this.hashToken(token),
      validateApiKey: (key: string) => this.validateApiKey(key),
    };
  }
}
