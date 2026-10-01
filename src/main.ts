import * as dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';

import { CodeReviewOrchestrator } from './orchestrator.js';
import { ReportGenerator } from './utils/report-generator.js';

dotenv.config();

/**
 * Main entry point for the Claude Multi-Agent Code Review System
 * Usage: npm run dev -- <owner> <repo> <pr-number>
 */
async function main(): Promise<void> {
  const [owner, repo, prStr] = process.argv.slice(2);

  // Validate command line arguments
  if (!owner || !repo || !prStr) {
    console.error(
      'Usage: npm run dev -- <owner> <repo> <pr-number>'
    );
    process.exit(1);
  }

  const prNumber = Number(prStr);

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error('Error: PR number must be a positive integer.');
    process.exit(1);
  }

  // Validate authentication
  const hasAnthropicApiKey = Boolean(process.env.ANTHROPIC_API_KEY);

  const hasAwsCredentials =
    Boolean(process.env.AWS_ACCESS_KEY_ID) &&
    Boolean(process.env.AWS_SECRET_ACCESS_KEY);

  if (!hasAnthropicApiKey && !hasAwsCredentials) {
    console.error(
      'Authentication required. Configure either:\n' +
      '  1. ANTHROPIC_API_KEY for Anthropic API, or\n' +
      '  2. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY for AWS Bedrock.'
    );
    process.exit(1);
  }

  if (hasAnthropicApiKey) {
    console.log('🔐 Using Anthropic API authentication');
  } else {
    if (!process.env.AWS_REGION) {
      console.error(
        'Error: AWS_REGION is required when using AWS Bedrock authentication.'
      );
      process.exit(1);
    }

    console.log('🔐 Using AWS Bedrock authentication');
  }

  // Validate model
  const model = process.env.ANTHROPIC_MODEL;

  if (!model) {
    console.error(
      'Error: ANTHROPIC_MODEL environment variable is required.'
    );
    process.exit(1);
  }

  console.log(
    `�� Reviewing ${owner}/${repo} PR #${prNumber}...`
  );

  try {
    const orchestrator = new CodeReviewOrchestrator({
      model,
    });

    const report = await orchestrator.reviewPullRequest(
      owner,
      repo,
      prNumber
    );

    const reportGenerator = new ReportGenerator();

    const markdownReport =
      reportGenerator.generateMarkdownReport(report);

    const htmlReport =
      reportGenerator.generateHTMLReport(report);

    const jsonReport =
      reportGenerator.generateJSONReport(report);

    await mkdir('reports', { recursive: true });

    const baseName = `${owner}_${repo}_${prNumber}`;

    await Promise.all([
      writeFile(
        `reports/${baseName}.md`,
        markdownReport,
        'utf-8'
      ),
      writeFile(
        `reports/${baseName}.html`,
        htmlReport,
        'utf-8'
      ),
      writeFile(
        `reports/${baseName}.json`,
        jsonReport,
        'utf-8'
      ),
    ]);

    console.log('✅ Code review completed successfully.');
    console.log(`📄 reports/${baseName}.md`);
    console.log(`🌐 reports/${baseName}.html`);
    console.log(`📦 reports/${baseName}.json`);
  } catch (error) {
    console.error(
      '❌ Code review failed:',
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(
    '❌ Unexpected error:',
    error instanceof Error ? error.message : String(error)
  );
  process.exitCode = 1;
});
