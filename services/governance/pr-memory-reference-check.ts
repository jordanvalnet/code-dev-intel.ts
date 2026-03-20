interface MemoryReferenceValidationResult {
  ok: boolean;
  errors: string[];
}

const memoryFilePattern = /docs\/ai\/memory\/AGENT_MEMORY\.md/;
const isoTimestampPattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/;
const taskIdPattern = /\bT-\d{3}\b/;

export function validatePrBodyForMemoryReference(prBody: string): MemoryReferenceValidationResult {
  const normalizedBody = prBody.trim();
  const errors: string[] = [];

  if (!normalizedBody) {
    return {
      ok: false,
      errors: ['PR body is empty']
    };
  }

  if (!memoryFilePattern.test(normalizedBody)) {
    errors.push('PR body must reference docs/ai/memory/AGENT_MEMORY.md');
  }

  if (!taskIdPattern.test(normalizedBody)) {
    errors.push('PR body must include a task identifier like T-010');
  }

  if (!isoTimestampPattern.test(normalizedBody)) {
    errors.push('PR body must include a memory entry timestamp in UTC ISO format (YYYY-MM-DDTHH:mm:ssZ)');
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

function runFromCli(): number {
  const prBody = process.env.PR_BODY ?? '';
  const result = validatePrBodyForMemoryReference(prBody);

  if (result.ok) {
    console.log('PR memory reference check passed');
    return 0;
  }

  console.error('PR memory reference check failed:');
  for (const error of result.errors) {
    console.error(`- ${error}`);
  }

  return 1;
}

const isDirectExecution =
  (process.argv[1] ?? '').replaceAll('\\', '/').endsWith('pr-memory-reference-check.ts');
if (isDirectExecution) {
  process.exit(runFromCli());
}
