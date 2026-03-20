import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const workspaceRoot = process.cwd();
const runnerPath = resolve(workspaceRoot, 'services/indexer/src/indexer-runner.ts');

function runStep(args, label) {
  const result = spawnSync('node', ['--experimental-strip-types', runnerPath, ...args], {
    cwd: workspaceRoot,
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    throw new Error(`indexer smoke failed at ${label}: ${output || 'unknown error'}`);
  }

  const stdout = result.stdout.trim();
  if (!stdout) {
    throw new Error(`indexer smoke produced no output at ${label}`);
  }

  // Handle multi-line JSON logs from the logger
  const lines = stdout.split('\n').filter(line => line.trim());
  const lastLine = lines[lines.length - 1];

  try {
    const payload = JSON.parse(lastLine);
    // If it's a logger entry, the actual data is in the context
    if (payload.context && typeof payload.context === 'object') {
      return payload.context;
    }
    return payload;
  } catch {
    throw new Error(`indexer smoke failed to parse JSON at ${label}: ${lastLine}`);
  }
}

function main() {
  const gitDiffPayload = runStep(['--mode=git-diff', '--baseRef=HEAD'], 'git-diff');
  if (gitDiffPayload.mode !== 'git-diff' || !Array.isArray(gitDiffPayload.changedFiles)) {
    throw new Error('Invalid git-diff payload shape');
  }

  const impactedPayload = runStep(
    ['--mode=impacted', '--changed=services/indexer/src/change-detector.ts'],
    'impacted'
  );

  if (impactedPayload.mode !== 'impacted' || !Array.isArray(impactedPayload.impactedFiles)) {
    throw new Error('Invalid impacted payload shape');
  }

  if (!impactedPayload.impactedFiles.includes('services/indexer/src/change-detector.ts')) {
    throw new Error('Impacted payload should contain the changed file itself');
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        gitDiffChangedCount: gitDiffPayload.changedCount,
        impactedCount: impactedPayload.impactedCount
      },
      null,
      2
    )
  );
}

main();
