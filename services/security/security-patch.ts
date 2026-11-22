/**
 * `pnpm security:patch`: find the known vulnerabilities in the installed dependency tree,
 * fix what can be fixed without a judgement call, prove the repository still works, and
 * record the change the way this repository requires (memory entry, changelog, version).
 *
 * The JSON report it prints on stdout holds package names, versions, advisory identifiers,
 * advisory URLs and repository-relative file names only, so it can be posted as it is.
 * Command output goes to stderr and never into the report.
 *
 * Contract and exit codes: docs/releasing.md.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical';

const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'moderate', 'low', 'info'];

export interface AdvisoryFinding {
  version: string;
  paths: string[];
  dev: boolean;
}

export interface Advisory {
  /** The registry's advisory id. Unique per (GHSA, affected range), unlike the GHSA id. */
  id: string;
  ghsa: string;
  module: string;
  severity: Severity;
  title: string;
  url: string;
  vulnerableVersions: string;
  patchedVersions: string;
  findings: AdvisoryFinding[];
}

export interface AdvisorySummary {
  id: string;
  ghsa: string;
  module: string;
  severity: Severity;
  title: string;
  url: string;
  vulnerableVersions: string;
  patchedVersions: string;
  /** `prod` as soon as one installed copy is reachable from `dependencies` or `optionalDependencies`. */
  scope: 'prod' | 'dev';
}

export interface RangeChange {
  section: string;
  name: string;
  from: string | null;
  to: string | null;
}

export interface VersionChange {
  name: string;
  from: string[];
  to: string[];
}

export interface GateResult {
  command: string;
  ok: boolean;
  durationMs: number;
}

export type SecurityPatchStatus =
  | 'clean'
  | 'vulnerable'
  | 'patched'
  | 'partial'
  | 'unresolved'
  | 'gates-failed';

export interface SecurityPatchReport {
  status: SecurityPatchStatus;
  /** True when a person has to act before this is finished: see docs/releasing.md. */
  needsHuman: boolean;
  advisoriesBefore: AdvisorySummary[];
  advisoriesAfter: AdvisorySummary[];
  fixed: AdvisorySummary[];
  versionChanges: VersionChange[];
  rangeChanges: RangeChange[];
  overridesAdded: boolean;
  changedFiles: string[];
  /** Among the dependency files, only `pnpm-lock.yaml` changed. */
  lockfileOnly: boolean;
  /** A range a consumer installs from (`dependencies`, `optionalDependencies`, `peerDependencies`) changed. */
  consumerImpact: boolean;
  release: { needed: boolean; version: string | null; blockedBy: 'unreleased-changes' | null };
  gates: GateResult[];
  record: { taskId: string; timestamp: string; memoryFile: string } | null;
  commitMessage: string | null;
  prTitle: string | null;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: unknown;
}

/** Runs `pnpm <args>` in `cwd`. `capture: false` streams the output to stderr instead. */
export type CommandRunner = (args: readonly string[], options: { cwd: string; capture: boolean }) => CommandResult;

export interface SecurityPatchOptions {
  cwd: string;
  check: boolean;
  verify: boolean;
  record: boolean;
  overrides: boolean;
  taskId: string;
  agent: string;
  prBodyFile: string | null;
  now: () => Date;
  log: (line: string) => void;
}

export const MEMORY_FILE = 'docs/ai/memory/AGENT_MEMORY.md';
export const DEFAULT_TASK_ID = 'T-025';
export const DEFAULT_AGENT = 'security-patch';

const DEPENDENCY_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'] as const;
const SHIPPED_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;
const MANIFEST_SECTIONS = [...SHIPPED_SECTIONS, 'devDependencies'] as const;

const GATES: readonly (readonly string[])[] = [
  ['install', '--frozen-lockfile'],
  ['lint'],
  ['type-check'],
  ['test'],
  ['build']
];

/* ------------------------------------------------------------------------------------ */
/* Audit report                                                                          */
/* ------------------------------------------------------------------------------------ */

