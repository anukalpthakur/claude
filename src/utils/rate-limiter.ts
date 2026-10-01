
/**
 * Rate Limiter for API requests and token usage
 * Prevents exceeding Anthropic API rate limits
 *
 * This implements a token bucket algorithm with sliding window.
 *
 * Concepts:
 * - Tracks requests and tokens used in the last 60 seconds (sliding window)
 * - Limits concurrent requests to prevent overwhelming the API
 * - Uses token estimation to prevent exceeding token-per-minute limits
 */

export interface RateLimiterConfig {
  /** Maximum requests per minute */
  maxRequestsPerMinute: number;
  /** Maximum tokens per minute */
  maxTokensPerMinute: number;
  /** Maximum concurrent requests */
  maxConcurrent: number;
}

export const DEFAULT_RATE_LIMITS: RateLimiterConfig = {
  maxRequestsPerMinute: 50,
  maxTokensPerMinute: 100000,
  maxConcurrent: 5
};

interface RequestRecord {
  timestamp: number;
  tokens: number;
}

export class RateLimiter {
  private config: RateLimiterConfig;
  private requestHistory: RequestRecord[] = [];
  private activeRequests: number = 0;
  private waitQueue: Array<() => void> = [];

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.config = { ...DEFAULT_RATE_LIMITS, ...config };
  }

  async acquire(estimatedTokens: number = 1000): Promise<void> {
    while (true) {
      if (this.activeRequests >= this.config.maxConcurrent) {
        await this.waitForSlot();
      }

      if (this.canProceed(estimatedTokens)) {
        this.activeRequests++;

        this.requestHistory.push({
          timestamp: Date.now(),
          tokens: estimatedTokens
        });

        return;
      }

      await this.waitForRateLimit(estimatedTokens);
    }
  }

  release(actualTokens?: number): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);

    if (actualTokens !== undefined && this.requestHistory.length > 0) {
      const lastIndex = this.requestHistory.length - 1;
      const lastRequest = this.requestHistory[lastIndex];

      if (lastRequest !== undefined) {
        lastRequest.tokens = actualTokens;
      }
    }

    const next = this.waitQueue.shift();
    if (next) {
      next();
    }
  }

  getStatus(): {
    activeRequests: number;
    requestsInWindow: number;
    tokensInWindow: number;
    availableRequests: number;
    availableTokens: number;
  } {
    this.pruneOldRecords();

    const requestsInWindow = this.requestHistory.length;
    const tokensInWindow = this.requestHistory.reduce(
      (sum, request) => sum + request.tokens,
      0
    );

    return {
      activeRequests: this.activeRequests,
      requestsInWindow,
      tokensInWindow,
      availableRequests: Math.max(
        0,
        this.config.maxRequestsPerMinute - requestsInWindow
      ),
      availableTokens: Math.max(
        0,
        this.config.maxTokensPerMinute - tokensInWindow
      )
    };
  }

  canProceed(estimatedTokens: number = 1000): boolean {
    this.pruneOldRecords();

    if (this.activeRequests >= this.config.maxConcurrent) {
      return false;
    }

    const requestsInWindow = this.requestHistory.length;

    const tokensInWindow = this.requestHistory.reduce(
      (sum, request) => sum + request.tokens,
      0
    );

    return (
      requestsInWindow < this.config.maxRequestsPerMinute &&
      tokensInWindow + estimatedTokens <= this.config.maxTokensPerMinute
    );
  }

  private async waitForSlot(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  private async waitForRateLimit(
    estimatedTokens: number
  ): Promise<void> {
    while (!this.canProceed(estimatedTokens)) {
      this.pruneOldRecords();

      if (this.requestHistory.length === 0) {
        break;
      }

      const oldestRequest = this.requestHistory[0];

      if (!oldestRequest) {
        break;
      }

      const expirationTime = oldestRequest.timestamp + 60000;
      const waitTime = Math.min(
        5000,
        Math.max(100, expirationTime - Date.now() + 100)
      );

      await new Promise<void>((resolve) => {
        setTimeout(resolve, waitTime);
      });
    }
  }

  private pruneOldRecords(): void {
    const cutoff = Date.now() - 60000;

    this.requestHistory = this.requestHistory.filter(
      (request) => request.timestamp > cutoff
    );
  }
}

export function withRateLimit<T>(
  rateLimiter: RateLimiter,
  fn: () => Promise<T>,
  estimatedTokens: number = 1000
): Promise<T> {
  return new Promise(async (resolve, reject) => {
    try {
      await rateLimiter.acquire(estimatedTokens);
      const result = await fn();
      rateLimiter.release();
      resolve(result);
    } catch (error) {
      rateLimiter.release();
      reject(error);
    }
  });
}

export const globalRateLimiter = new RateLimiter();
