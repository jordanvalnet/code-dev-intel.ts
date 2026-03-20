import { afterEach, describe, expect, it } from 'vitest';
import { logger, resetLoggerSinkForTests, setLoggerSinkForTests } from '../../../services/code-intel-mcp/src/logger.ts';

afterEach(() => {
  resetLoggerSinkForTests();
  delete process.env.CODE_INTEL_LOG_LEVEL;
});

describe('logger', () => {
  it('redacts sensitive values in context', () => {
    const lines: string[] = [];
    setLoggerSinkForTests((line) => {
      lines.push(line);
    });

    logger.info('test', {
      authorization: 'Bearer secret-token',
      apiKey: 'api_key=my-secret',
      email: 'user@example.com'
    });

    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0] ?? '{}') as { context?: Record<string, string> };
    expect(entry.context?.authorization).toContain('[REDACTED]');
    expect(entry.context?.apiKey).toContain('[REDACTED]');
    expect(entry.context?.email).toContain('[REDACTED]');
  });

  it('filters debug logs when level is info', () => {
    process.env.CODE_INTEL_LOG_LEVEL = 'info';
    const lines: string[] = [];
    setLoggerSinkForTests((line) => {
      lines.push(line);
    });

    logger.debug('hidden debug line');
    logger.info('visible info line');

    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0] ?? '{}') as { level: string; message: string };
    expect(entry.level).toBe('info');
    expect(entry.message).toBe('visible info line');
  });
});