function asString(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function asSeverity(value: unknown): Severity {
  return SEVERITY_ORDER.includes(value as Severity) ? (value as Severity) : 'info';
}

function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

/** Parses `pnpm audit --json`. Throws when the output is not an audit report at all. */
export function parseAuditReport(output: string): Advisory[] {
  const start = output.indexOf('{');
  if (start === -1) {
    throw new Error('pnpm audit printed no JSON report');
  }

  const parsed: unknown = JSON.parse(output.slice(start));
  if (!parsed || typeof parsed !== 'object' || !('advisories' in parsed)) {
    throw new Error('pnpm audit printed JSON without an `advisories` field');
  }

  const advisories = parsed.advisories;
  if (!advisories || typeof advisories !== 'object') {
    throw new Error('pnpm audit printed an `advisories` field that is not an object');
  }

  return Object.entries(advisories as Record<string, unknown>)
    .map(([key, raw]): Advisory => {
      const value = (raw ?? {}) as Record<string, unknown>;
      const findings = Array.isArray(value.findings) ? (value.findings as unknown[]) : [];
      return {
        id: asString(value.id) || key,
        ghsa: asString(value.github_advisory_id),
        module: asString(value.module_name),
        severity: asSeverity(value.severity),
        title: asString(value.title),
        url: asString(value.url),
        vulnerableVersions: asString(value.vulnerable_versions),
        patchedVersions: asString(value.patched_versions),
        findings: findings.map((rawFinding) => {
          const finding = (rawFinding ?? {}) as Record<string, unknown>;
          return {
            version: asString(finding.version),
            paths: Array.isArray(finding.paths) ? finding.paths.map(asString) : [],
            dev: finding.dev === true
          };
        })
      };
    })
    .sort(
      (left, right) =>
        severityRank(left.severity) - severityRank(right.severity) ||
        left.module.localeCompare(right.module) ||
        left.id.localeCompare(right.id)
    );
}

export function summarizeAdvisory(advisory: Advisory): AdvisorySummary {
  return {
    id: advisory.id,
    ghsa: advisory.ghsa,
    module: advisory.module,
    severity: advisory.severity,
    title: advisory.title,
    url: advisory.url,
    vulnerableVersions: advisory.vulnerableVersions,
    patchedVersions: advisory.patchedVersions,
    scope: advisory.findings.some((finding) => !finding.dev) ? 'prod' : 'dev'
  };
}

/**
 * An override is only ever a fix for THIS repository's own install: it does not travel with
 * the published package. So it is applied only where nothing else is at stake - every copy
 * is a development dependency, and every copy is transitive (`.>parent>module`, never
 * `.>module`), because a direct dependency is fixed by its range, not by an override.
 */
export function isOverrideEligible(advisory: Advisory): boolean {
  return (
    advisory.findings.length > 0 &&
    advisory.findings.every(
      (finding) =>
        finding.dev && finding.paths.length > 0 && finding.paths.every((path) => path.split('>').length >= 3)
    )
  );
}

export function countBySeverity(advisories: readonly { severity: Severity }[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
  for (const advisory of advisories) {
    counts[advisory.severity] += 1;
  }
  return counts;
}

/* ------------------------------------------------------------------------------------ */
/* Manifest and lockfile                                                                 */
/* ------------------------------------------------------------------------------------ */

type Manifest = Record<string, unknown>;

function sectionOf(manifest: Manifest, section: string): Record<string, string> {
  const value = manifest[section];
  return value && typeof value === 'object' ? (value as Record<string, string>) : {};
}

export function diffManifestRanges(before: Manifest, after: Manifest): RangeChange[] {
  const changes: RangeChange[] = [];
  for (const section of MANIFEST_SECTIONS) {
    const left = sectionOf(before, section);
    const right = sectionOf(after, section);
    const names = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const name of names) {
      const from = left[name] ?? null;
      const to = right[name] ?? null;
      if (from !== to) {
        changes.push({ section, name, from, to });
      }
    }
  }
  return changes;
}

export function hasConsumerImpact(changes: readonly RangeChange[]): boolean {
  return changes.some((change) => (SHIPPED_SECTIONS as readonly string[]).includes(change.section));
}

/** Every resolved version per package name, read from the `packages:` section of a v9 lockfile. */
export function lockedVersions(lockfile: string): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>();
  let inPackages = false;
  for (const line of lockfile.split(/\r?\n/u)) {
    if (/^\S/u.test(line)) {
      inPackages = line.startsWith('packages:');
      continue;
    }
    if (!inPackages) {
      continue;
    }
    const match = /^ {2}'?((?:@[^@/\s']+\/)?[^@\s']+)@([^(\s':]+)/u.exec(line);
    if (match?.[1] && match[2]) {
      const set = versions.get(match[1]) ?? new Set<string>();
      set.add(match[2]);
      versions.set(match[1], set);
    }
  }
  return versions;
}

