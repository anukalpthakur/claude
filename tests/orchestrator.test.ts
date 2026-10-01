import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}));

import { CodeReviewOrchestrator } from '../src/orchestrator.js';
import { ReviewReportSchema } from '../src/types/report-types.js';
import { withRetry, withTimeout } from '../src/utils/error-handler.js';
import { ErrorCodes } from '../src/utils/error-handler.js';
import { RateLimiter } from '../src/utils/rate-limiter.js';

async function* mockQueryMessages(...messages: unknown[]) {
  for (const message of messages) {
    yield message;
  }
}

const validReport = {
  pullRequest: {
    owner: 'octocat',
    repo: 'Hello-World',
    number: 1,
  },
  fileReviews: [
    {
      file: 'src/example.ts',
      codeQuality: {
        file: 'src/example.ts',
        issues: [],
        overallScore: 100,
        summary: 'No issues found.',
      },
      testCoverage: {
        file: 'src/example.ts',
        hasTests: true,
        testFiles: ['tests/example.test.ts'],
        untestedPaths: [],
        coverageEstimate: 100,
        summary: 'Covered by tests.',
      },
      refactorings: {
        file: 'src/example.ts',
        suggestions: [],
        summary: 'No refactoring required.',
      },
    },
  ],
  summary: {
    totalFiles: 1,
    overallScore: 100,
    criticalIssues: 0,
    highPriorityTests: 0,
    refactoringOpportunities: 0,
  },
  recommendations: [],
  metadata: {
    analyzedAt: new Date().toISOString(),
    duration: 1,
    agentVersions: {},
  },
};

describe('CodeReviewOrchestrator', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  describe('Configuration', () => {
    it('initializes with default options', () => {
      const orchestrator = new CodeReviewOrchestrator();

      expect(orchestrator).toBeDefined();
    });

    it('uses a custom model configuration when provided', async () => {
      queryMock.mockReturnValue(
        mockQueryMessages({
          type: 'result',
          subtype: 'success',
          structured_output: validReport,
        })
      );

      const orchestrator = new CodeReviewOrchestrator({
        model: 'custom-test-model',
      });

      await orchestrator.reviewPullRequest('octocat', 'Hello-World', 1);

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.any(String),
          options: expect.objectContaining({
            model: 'custom-test-model',
          }),
        })
      );
    });

    it('rejects invalid pull request information', async () => {
      const orchestrator = new CodeReviewOrchestrator();

      await expect(
        orchestrator.reviewPullRequest('', 'Hello-World', 1)
      ).rejects.toThrow('Invalid pull request information.');

      expect(queryMock).not.toHaveBeenCalled();
    });

    it('configures the multi-agent review workflow and aggregates a valid report', async () => {
      queryMock.mockReturnValue(
        mockQueryMessages({
          type: 'result',
          subtype: 'success',
          structured_output: validReport,
        })
      );

      const orchestrator = new CodeReviewOrchestrator();

      const result = await orchestrator.reviewPullRequest(
        'octocat',
        'Hello-World',
        1
      );

      expect(queryMock).toHaveBeenCalledTimes(1);

      const [queryInput] = queryMock.mock.calls[0];

      expect(queryInput.options.agents).toEqual(
        expect.objectContaining({
          codeQualityAnalyzer: expect.any(Object),
          testCoverageAnalyzer: expect.any(Object),
          refactoringSuggester: expect.any(Object),
        })
      );

      expect(queryInput.options.allowedTools).toEqual(
        expect.arrayContaining([
          'Task',
          'mcp__github__pull_request_read',
          'mcp__github__get_file_contents',
          'Skill',
        ])
      );

      expect(queryInput.options.outputFormat).toEqual(
        expect.objectContaining({
          type: 'json_schema',
        })
      );

      expect(result.pullRequest).toEqual({
        owner: 'octocat',
        repo: 'Hello-World',
        number: 1,
      });

      expect(result.fileReviews).toHaveLength(1);
      expect(ReviewReportSchema.parse(result)).toEqual(result);
    });

    it('throws when the Claude SDK returns a failed result', async () => {
      queryMock.mockReturnValue(
        mockQueryMessages({
          type: 'result',
          subtype: 'error_max_turns',
        })
      );

      const orchestrator = new CodeReviewOrchestrator();

      await expect(
        orchestrator.reviewPullRequest('octocat', 'Hello-World', 1)
      ).rejects.toThrow('Code review failed: error_max_turns');
    });
  });
});

