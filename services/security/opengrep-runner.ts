import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: unknown;
}

type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; encoding: BufferEncoding }
) => CommandResult;

let commandRunner: CommandRunner = (command, args, options) =>
  spawnSync(command, args, options) as unknown as CommandResult;

export function setCommandRunnerForTests(runner: CommandRunner): void {
  commandRunner = runner;
}

export function resetCommandRunnerForTests(): void {
  commandRunner = (command, args, options) => spawnSync(command, args, options) as unknown as CommandResult;
}

const OPEN_GREP_BINARY_CANDIDATES = [
  process.env.OPENGREP_BIN,
  'opengrep',
  join(homedir(), '.local', 'bin', 'opengrep'),
  join(homedir(), '.opengrep', 'cli', 'latest', 'opengrep'),
  join(homedir(), '.cargo', 'bin', 'opengrep'),
  '/usr/local/bin/opengrep'
].filter((value): value is string => Boolean(value));

function resolveOpenGrepBinary(workspaceRoot: string): string | null {
  for (const candidate of OPEN_GREP_BINARY_CANDIDATES) {
    const versionCheck = commandRunner(candidate, ['--version'], {
      cwd: workspaceRoot,
      encoding: 'utf8'
    });

    if (versionCheck.status === 0) {
      return candidate;
    }
  }

  return null;
}

export function runOpenGrepScan(workspaceRoot: string): { ok: boolean; message: string } {
  const openGrepBinary = resolveOpenGrepBinary(workspaceRoot);
  if (!openGrepBinary) {
    return {
      ok: false,
      message: `OpenGrep is not available. Checked: ${OPEN_GREP_BINARY_CANDIDATES.join(', ')}`
    };
  }

  const rulesFile = resolve(workspaceRoot, 'security/opengrep-rules.yml');
  const scanResult = commandRunner(
    openGrepBinary,
    ['scan', '-f', rulesFile, workspaceRoot, '--sarif-output=opengrep.sarif'],
    {
      cwd: workspaceRoot,
      encoding: 'utf8'
    }
  );

  if (scanResult.status === 0) {
    return {
      ok: true,
      message: 'OpenGrep scan completed successfully'
    };
  }

  return {
    ok: false,
    message: scanResult.stderr.trim() || 'OpenGrep scan failed'
  };
}

const isDirectExecution = (process.argv[1] ?? '').replaceAll('\\', '/').endsWith('opengrep-runner.ts');
if (isDirectExecution) {
  const result = runOpenGrepScan(process.cwd());
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }

  console.log(result.message);
}