export function versionChangesFor(modules: readonly string[], lockBefore: string, lockAfter: string): VersionChange[] {
  const before = lockedVersions(lockBefore);
  const after = lockedVersions(lockAfter);
  return [...new Set(modules)].sort().map((name) => ({
    name,
    from: [...(before.get(name) ?? [])].sort(),
    to: [...(after.get(name) ?? [])].sort()
  }));
}

export function bumpPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) {
    throw new Error(`cannot bump a version that is not plain MAJOR.MINOR.PATCH: ${version}`);
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/** Rewrites the top-level `"version"` in place, so the rest of the file keeps its formatting. */
export function setManifestVersion(manifestText: string, version: string): string {
  const pattern = /^(\s*"version"\s*:\s*")[^"]*(")/mu;
  if (!pattern.test(manifestText)) {
    throw new Error('package.json has no "version" field');
  }
  return manifestText.replace(pattern, `$1${version}$2`);
}

/* ------------------------------------------------------------------------------------ */
/* Changelog                                                                             */
/* ------------------------------------------------------------------------------------ */

const UNRELEASED_HEADING = /^## \[Unreleased\].*$/mu;

function unreleasedBounds(changelog: string): { bodyStart: number; bodyEnd: number } | null {
  const heading = UNRELEASED_HEADING.exec(changelog);
  if (!heading) {
    return null;
  }
  const bodyStart = heading.index + heading[0].length;
  const next = /^## /mu.exec(changelog.slice(bodyStart));
  return { bodyStart, bodyEnd: next ? bodyStart + next.index : changelog.length };
}

/** The text under `## [Unreleased]`, trimmed; `null` when the heading is missing. */
export function unreleasedBody(changelog: string): string | null {
  const bounds = unreleasedBounds(changelog);
  return bounds ? changelog.slice(bounds.bodyStart, bounds.bodyEnd).trim() : null;
}

/** Adds a `## <version> - <date>` section right below an EMPTY `## [Unreleased]`. */
export function insertReleaseSection(
  changelog: string,
  version: string,
  date: string,
  intro: string,
  securityLines: readonly string[]
): string {
  const bounds = unreleasedBounds(changelog);
  if (!bounds) {
    throw new Error('CHANGELOG.md has no "## [Unreleased]" heading');
  }
  if (changelog.slice(bounds.bodyStart, bounds.bodyEnd).trim() !== '') {
    throw new Error('"## [Unreleased]" is not empty: a person has to version those changes');
  }
  const section = [`## ${version} - ${date}`, '', intro, '', '### Security', '', ...securityLines].join('\n');
  const head = changelog.slice(0, bounds.bodyStart).trimEnd();
  const tail = changelog.slice(bounds.bodyEnd);
  return `${head}\n\n${section}\n\n${tail}`.replace(/\n*$/u, '\n');
}

/** Appends lines to the `### Security` subsection of `## [Unreleased]`, creating it if needed. */
export function addToUnreleased(changelog: string, securityLines: readonly string[]): string {
  const bounds = unreleasedBounds(changelog);
  if (!bounds) {
    throw new Error('CHANGELOG.md has no "## [Unreleased]" heading');
  }
  const body = changelog.slice(bounds.bodyStart, bounds.bodyEnd);
  const lines = securityLines.join('\n');
  const security = /^### Security[ \t]*$/mu.exec(body);
  let newBody: string;
  if (security) {
    const afterHeading = security.index + security[0].length;
    const next = /^#{2,3} /mu.exec(body.slice(afterHeading));
    const end = next ? afterHeading + next.index : body.length;
    const rest = body.slice(end).trim();
    newBody = `${body.slice(0, end).trimEnd()}\n${lines}${rest ? `\n\n${rest}` : ''}`;
  } else {
    newBody = `${body.trimEnd()}\n\n### Security\n\n${lines}`;
  }
  const head = changelog.slice(0, bounds.bodyStart);
  const tail = changelog.slice(bounds.bodyEnd);
  return `${head}${newBody}\n\n${tail}`.replace(/\n*$/u, '\n');
}

/* ------------------------------------------------------------------------------------ */
/* Records                                                                               */
/* ------------------------------------------------------------------------------------ */

export interface MemoryEntry {
  timestamp: string;
  agent: string;
  taskId: string;
  status: 'done' | 'in-progress';
  summary: string;
  decisions: string;
  files: readonly string[];
  evidence: string;
  risks: string;
  next: string;
  blockers: string;
}

export function formatMemoryEntry(entry: MemoryEntry): string {
  return [
    `## [${entry.timestamp}] ${entry.agent} | ${entry.taskId}`,
    `- Status: ${entry.status}`,
    `- Summary: ${entry.summary}`,
    `- Decisions: ${entry.decisions}`,
    `- Files: ${entry.files.join(', ')}`,
    `- Evidence: ${entry.evidence}`,
    `- Risks: ${entry.risks}`,
    `- Next: ${entry.next}`,
    `- Blockers: ${entry.blockers}`
  ].join('\n');
}

export function utcTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function formatCounts(counts: Record<Severity, number>): string {
  return SEVERITY_ORDER.filter((severity) => counts[severity] > 0)
    .map((severity) => `${counts[severity]} ${severity}`)
    .join(', ') || 'none';
}

function listModules(advisories: readonly AdvisorySummary[]): string {
  const modules = [...new Set(advisories.map((advisory) => advisory.module))].sort();
  if (modules.length <= 3) {
    return modules.join(', ');
  }
  return `${modules.slice(0, 3).join(', ')} and ${modules.length - 3} more`;
}

function formatVersions(change: VersionChange | undefined): string {
  if (!change) {
    return '';
  }
  const from = change.from.filter((version) => !change.to.includes(version));
  const to = change.to.filter((version) => !change.from.includes(version));
  return from.length || to.length ? ` ${from.join(', ') || '-'} → ${to.join(', ') || '-'}` : '';
}

/** One changelog line per fixed module that a consumer installs. */
export function changelogLines(
  fixed: readonly AdvisorySummary[],
  versionChanges: readonly VersionChange[],
  rangeChanges: readonly RangeChange[]
): string[] {
  const byModule = new Map<string, AdvisorySummary[]>();
  for (const advisory of fixed.filter((item) => item.scope === 'prod')) {
    byModule.set(advisory.module, [...(byModule.get(advisory.module) ?? []), advisory]);
  }
  const shippedRanges = rangeChanges.filter((change) =>
    (SHIPPED_SECTIONS as readonly string[]).includes(change.section)
  );
  const advisoryLines = [...byModule.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([module, advisories]) => {
      const versions = formatVersions(versionChanges.find((change) => change.name === module));
      const range = shippedRanges.find((change) => change.name === module);
      const rangeText = range?.to
        ? ` \`${range.section}\` now asks for \`${range.to}\`, so an install can no longer resolve an affected version.`
        : '';
      const refs = advisories
        .map((advisory) => `[${advisory.ghsa || advisory.id}](${advisory.url}) (${advisory.severity}, ${advisory.title})`)
        .join('; ');
      return `- **\`${module}\`${versions}**: ${refs}.${rangeText}`;
    });
  // A shipped range can only move here because of an advisory, but the changelog must
  // account for every one of them whatever the reason.
  const rangeLines = shippedRanges
    .filter((change) => !byModule.has(change.name))
    .map((change) => `- \`${change.name}\` in \`${change.section}\`: \`${change.from ?? '-'}\` → \`${change.to ?? '-'}\`.`);
  return [...advisoryLines, ...rangeLines];
}

/* ------------------------------------------------------------------------------------ */
/* Commands                                                                              */
/* ------------------------------------------------------------------------------------ */

/**
 * Every argument this module passes is a fixed token. They are still checked, because on
 * Windows they go through `cmd.exe`, where `<`, `>`, `&`, `|` and quotes mean something.
 */
const SAFE_ARGUMENT = /^[\w@./:=-]+$/u;

export const defaultCommandRunner: CommandRunner = (args, { cwd, capture }) => {
  for (const arg of args) {
    if (!SAFE_ARGUMENT.test(arg)) {
      throw new Error(`refusing to pass an unexpected argument to pnpm: ${arg}`);
    }
  }
  const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm';
  const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', ['pnpm', ...args].join(' ')] : [...args];
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 30 * 60 * 1000,
    windowsHide: true,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 2, 2]
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error';
}

function runOrThrow(runner: CommandRunner, args: readonly string[], cwd: string): CommandResult {
  const result = runner(args, { cwd, capture: true });
  if (result.error || result.status !== 0) {
    const reason = result.error ? describeError(result.error) : result.stderr.trim();
    throw new Error(`pnpm ${args.join(' ')} failed (exit ${String(result.status)}): ${reason}`);
  }
  return result;
}

function audit(runner: CommandRunner, cwd: string): Advisory[] {
  // `pnpm audit` exits 1 when it finds something; only an unreadable report is an error.
  const result = runner(['audit', '--json'], { cwd, capture: true });
  if (result.error) {
    throw new Error(`pnpm audit could not run: ${describeError(result.error)}`);
  }
  try {
    return parseAuditReport(result.stdout);
  } catch (error) {
    throw new Error(
      `pnpm audit (exit ${String(result.status)}) gave no usable report: ${describeError(error)} ${result.stderr.trim()}`,
      { cause: error }
    );
  }
}

/* ------------------------------------------------------------------------------------ */
/* Run                                                                                   */
/* ------------------------------------------------------------------------------------ */

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** Writes `text` (LF) with the line endings the file already uses. */
function writeKeepingEol(path: string, text: string): void {
  const current = readIfExists(path);
  const eol = current?.includes('\r\n') ? '\r\n' : '\n';
  writeFileSync(path, text.replace(/\r?\n/gu, eol));
}

function toLf(text: string): string {
  return text.replace(/\r\n/gu, '\n');
}

function emptyReport(before: Advisory[]): SecurityPatchReport {
  return {
    status: 'clean',
    needsHuman: false,
    advisoriesBefore: before.map(summarizeAdvisory),
    advisoriesAfter: before.map(summarizeAdvisory),
    fixed: [],
    versionChanges: [],
    rangeChanges: [],
    overridesAdded: false,
    changedFiles: [],
    lockfileOnly: false,
    consumerImpact: false,
    release: { needed: false, version: null, blockedBy: null },
    gates: [],
    record: null,
    commitMessage: null,
    prTitle: null
  };
}

export function exitCodeFor(report: SecurityPatchReport): number {
  return (report.status === 'clean' || report.status === 'patched') && !report.needsHuman ? 0 : 2;
}

export function runSecurityPatch(
  options: SecurityPatchOptions,
  runner: CommandRunner = defaultCommandRunner
): SecurityPatchReport {
  const { cwd, log } = options;
  if (options.record && !options.verify) {
    throw new Error('recording a change requires the gates: drop --no-verify, or add --no-record');
  }
  const path = (file: string): string => resolve(cwd, file);
  const snapshot = new Map(DEPENDENCY_FILES.map((file) => [file, readIfExists(path(file))]));
  if (snapshot.get('package.json') === null) {
    throw new Error('no package.json in the current directory');
  }

  log('auditing the installed dependency tree');
  const before = audit(runner, cwd);
  const report = emptyReport(before);
  if (before.length === 0) {
    return report;
  }
  if (options.check) {
    return { ...report, status: 'vulnerable' };
  }

  // 1. Re-resolve within the declared ranges. pnpm also raises the range of each affected
  //    DIRECT dependency to the version it picked, which is what keeps a consumer from
  //    resolving the vulnerable version again.
  log(`${plural(before.length, 'advisory', 'advisories')}: pnpm audit --fix update`);
  runOrThrow(runner, ['audit', '--fix', 'update'], cwd);
  let after = audit(runner, cwd);

  // 2. Overrides, only when every advisory left is a transitive development dependency.
  //    pnpm cannot apply them selectively (`--fix` refuses `--ignore`), so one advisory that
  //    is not eligible leaves all of them to a person.
  let overridesAdded = false;
  if (options.overrides && after.length > 0 && after.every(isOverrideEligible)) {
    log(`${after.length} advisories left, all transitive development dependencies: pnpm audit --fix override`);
    runOrThrow(runner, ['audit', '--fix', 'override'], cwd);
    // The overrides only reach the lockfile through an install, and `CI=true` makes a bare
    // `pnpm install` frozen.
    runOrThrow(runner, ['install', '--no-frozen-lockfile'], cwd);
    overridesAdded = true;
    after = audit(runner, cwd);
  }

  const afterIds = new Set(after.map((advisory) => advisory.id));
  const fixed = before.filter((advisory) => !afterIds.has(advisory.id)).map(summarizeAdvisory);
  const dependencyFilesChanged = DEPENDENCY_FILES.filter((file) => snapshot.get(file) !== readIfExists(path(file)));
  const manifestBefore = JSON.parse(snapshot.get('package.json') ?? '{}') as Manifest;
  const manifestAfter = JSON.parse(readFileSync(path('package.json'), 'utf8')) as Manifest;
  const rangeChanges = diffManifestRanges(manifestBefore, manifestAfter);
  const consumerImpact = hasConsumerImpact(rangeChanges);
  const versionChanges = versionChangesFor(
    fixed.map((advisory) => advisory.module),
    snapshot.get('pnpm-lock.yaml') ?? '',
    readIfExists(path('pnpm-lock.yaml')) ?? ''
  );

  Object.assign(report, {
    advisoriesAfter: after.map(summarizeAdvisory),
    fixed,
    versionChanges,
    rangeChanges,
    overridesAdded,
    changedFiles: [...dependencyFilesChanged],
    lockfileOnly: dependencyFilesChanged.length === 1 && dependencyFilesChanged[0] === 'pnpm-lock.yaml',
    consumerImpact
  });

  if (dependencyFilesChanged.length === 0 || fixed.length === 0) {
    return { ...report, status: 'unresolved', needsHuman: true };
  }

  if (options.verify) {
    for (const gate of GATES) {
      const command = `pnpm ${gate.join(' ')}`;
      log(`gate: ${command}`);
      const startedAt = Date.now();
      const result = runner(gate, { cwd, capture: false });
      const ok = !result.error && result.status === 0;
      report.gates.push({ command, ok, durationMs: Date.now() - startedAt });
      if (!ok) {
        return { ...report, status: 'gates-failed', needsHuman: true };
      }
    }
  }

  const status: SecurityPatchStatus = after.length > 0 ? 'partial' : 'patched';
  const changelogPath = path('CHANGELOG.md');
  const changelog = toLf(readIfExists(changelogPath) ?? '');
  if (consumerImpact && unreleasedBody(changelog) === null) {
    throw new Error('CHANGELOG.md has no "## [Unreleased]" heading to record a shipped change under');
  }
  const blocked = consumerImpact && unreleasedBody(changelog) !== '';
  const currentVersion = asString(manifestAfter.version);
  const releaseVersion = consumerImpact && !blocked ? bumpPatch(currentVersion) : null;
  report.status = status;
  report.release = {
    needed: consumerImpact,
    version: releaseVersion,
    blockedBy: blocked ? 'unreleased-changes' : null
  };
  report.needsHuman = after.length > 0 || blocked;

  const modules = listModules(fixed);
  report.prTitle = releaseVersion
    ? `release: v${releaseVersion} — security: ${modules} (${options.taskId})`
    : `security: ${modules} (${options.taskId})`;
  report.commitMessage = report.prTitle;

  if (!options.record) {
    return report;
  }

  // The changelog describes the package, so it only hears about what a consumer installs.
  const lines = changelogLines(fixed, versionChanges, rangeChanges);
  if (consumerImpact) {
    if (releaseVersion) {
      const date = utcTimestamp(options.now()).slice(0, 10);
      const intro = `Security release: ${plural(fixed.filter((item) => item.scope === 'prod').length, 'advisory', 'advisories')} fixed in the runtime dependencies (details under Security). No change to the tools or their output.`;
      writeKeepingEol(changelogPath, insertReleaseSection(changelog, releaseVersion, date, intro, lines));
      const manifestText = readFileSync(path('package.json'), 'utf8');
      writeFileSync(path('package.json'), setManifestVersion(manifestText, releaseVersion));
    } else {
      writeKeepingEol(changelogPath, addToUnreleased(changelog, lines));
    }
    report.changedFiles.push('CHANGELOG.md');
  }
  if (releaseVersion && !report.changedFiles.includes('package.json')) {
    report.changedFiles.push('package.json');
  }

  const timestamp = utcTimestamp(options.now());
  report.changedFiles.push(MEMORY_FILE);
  report.changedFiles = [...new Set(report.changedFiles)].sort();
  report.record = { taskId: options.taskId, timestamp, memoryFile: MEMORY_FILE };

  const memoryPath = path(MEMORY_FILE);
  const memory = readIfExists(memoryPath) ?? '';
  const eol = memory.includes('\r\n') ? '\r\n' : '\n';
  const entry = formatMemoryEntry(buildMemoryEntry(report, options, timestamp, before, after, currentVersion));
  const separator = memory === '' ? '' : memory.endsWith('\n') ? eol : `${eol}${eol}`;
  appendFileSync(memoryPath, `${separator}${entry}${eol}`.replace(/\r?\n/gu, eol));

  if (options.prBodyFile) {
    writeFileSync(resolve(cwd, options.prBodyFile), formatPrBody(report, before, after));
  }
  return report;
}

function scopeSentence(report: SecurityPatchReport): string {
  if (report.release.version) {
    return `A range a consumer installs from changed, so this ships as v${report.release.version}.`;
  }
  if (report.release.blockedBy) {
    return 'A range a consumer installs from changed, and `[Unreleased]` already holds changes a person has to version, so this waits for the next release.';
  }
  if (report.lockfileOnly) {
    return 'Only the lockfile changed: nothing a consumer installs is affected, and no release is needed.';
  }
  return 'Nothing a consumer installs changed, so no release is needed.';
}

function buildMemoryEntry(
  report: SecurityPatchReport,
  options: SecurityPatchOptions,
  timestamp: string,
  before: Advisory[],
  after: Advisory[],
  versionBefore: string
): MemoryEntry {
  const decisions = [
    '(1) `pnpm audit --fix update` re-resolved the lockfile within the declared ranges and raised the range of each affected direct dependency to the version it picked.'
  ];
  if (report.overridesAdded) {
    decisions.push(
      '(2) Every advisory left was in a transitive development dependency, so `pnpm audit --fix override` added overrides to `pnpm-workspace.yaml`. They only affect this repository\'s own install, and each one is to be removed once its parent package allows a patched version.'
    );
  }
  if (report.release.version) {
    decisions.push(
      `(${decisions.length + 1}) Released as a patch, v${versionBefore} to v${report.release.version}: \`[Unreleased]\` was empty, so the release holds this fix and nothing else.`
    );
  }
  const remaining = after.map(summarizeAdvisory);
  const gates = report.gates.map((gate) => `\`${gate.command}\``).join(', ');
  return {
    timestamp,
    agent: options.agent,
    taskId: options.taskId,
    status: remaining.length > 0 ? 'in-progress' : 'done',
    summary: `Automated security patch. \`pnpm audit\` reported ${plural(before.length, 'advisory', 'advisories')} (${formatCounts(countBySeverity(before))}); ${report.fixed.length} fixed, in ${listModules(report.fixed)}. ${scopeSentence(report)}`,
    decisions: decisions.join(' '),
    files: report.changedFiles,
    evidence: `\`pnpm audit\` before: ${formatCounts(countBySeverity(before))}; after: ${formatCounts(countBySeverity(after))}. Gates on ${process.platform}, Node ${process.version.replace(/^v/u, '')}: ${gates} all exit 0.`,
    risks:
      remaining.length > 0
        ? `Still open: ${remaining.map((advisory) => `${advisory.ghsa || advisory.id} in \`${advisory.module}\` (${advisory.severity}, ${advisory.scope})`).join('; ')}. They need a range change outside the current major, a replaced dependency or an upstream fix.`
        : 'none known',
    next: report.release.version
      ? `Merge, then push the tag v${report.release.version} on the merged commit: \`publish.yml\` publishes it once a maintainer approves.`
      : report.release.blockedBy
        ? 'Merge, then cut the next release by hand: `[Unreleased]` holds changes that decide its version.'
        : 'Merge. No release is needed.',
    blockers: remaining.length > 0 ? 'the advisories listed under Risks need a person' : 'none'
  };
}

