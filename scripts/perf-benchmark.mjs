import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
  return sortedValues[index];
}

function runCommand(command, args, cwd) {
  const startedAt = performance.now();
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env
  });
  const endedAt = performance.now();

  if (result.error) {
    throw new Error(`Command spawn failed: ${command} ${args.join(' ')}\n${String(result.error)}`);
  }

  if (result.status !== 0) {
    throw new Error(
      `Command failed: ${command} ${args.join(' ')}\n${result.stdout || ''}\n${result.stderr || ''}`
    );
  }

  return {
    durationMs: Math.round(endedAt - startedAt),
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function measureScenario({ label, command, args, cwd, iterations }) {
  const durations = [];

  for (let i = 0; i < iterations; i += 1) {
    const outcome = runCommand(command, args, cwd);
    durations.push(outcome.durationMs);
  }

  const sorted = [...durations].sort((left, right) => left - right);
  return {
    label,
    iterations,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted.at(-1) ?? 0
  };
}

function getRssMb() {
  return Math.round(process.memoryUsage().rss / (1024 * 1024));
}

function assertBudget({ report, budget }) {
  const failures = [];

  if (report.scenarios.mcpSelfTest.p95Ms > budget.mcpSelfTestMsP95) {
    failures.push(
      `mcpSelfTest p95 ${report.scenarios.mcpSelfTest.p95Ms}ms exceeds budget ${budget.mcpSelfTestMsP95}ms`
    );
  }

  if (report.scenarios.indexerSmoke.p95Ms > budget.indexerSmokeMsP95) {
    failures.push(
      `indexerSmoke p95 ${report.scenarios.indexerSmoke.p95Ms}ms exceeds budget ${budget.indexerSmokeMsP95}ms`
    );
  }

  if (report.scenarios.indexerImpacted.p95Ms > budget.indexerImpactedMsP95) {
    failures.push(
      `indexerImpacted p95 ${report.scenarios.indexerImpacted.p95Ms}ms exceeds budget ${budget.indexerImpactedMsP95}ms`
    );
  }

  if (report.peakRssMb > budget.peakRssMb) {
    failures.push(`peak RSS ${report.peakRssMb}MB exceeds budget ${budget.peakRssMb}MB`);
  }

  return failures;
}

function main() {
  const cwd = process.cwd();
  const mode = process.argv.includes('--mode=ci') ? 'ci' : 'local';
  const iterationsArg = process.argv.find((arg) => arg.startsWith('--iterations='));
  const iterations = Number(iterationsArg?.split('=')[1] ?? (mode === 'ci' ? '2' : '3'));

  const budgetPath = resolve(cwd, 'perf/budget.json');
  const budgetConfig = JSON.parse(readFileSync(budgetPath, 'utf8'));
  const budget = budgetConfig.targets[mode];
  if (!budget) {
    throw new Error(`Unknown budget mode: ${mode}`);
  }

  const scenarios = {
    mcpSelfTest: measureScenario({
      label: 'mcp:self-test',
      command: process.execPath,
      args: ['--experimental-strip-types', './services/code-intel-mcp/src/server.ts', '--self-test'],
      cwd,
      iterations
    }),
    indexerSmoke: measureScenario({
      label: 'indexer:smoke',
      command: process.execPath,
      args: ['./scripts/indexer-smoke.mjs'],
      cwd,
      iterations
    }),
    indexerImpacted: measureScenario({
      label: 'indexer:impacted',
      command: process.execPath,
      args: [
        '--experimental-strip-types',
        './services/indexer/src/indexer-runner.ts',
        '--mode=impacted',
        '--changed=services/indexer/src/change-detector.ts'
      ],
      cwd,
      iterations
    })
  };

  const peakRssMb = getRssMb();

  const report = {
    mode,
    iterations,
    peakRssMb,
    scenarios
  };

  const failures = assertBudget({ report, budget });

  console.log(JSON.stringify({ ok: failures.length === 0, report, failures }, null, 2));

  if (failures.length > 0) {
    process.exit(1);
  }
}

main();
