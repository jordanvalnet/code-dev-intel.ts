import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(process.cwd());
const packageJsonPath = resolve(repoRoot, 'package.json');
const packageJson = JSON.parse(readFileSync(process.env.npm_package_json ?? packageJsonPath, 'utf8'));
const publishedVersion = packageJson.version;

/** Health wait for the background server. Generous because a cold CI runner unpacking a
 * freshly installed tarball is slow to first byte, and this deadline only decides how
 * long a genuinely broken start takes to be reported. */
const DEFAULT_ENSURE_TIMEOUT_MS = 60_000;

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

/**
 * A `file:` specifier is what the CI job passes (the tarball `pnpm pack` just produced),
 * and it arrives however the calling shell spelled it: relative, backslash-separated, or
 * as a `file://` URL. It ends up inside the throwaway project's `package.json`, in a
 * different directory, so it must be absolute — and it must use forward slashes, because
 * a Windows path written into JSON as `file:D:\a\...` is read back with `\a` as an escape
 * and a lone backslash is not a valid JSON escape at all.
 */
function normalizeVersionSpecifier(rawVersion) {
  if (!rawVersion.startsWith('file:')) {
    return rawVersion;
  }

  const rawPath = rawVersion
    .slice('file:'.length)
    .replaceAll('\\', '/')
    // `file://host/path` and `file:///path` both leave leading slashes behind …
    .replace(/^\/{2,}/u, '/')
    // … and `/D:/a/pkg.tgz` is the URL spelling of a Windows absolute path.
    .replace(/^\/([A-Za-z]:\/)/u, '$1');

  const absolutePath = resolve(repoRoot, rawPath);
  return `file:${absolutePath.replaceAll('\\', '/')}`;
}

function getVersion() {
  return normalizeVersionSpecifier(readOption('version') || publishedVersion);
}

/**
 * The real spelling of a path on disk. `realpathSync.native` asks the operating system,
 * which is what turns a Windows 8.3 short name into its long form; it can fail on shapes
 * the JavaScript implementation still handles, so that one stays as the fallback.
 */
function canonicalize(pathValue) {
  try {
    return realpathSync.native(pathValue);
  } catch {
    return realpathSync(pathValue);
  }
}

function getEnsureTimeoutMs() {
  const parsed = Number.parseInt(readOption('timeout') || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ENSURE_TIMEOUT_MS;
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

/**
 * Cleanup runs in a `finally`, so anything it throws REPLACES the failure that brought us
 * here — and on Windows a `node_modules` tree the just-killed server still has open is
 * exactly the thing that throws. The smoke test's verdict must survive its own tidying up,
 * so a directory that refuses to go is reported as a warning and left to the runner.
 */
function cleanUp(serverPid, tempProject) {
  killProcess(serverPid);
  sleepSync(500);

  try {
    removeDirectoryWithRetry(tempProject);
  } catch (error) {
    console.warn(
      `warning: could not remove the temporary project at ${tempProject}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
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

function requestJson(url, body) {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `fetch(${JSON.stringify(url)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(
        JSON.stringify(body)
      )} }).then(async (response) => { const payload = await response.text(); process.stdout.write(JSON.stringify({ status: response.status, body: payload })); }).catch((error) => { console.error(error.message); process.exit(1); });`
    ],
    {
      encoding: 'utf8',
      windowsHide: true
    }
  );

  if (result.error) {
    throw new Error(`request failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`request failed: ${result.stderr?.trim() || result.stdout?.trim() || 'unknown error'}`);
  }

  const parsed = JSON.parse(result.stdout);
  return {
    status: parsed.status,
    body: JSON.parse(parsed.body)
  };
}

async function main() {
  const version = getVersion();
  const ensureTimeoutMs = getEnsureTimeoutMs();
  const port = Number.parseInt(readOption('port') || '', 10) || await getAvailablePort();
  // realpath so the root the server canonicalizes matches the one sent in the request
  // body: macOS hands out `/var/folders/...` for a `/private/var/...` directory, and a
  // Windows runner reports its TEMP directory in the 8.3 short form (a tilde-numbered
  // profile segment), which is a different string for the same directory.
  const tempProject = canonicalize(mkdtempSync(join(tmpdir(), 'code-dev-intel-release-smoke-')));
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

    writeFileSync(resolve(tempProject, 'sample.ts'), ['export interface SmokeTestShape {', '  id: string;', '  label: string;', '}', '', 'const smokeValue = 42;'].join('\n'));

    // --ignore-workspace: the temporary project sits in the OS temp directory, and a
    // pnpm workspace file anywhere above it would silently make this a workspace member.
    runCommand('pnpm', ['install', '--ignore-workspace'], { cwd: tempProject }, 'pnpm install');

    const ensureResult = runCommand(
      'pnpm',
      [
        'exec',
        'code-dev-intel',
        'ensure',
        '--workspaceRoot=.',
        `--port=${port}`,
        `--timeout=${ensureTimeoutMs}`,
        '--verbose'
      ],
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

    const searchStructResult = requestJson(`http://127.0.0.1:${port}/tools/searchStruct`, {
      workspaceRoot: tempProject,
      query: 'const smokeValue = 42;',
      options: {
        language: 'ts'
      }
    });

    if (searchStructResult.status !== 200 || searchStructResult.body.ok !== true) {
      throw new Error(`searchStruct smoke failed: ${JSON.stringify(searchStructResult.body)}`);
    }

    if (!Array.isArray(searchStructResult.body.data?.matches) || searchStructResult.body.data.matches.length === 0) {
      throw new Error(`searchStruct smoke returned no matches: ${JSON.stringify(searchStructResult.body)}`);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          platform: process.platform,
          version,
          port,
          tempProject,
          serverPid,
          ensureStdout: ensureResult.stdout.trim(),
          statusStdout: statusResult.stdout.trim(),
          searchStructMatches: searchStructResult.body.data.matches.length
        },
        null,
        2
      )
    );
  } finally {
    cleanUp(serverPid, tempProject);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