export function formatPrBody(report: SecurityPatchReport, before: Advisory[], after: Advisory[]): string {
  const rows = report.fixed.map(
    (advisory) =>
      `| [${advisory.ghsa || advisory.id}](${advisory.url}) | \`${advisory.module}\` | ${advisory.severity} | ${advisory.scope} |`
  );
  const remaining = after.map(summarizeAdvisory);
  const record = report.record;
  return [
    '## Task',
    `- Task-ID: ${record?.taskId ?? DEFAULT_TASK_ID}`,
    '- Goal: fix the known vulnerabilities `pnpm audit` reports, with `pnpm security:patch`',
    '',
    '## Changes summary',
    '',
    '| Advisory | Package | Severity | Scope |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    scopeSentence(report),
    ...(report.overridesAdded ? ['', 'Overrides were added to `pnpm-workspace.yaml` for transitive development dependencies.'] : []),
    '',
    '## Validation',
    `- \`pnpm audit\` before: ${formatCounts(countBySeverity(before))}; after: ${formatCounts(countBySeverity(after))}`,
    `- Gates: ${report.gates.map((gate) => `\`${gate.command}\` ${gate.ok ? 'passed' : 'failed'}`).join(', ') || 'not run'}`,
    '',
    '## Shared memory',
    `- [x] Entry appended to \`${MEMORY_FILE}\``,
    `- Entry timestamp (UTC ISO): ${record?.timestamp ?? ''}`,
    `- Task-ID reference: ${record?.taskId ?? DEFAULT_TASK_ID}`,
    `- Memory file reference: ${MEMORY_FILE}`,
    '',
    '## Risks',
    remaining.length > 0
      ? remaining.map((advisory) => `- Still open: [${advisory.ghsa || advisory.id}](${advisory.url}) in \`${advisory.module}\` (${advisory.severity}, ${advisory.scope})`).join('\n')
      : '- none known',
    ''
  ].join('\n');
}

