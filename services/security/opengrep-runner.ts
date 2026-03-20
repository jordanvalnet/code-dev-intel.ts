import { resolve } from 'node:path';
import { safeSpawnSync } from '../code-intel-mcp/src/safe-spawn.ts';
import { logger } from '../code-intel-mcp/src/logger.ts';

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
  safeSpawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding,
    allowedCommands: ['opengrep']
  });

export function setCommandRunnerForTests(runner: CommandRunner): void {
  commandRunner = runner;
}

export function resetCommandRunnerForTests(): void {
  commandRunner = (command, args, options) =>
    safeSpawnSync(command, args, {
      cwd: options.cwd,
      encoding: options.encoding,
      allowedCommands: ['opengrep']
    });
}

function resolveOpenGrepBinaryCandidates(): string[] {
  const homedir = process.env.HOME ?? process.env.USERPROFILE ?? '';
  return [
    process.env.OPENGREP_BIN,
    'opengrep',
    resolve(homedir, '.local', 'bin', 'opengrep'),
    resolve(homedir, '.opengrep', 'cli', 'latest', 'opengrep'),
    resolve(homedir, '.cargo', 'bin', 'opengrep'),
    '/usr/local/bin/opengrep'
  ].filter((value): value is string => Boolean(value));
}

function resolveOpenGrepBinary(workspaceRoot: string): string | null {
  const candidates = resolveOpenGrepBinaryCandidates();
  for (const candidate of candidates) {
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
  const candidates = resolveOpenGrepBinaryCandidates();
  const openGrepBinary = resolveOpenGrepBinary(workspaceRoot);
  if (!openGrepBinary) {
    return {
      ok: false,
      message: `OpenGrep is not available. Checked: ${candidates.join(', ')}`
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
    logger.error('security scan failed', { message: result.message });
    process.exit(1);
  }

  logger.info('security scan passed', { message: result.message });
}
