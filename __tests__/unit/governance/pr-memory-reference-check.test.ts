import { describe, expect, it } from 'vitest';

import { validatePrBodyForMemoryReference } from '../../../services/governance/pr-memory-reference-check.js';

describe('validatePrBodyForMemoryReference', () => {
  it('passes when body includes memory file, task id, and UTC timestamp', () => {
    const body = [
      '## Task',
      '- Task-ID: T-010',
      '## Shared memory',
      '- Entry: docs/ai/memory/AGENT_MEMORY.md',
      '- Timestamp: 2026-02-22T23:40:00Z'
    ].join('\n');

    const result = validatePrBodyForMemoryReference(body);

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when memory reference is missing', () => {
    const body = ['- Task-ID: T-010', '- Timestamp: 2026-02-22T23:40:00Z'].join('\n');

    const result = validatePrBodyForMemoryReference(body);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('PR body must reference docs/ai/memory/AGENT_MEMORY.md');
  });

  it('fails when task id and timestamp are missing', () => {
    const body = '- Entry: docs/ai/memory/AGENT_MEMORY.md';

    const result = validatePrBodyForMemoryReference(body);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('PR body must include a task identifier like T-010');
    expect(result.errors).toContain(
      'PR body must include a memory entry timestamp in UTC ISO format (YYYY-MM-DDTHH:mm:ssZ)'
    );
  });
});