/* ------------------------------------------------------------------------------------ */
/* CLI                                                                                   */
/* ------------------------------------------------------------------------------------ */

export function parseCliOptions(argv: readonly string[], cwd: string): SecurityPatchOptions {
  const flags = new Set(argv.filter((arg) => !arg.includes('=')));
  const value = (name: string): string | undefined =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const knownFlags = new Set(['--check', '--no-verify', '--no-record', '--no-overrides']);
  const knownValues = new Set(['--task', '--agent', '--pr-body']);
  for (const arg of argv) {
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (!(arg.includes('=') ? knownValues : knownFlags).has(name)) {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  const taskId = value('task') ?? DEFAULT_TASK_ID;
  if (!/^T-\d{3}$/u.test(taskId)) {
    throw new Error(`--task must look like T-025, got: ${taskId}`);
  }
  const agent = value('agent') ?? DEFAULT_AGENT;
  if (!/^[\w.-]{1,64}$/u.test(agent)) {
    throw new Error('--agent must be letters, digits, dots, dashes or underscores');
  }
  const verify = !flags.has('--no-verify');
  return {
    cwd,
    check: flags.has('--check'),
    verify,
    record: verify && !flags.has('--no-record'),
    overrides: !flags.has('--no-overrides'),
    taskId,
    agent,
    prBodyFile: value('pr-body') ?? null,
    now: () => new Date(),
    log: (line) => process.stderr.write(`[security:patch] ${line}\n`)
  };
}

const isDirectExecution = (process.argv[1] ?? '').replaceAll('\\', '/').endsWith('security-patch.ts');
if (isDirectExecution) {
  try {
    const report = runSecurityPatch(parseCliOptions(process.argv.slice(2), process.cwd()));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(exitCodeFor(report));
  } catch (error) {
    process.stderr.write(`[security:patch] error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