describe('ReviewReportSchema', () => {
  it('accepts a valid ReviewReport object', () => {
    const result = ReviewReportSchema.safeParse(validReport);

    expect(result.success).toBe(true);
  });

  it('rejects an invalid ReviewReport object', () => {
    const invalidReport = {
      ...validReport,
      pullRequest: {},
    };

    const result = ReviewReportSchema.safeParse(invalidReport);

    expect(result.success).toBe(false);
  });

  it('rejects an overall score outside the valid range', () => {
    const invalidReport = {
      ...validReport,
      fileReviews: [
        {
          ...validReport.fileReviews[0],
          codeQuality: {
            ...validReport.fileReviews[0].codeQuality,
            overallScore: 101,
          },
        },
      ],
    };

    const result = ReviewReportSchema.safeParse(invalidReport);

    expect(result.success).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns successfully when the operation succeeds', async () => {
    const result = await withRetry(
      async () => 'success',
      3,
      1
    );

    expect(result).toBe('success');
  });

  it('retries after a transient failure and eventually succeeds', async () => {
    let attempts = 0;

    const result = await withRetry(
      async () => {
        attempts += 1;

        if (attempts < 2) {
          throw new Error('temporary failure');
        }

        return 'recovered';
      },
      3,
      1
    );

    expect(result).toBe('recovered');
    expect(attempts).toBe(2);
  });

  it('throws RETRY_EXHAUSTED when all attempts fail', async () => {
    let attempts = 0;

    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new Error('permanent failure');
        },
        2,
        1
      )
    ).rejects.toMatchObject({
      code: ErrorCodes.RETRY_EXHAUSTED,
    });

    expect(attempts).toBe(2);
  });
});

describe('withTimeout', () => {
  it('returns when the operation completes before the timeout', async () => {
    const result = await withTimeout(
      async () => 'completed',
      100
    );

    expect(result).toBe('completed');
  });

  it('rejects when the operation exceeds the timeout', async () => {
    await expect(
      withTimeout(
        () =>
          new Promise<string>((resolve) => {
            setTimeout(() => resolve('too late'), 50);
          }),
        5,
        'Test operation timed out'
      )
    ).rejects.toMatchObject({
      code: ErrorCodes.AGENT_TIMEOUT,
      message: 'Test operation timed out',
    });
  });
});

describe('RateLimiter', () => {
  it('allows a request within the configured limits', async () => {
    const limiter = new RateLimiter({
      maxRequestsPerMinute: 2,
      maxTokensPerMinute: 100,
      maxConcurrent: 1,
    });

    expect(limiter.canProceed(10)).toBe(true);

    await limiter.acquire(10);

    const status = limiter.getStatus();

    expect(status.activeRequests).toBe(1);
    expect(status.requestsInWindow).toBe(1);
    expect(status.tokensInWindow).toBe(10);

    limiter.release();

    expect(limiter.getStatus().activeRequests).toBe(0);
  });

  it('blocks new requests when the concurrent limit is reached', async () => {
    const limiter = new RateLimiter({
      maxRequestsPerMinute: 10,
      maxTokensPerMinute: 1000,
      maxConcurrent: 1,
    });

    await limiter.acquire(10);

    expect(limiter.canProceed(10)).toBe(false);

    limiter.release();

    expect(limiter.canProceed(10)).toBe(true);
  });

  it('tracks the configured request and token limits', async () => {
    const limiter = new RateLimiter({
      maxRequestsPerMinute: 1,
      maxTokensPerMinute: 20,
      maxConcurrent: 2,
    });

    await limiter.acquire(20);

    expect(limiter.canProceed(1)).toBe(false);

    const status = limiter.getStatus();

    expect(status.requestsInWindow).toBe(1);
    expect(status.tokensInWindow).toBe(20);

    limiter.release();
  });
});

describe('Integration (manual)', () => {
  // Manual integration test:
  // Set ANTHROPIC_API_KEY and GITHUB_TOKEN before running this test.
  // The test intentionally remains skipped during automated runs because
  // it makes real Claude and GitHub API calls.
  it.skip('reviews a real public pull request', async () => {
    const orchestrator = new CodeReviewOrchestrator();

    const report = await orchestrator.reviewPullRequest(
      'octocat',
      'Hello-World',
      1
    );

    expect(ReviewReportSchema.parse(report)).toEqual(report);
  });
});
