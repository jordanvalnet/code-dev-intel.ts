import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(process.cwd());
const packageJsonPath = resolve(repoRoot, 'package.json');
const packageJson = JSON.parse(readFileSync(process.env.npm_package_json ?? packageJsonPath, 'utf8'));
const publishedVersion = packageJson.version;

function quoteWindowsArgument(value) {
  if (!/[\s"]/u.test(value)) {
    return value;
  }

  const escapedValue = value.replaceAll('"', String.raw`\"`);
  return '"' + escapedValue + '"';
}

function createCommandSpec(command, args) {
  if (process.platform !== 'win32') {
    return {
      command,
      args
    };
  }

  const commandLine = [command, ...args].map((value) => quoteWindowsArgument(value)).join(' ');
  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', commandLine]
  };
}

function readOption(name) {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length).trim() : undefined;
}

function getVersion() {
  return readOption('version') || publishedVersion;
}

async function getAvailablePort() {
  const server = createServer();

  await new Promise((resolveListen, rejectListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen());
    server.once('error', rejectListen);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('unable to allocate free localhost port');
  }

  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error);
        return;
      }
      resolveClose();
    });
  });

  return address.port;
}

function runCommand(command, args, options, label) {
  const commandSpec = createCommandSpec(command, args);
  const result = spawnSync(commandSpec.command, commandSpec.args, {
    ...options,
    encoding: 'utf8',
    windowsHide: true
  });

  if (result.error) {
    throw new Error(`${label} failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const output = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join('\n');
    throw new Error(`${label} failed: ${output || 'unknown error'}`);
  }

  return result;
}

function killProcess(pid) {
  if (!pid) {
    return;
  }

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    });
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already stopped.
  }
}

function sleepSync(milliseconds) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < milliseconds) {
    // Busy wait is acceptable here because cleanup retries are short-lived.
  }
}

function removeDirectoryWithRetry(directoryPath) {
  let lastError;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(directoryPath, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      sleepSync(250);
    }
  }

  if (lastError) {
    throw lastError;
  }
}

function extractPid(stdout) {
  const match = /pid\s+(\d+)/i.exec(stdout);
  if (!match?.[1]) {
    throw new Error(`unable to extract background pid from output: ${stdout}`);
  }

  const pid = Number(match[1]);
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error(`invalid pid extracted from output: ${stdout}`);
  }

  return pid;
}

async function main() {
  const version = getVersion();
  const port = Number.parseInt(readOption('port') || '', 10) || await getAvailablePort();
  const tempProject = mkdtempSync(join(tmpdir(), 'code-dev-intel-release-smoke-'));
  let serverPid;

  try {
    writeFileSync(
      resolve(tempProject, 'package.json'),
      JSON.stringify(
        {
          name: 'code-dev-intel-release-smoke',
          private: true,
          packageManager: packageJson.packageManager,
          dependencies: {
            'code-dev-intel.ts': version
          }
        },
        null,
        2
      )
    );

    runCommand('pnpm', ['install'], { cwd: tempProject }, 'pnpm install');

    const ensureResult = runCommand(
      'pnpm',
      ['exec', 'code-dev-intel', 'ensure', '--workspaceRoot=.', `--port=${port}`, '--timeout=15000', '--verbose'],
      { cwd: tempProject },
      'ensure'
    );

    serverPid = extractPid(ensureResult.stdout);

    const statusResult = runCommand(
      'pnpm',
      ['exec', 'code-dev-intel', 'status', `--port=${port}`],
      { cwd: tempProject },
      'status'
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          version,
          port,
          tempProject,
          serverPid,
          ensureStdout: ensureResult.stdout.trim(),
          statusStdout: statusResult.stdout.trim()
        },
        null,
        2
      )
    );
  } finally {
    killProcess(serverPid);
    sleepSync(500);
    removeDirectoryWithRetry(tempProject);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}