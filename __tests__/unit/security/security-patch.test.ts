import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { validatePrBodyForMemoryReference } from '../../../services/governance/pr-memory-reference-check.js';
import {
  addToUnreleased,
  bumpPatch,
  exitCodeFor,
  insertReleaseSection,
  isOverrideEligible,
  lockedVersions,
  parseAuditReport,
  parseCliOptions,
  runSecurityPatch,
  setManifestVersion,
  summarizeAdvisory,
  unreleasedBody,
  type CommandResult,
  type CommandRunner,
  type SecurityPatchOptions
} from '../../../services/security/security-patch.js';

interface FakeAdvisory {
  id: number;
  ghsa: string;
  module: string;
  severity: string;
  patched: string;
  findings: { version: string; paths: string[]; dev: boolean }[];
}

function auditJson(advisories: FakeAdvisory[]): string {
  return JSON.stringify({
    advisories: Object.fromEntries(
      advisories.map((advisory) => [
        String(advisory.id),
        {
          findings: advisory.findings.map((finding) => ({ ...finding, optional: false, bundled: false })),
          id: advisory.id,
          title: `issue in ${advisory.module}`,
          module_name: advisory.module,
          vulnerable_versions: `<${advisory.patched}`,
          patched_versions: `>=${advisory.patched}`,
          severity: advisory.severity,
          github_advisory_id: advisory.ghsa,
          url: `https://github.com/advisories/${advisory.ghsa}`
        }
      ])
    ),
    metadata: {}
  });
}

const PROD_DIRECT: FakeAdvisory = {
  id: 101,
  ghsa: 'GHSA-aaaa-bbbb-cccc',
  module: 'left-pad',
  severity: 'critical',
  patched: '1.3.1',
  findings: [{ version: '1.3.0', paths: ['.>left-pad'], dev: false }]
};

const DEV_TRANSITIVE: FakeAdvisory = {
  id: 202,
  ghsa: 'GHSA-dddd-eeee-ffff',
  module: 'brace-expansion',
  severity: 'high',
  patched: '1.1.22',
  findings: [{ version: '1.1.11', paths: ['.>eslint>minimatch>brace-expansion'], dev: true }]
};

const DEV_DIRECT: FakeAdvisory = {
  id: 303,
  ghsa: 'GHSA-gggg-hhhh-iiii',
  module: 'vite',
  severity: 'moderate',
  patched: '8.3.9',
  findings: [{ version: '8.3.8', paths: ['.>vite'], dev: true }]
};

function lockfile(versions: Record<string, string>): string {
  const keys = Object.entries(versions).map(([name, version]) =>
    name.startsWith('@') ? `  '${name}@${version}':\n    resolution: {integrity: sha512-x}` : `  ${name}@${version}:\n    resolution: {integrity: sha512-x}`
  );
  return [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    '      left-pad:',
    '        specifier: ^1.3.0',
    '        version: 1.3.0',
    '',
    'packages:',
    '',
    ...keys,
    '',
    'snapshots:',
    '',
    '  snapshot-only@9.9.9: {}',
    ''
  ].join('\n');
}

const MANIFEST = {
  name: 'fixture',
  version: '2.4.6',
  dependencies: { 'left-pad': '^1.3.0' },
  devDependencies: { vite: '^8.3.8' }
};

const CHANGELOG_EMPTY = ['# Changelog', '', '## [Unreleased]', '', '## 2.4.6 - 2026-01-01', '', '### Fixed', '', '- a fix.', ''].join(
  '\n'
);

const CHANGELOG_PENDING = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '### Changed',
  '',
  '- **Breaking:** something.',
  '',
  '## 2.4.6 - 2026-01-01',
  '',
  '- a fix.',
  ''
].join('\n');

const MEMORY_CRLF = ['# Memory', '', '## [2026-01-01T00:00:00Z] someone | T-001', '- Status: done', '- Blockers: none', ''].join('\r\n');

interface Fixture {
  root: string;
  calls: string[];
  run: (options?: Partial<SecurityPatchOptions>) => ReturnType<typeof runSecurityPatch>;
  read: (file: string) => string;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A throwaway repository and a fake `pnpm`. `audits` are the successive `pnpm audit --json`
 * outputs; `onFix` is what each `--fix` mutates on disk; `failGate` makes one gate fail.
 */
function fixture(setup: {
  changelog?: string;
  audits: FakeAdvisory[][];
  onFix?: Partial<Record<'update' | 'override', (root: string) => void>>;
  failGate?: string;
}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'security-patch-'));
  roots.push(root);
  mkdirSync(join(root, 'docs/ai/memory'), { recursive: true });
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`);
  writeFileSync(join(root, 'pnpm-lock.yaml'), lockfile({ 'left-pad': '1.3.0', 'brace-expansion': '1.1.11', vite: '8.3.8' }));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'allowBuilds: {}\n');
  writeFileSync(join(root, 'CHANGELOG.md'), setup.changelog ?? CHANGELOG_EMPTY);
  writeFileSync(join(root, 'docs/ai/memory/AGENT_MEMORY.md'), MEMORY_CRLF);

  const calls: string[] = [];
  const audits = [...setup.audits];
  const runner: CommandRunner = (args): CommandResult => {
    const command = args.join(' ');
    calls.push(command);
    if (command === 'audit --json') {
      const next = audits.length > 1 ? audits.shift() : audits[0];
      return { status: next && next.length > 0 ? 1 : 0, stdout: auditJson(next ?? []), stderr: '' };
    }
    if (command === 'audit --fix update' || command === 'audit --fix override') {
      setup.onFix?.[command.endsWith('update') ? 'update' : 'override']?.(root);
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: setup.failGate === command ? 1 : 0, stdout: '', stderr: '' };
  };

  return {
    root,
    calls,
    read: (file) => readFileSync(join(root, file), 'utf8'),
    run: (options) =>
      runSecurityPatch(
        {
          cwd: root,
          check: false,
          verify: true,
          record: true,
          overrides: true,
          taskId: 'T-025',
          agent: 'security-patch',
          prBodyFile: 'pr-body.md',
          now: () => new Date('2026-11-22T12:34:56.789Z'),
          log: () => undefined,
          ...options
        },
        runner
      )
  };
}

/** What `pnpm audit --fix update` does to a direct dependency: new lockfile version and a raised range. */
function bumpDirect(section: 'dependencies' | 'devDependencies', name: string, version: string) {
  return (root: string) => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
    const deps = manifest[section];
    if (deps) {
      deps[name] = `^${version}`;
    }
    writeFileSync(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
    writeFileSync(join(root, 'pnpm-lock.yaml'), lock.replace(new RegExp(`  ${name}@[^:]+:`, 'u'), `  ${name}@${version}:`));
  };
}

function bumpLockOnly(name: string, version: string) {
  return (root: string) => {
    const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
    writeFileSync(join(root, 'pnpm-lock.yaml'), lock.replace(new RegExp(`  ${name}@[^:]+:`, 'u'), `  ${name}@${version}:`));
  };
}

describe('parseAuditReport', () => {
  it('reads pnpm audit --json, most severe first, and tells prod from dev', () => {
    const advisories = parseAuditReport(auditJson([DEV_DIRECT, PROD_DIRECT, DEV_TRANSITIVE]));

    expect(advisories.map((advisory) => advisory.module)).toEqual(['left-pad', 'brace-expansion', 'vite']);
    expect(advisories[0]).toMatchObject({
      id: '101',
      ghsa: 'GHSA-aaaa-bbbb-cccc',
      severity: 'critical',
      patchedVersions: '>=1.3.1'
    });
    expect(advisories.map((advisory) => summarizeAdvisory(advisory).scope)).toEqual(['prod', 'dev', 'dev']);
  });

  it('refuses output that is not an audit report', () => {
    expect(() => parseAuditReport('ERR_PNPM_AUDIT_BAD_RESPONSE')).toThrow(/no JSON report/u);
    expect(() => parseAuditReport('{"error": "registry"}')).toThrow(/advisories/u);
  });
});

describe('isOverrideEligible', () => {
  it('accepts only transitive development dependencies', () => {
    const [prodDirect, devTransitive, devDirect] = parseAuditReport(auditJson([PROD_DIRECT, DEV_TRANSITIVE, DEV_DIRECT])).sort(
      (left, right) => Number(left.id) - Number(right.id)
    );

    expect(prodDirect && isOverrideEligible(prodDirect)).toBe(false);
    expect(devTransitive && isOverrideEligible(devTransitive)).toBe(true);
    expect(devDirect && isOverrideEligible(devDirect)).toBe(false);
  });

  it('refuses a transitive copy that production also reaches', () => {
    const [mixed] = parseAuditReport(
      auditJson([
        {
          ...DEV_TRANSITIVE,
          findings: [
            { version: '1.1.11', paths: ['.>eslint>minimatch>brace-expansion'], dev: true },
            { version: '1.1.11', paths: ['.>glob>minimatch>brace-expansion'], dev: false }
          ]
        }
      ])
    );

    expect(mixed && isOverrideEligible(mixed)).toBe(false);
  });
});

describe('lockfile and manifest helpers', () => {
  it('reads resolved versions from the packages section only, scoped names included', () => {
    const versions = lockedVersions(lockfile({ '@ast-grep/cli': '0.51.3', zod: '4.6.7' }));

    expect([...(versions.get('@ast-grep/cli') ?? [])]).toEqual(['0.51.3']);
    expect([...(versions.get('zod') ?? [])]).toEqual(['4.6.7']);
    expect(versions.has('snapshot-only')).toBe(false);
    expect(versions.has('left-pad')).toBe(false);
  });

  it('bumps the patch and rewrites the version without touching the rest of package.json', () => {
    const text = `${JSON.stringify(MANIFEST, null, 2)}\n`;

    expect(bumpPatch('0.6.9')).toBe('0.6.10');
    expect(() => bumpPatch('1.0.0-rc.1')).toThrow(/MAJOR.MINOR.PATCH/u);
    expect(setManifestVersion(text, '2.4.7')).toBe(text.replace('"version": "2.4.6"', '"version": "2.4.7"'));
  });
});

describe('changelog editing', () => {
  it('reads the [Unreleased] body', () => {
    expect(unreleasedBody(CHANGELOG_EMPTY)).toBe('');
    expect(unreleasedBody(CHANGELOG_PENDING)).toBe('### Changed\n\n- **Breaking:** something.');
    expect(unreleasedBody('# Changelog\n')).toBeNull();
  });

  it('inserts a release section under an empty [Unreleased] and keeps the rest byte for byte', () => {
    const result = insertReleaseSection(CHANGELOG_EMPTY, '2.4.7', '2026-11-22', 'Security release.', ['- one.']);

    expect(result).toBe(
      [
        '# Changelog',
        '',
        '## [Unreleased]',
        '',
        '## 2.4.7 - 2026-11-22',
        '',
        'Security release.',
        '',
        '### Security',
        '',
        '- one.',
        '',
        '## 2.4.6 - 2026-01-01',
        '',
        '### Fixed',
        '',
        '- a fix.',
        ''
      ].join('\n')
    );
    expect(() => insertReleaseSection(CHANGELOG_PENDING, '2.4.7', '2026-11-22', 'x', ['- one.'])).toThrow(/not empty/u);
  });

  it('adds a Security subsection to a pending [Unreleased], or extends the one already there', () => {
    const added = addToUnreleased(CHANGELOG_PENDING, ['- one.']);

    expect(unreleasedBody(added)).toBe('### Changed\n\n- **Breaking:** something.\n\n### Security\n\n- one.');
    expect(added.endsWith('## 2.4.6 - 2026-01-01\n\n- a fix.\n')).toBe(true);

    const extended = addToUnreleased(added, ['- two.']);
    expect(unreleasedBody(extended)).toBe('### Changed\n\n- **Breaking:** something.\n\n### Security\n\n- one.\n- two.');

    const withFollowing = addToUnreleased(
      '## [Unreleased]\n\n### Security\n\n- one.\n\n### CI\n\n- ci.\n\n## 1.0.0 - 2026-01-01\n',
      ['- two.']
    );
    expect(unreleasedBody(withFollowing)).toBe('### Security\n\n- one.\n- two.\n\n### CI\n\n- ci.');
  });
});

describe('runSecurityPatch', () => {
  it('does nothing when the audit is clean', () => {
    const repo = fixture({ audits: [[]] });

    const report = repo.run();

    expect(report.status).toBe('clean');
    expect(exitCodeFor(report)).toBe(0);
    expect(repo.calls).toEqual(['audit --json']);
    expect(repo.read('docs/ai/memory/AGENT_MEMORY.md')).toBe(MEMORY_CRLF);
  });

  it('only audits in check mode', () => {
    const repo = fixture({ audits: [[PROD_DIRECT]] });

    const report = repo.run({ check: true });

    expect(report.status).toBe('vulnerable');
    expect(exitCodeFor(report)).toBe(2);
    expect(repo.calls).toEqual(['audit --json']);
  });

  it('records a lockfile-only fix without a release or a changelog line', () => {
    const repo = fixture({ audits: [[DEV_TRANSITIVE], []], onFix: { update: bumpLockOnly('brace-expansion', '1.1.22') } });

    const report = repo.run();

    expect(report).toMatchObject({
      status: 'patched',
      needsHuman: false,
      lockfileOnly: true,
      consumerImpact: false,
      release: { needed: false, version: null, blockedBy: null },
      changedFiles: ['docs/ai/memory/AGENT_MEMORY.md', 'pnpm-lock.yaml'],
      versionChanges: [{ name: 'brace-expansion', from: ['1.1.11'], to: ['1.1.22'] }],
      prTitle: 'security: brace-expansion (T-025)'
    });
    expect(exitCodeFor(report)).toBe(0);
    expect(repo.calls).toEqual([
      'audit --json',
      'audit --fix update',
      'audit --json',
      'install --frozen-lockfile',
      'lint',
      'type-check',
      'test',
      'build'
    ]);
    expect(repo.read('CHANGELOG.md')).toBe(CHANGELOG_EMPTY);

    const memory = repo.read('docs/ai/memory/AGENT_MEMORY.md');
    expect(memory.startsWith(MEMORY_CRLF)).toBe(true);
    expect(memory).toContain('\r\n## [2026-11-22T12:34:56Z] security-patch | T-025\r\n- Status: done\r\n');
    expect(memory.replaceAll('\r\n', '')).not.toContain('\n');
    expect(memory).toContain('Only the lockfile changed');

    const body = repo.read('pr-body.md');
    expect(validatePrBodyForMemoryReference(body)).toEqual({ ok: true, errors: [] });
    expect(body).toContain('2026-11-22T12:34:56Z');
  });

  it('cuts a patch release when a shipped range moves and [Unreleased] is empty', () => {
    const repo = fixture({ audits: [[PROD_DIRECT], []], onFix: { update: bumpDirect('dependencies', 'left-pad', '1.3.1') } });

    const report = repo.run();

    expect(report).toMatchObject({
      status: 'patched',
      needsHuman: false,
      lockfileOnly: false,
      consumerImpact: true,
      release: { needed: true, version: '2.4.7', blockedBy: null },
      rangeChanges: [{ section: 'dependencies', name: 'left-pad', from: '^1.3.0', to: '^1.3.1' }],
      changedFiles: ['CHANGELOG.md', 'docs/ai/memory/AGENT_MEMORY.md', 'package.json', 'pnpm-lock.yaml'],
      prTitle: 'release: v2.4.7 — security: left-pad (T-025)'
    });
    expect(JSON.parse(repo.read('package.json'))).toMatchObject({ version: '2.4.7', dependencies: { 'left-pad': '^1.3.1' } });

    const changelog = repo.read('CHANGELOG.md');
    expect(unreleasedBody(changelog)).toBe('');
    expect(changelog).toContain('## 2.4.7 - 2026-11-22\n\nSecurity release: 1 advisory fixed in the runtime dependencies');
    expect(changelog).toContain(
      '- **`left-pad` 1.3.0 → 1.3.1**: [GHSA-aaaa-bbbb-cccc](https://github.com/advisories/GHSA-aaaa-bbbb-cccc) (critical, issue in left-pad). `dependencies` now asks for `^1.3.1`'
    );
    expect(repo.read('docs/ai/memory/AGENT_MEMORY.md')).toContain('push the tag v2.4.7 on the merged commit');
  });

  it('leaves the release to a person when [Unreleased] already holds changes', () => {
    const repo = fixture({
      changelog: CHANGELOG_PENDING,
      audits: [[PROD_DIRECT], []],
      onFix: { update: bumpDirect('dependencies', 'left-pad', '1.3.1') }
    });

    const report = repo.run();

    expect(report).toMatchObject({
      status: 'patched',
      needsHuman: true,
      release: { needed: true, version: null, blockedBy: 'unreleased-changes' },
      prTitle: 'security: left-pad (T-025)'
    });
    expect(exitCodeFor(report)).toBe(2);
    expect(JSON.parse(repo.read('package.json'))).toMatchObject({ version: '2.4.6' });
    expect(unreleasedBody(repo.read('CHANGELOG.md'))).toMatch(/^### Changed\n\n- \*\*Breaking:\*\* something\.\n\n### Security\n\n- \*\*`left-pad`/u);
  });

  it('does not count a development range as shipped', () => {
    const repo = fixture({ audits: [[DEV_DIRECT], []], onFix: { update: bumpDirect('devDependencies', 'vite', '8.3.9') } });

    const report = repo.run();

    expect(report).toMatchObject({ lockfileOnly: false, consumerImpact: false, release: { needed: false } });
    expect(repo.read('CHANGELOG.md')).toBe(CHANGELOG_EMPTY);
  });

  it('hands over without recording when nothing could be fixed', () => {
    const repo = fixture({ audits: [[PROD_DIRECT]] });

    const report = repo.run();

    expect(report).toMatchObject({ status: 'unresolved', needsHuman: true, changedFiles: [], record: null });
    expect(exitCodeFor(report)).toBe(2);
    expect(repo.read('docs/ai/memory/AGENT_MEMORY.md')).toBe(MEMORY_CRLF);
    expect(repo.calls).not.toContain('lint');
  });

  it('stops at the first failing gate and records nothing', () => {
    const repo = fixture({
      audits: [[DEV_TRANSITIVE], []],
      onFix: { update: bumpLockOnly('brace-expansion', '1.1.22') },
      failGate: 'test'
    });

    const report = repo.run();

    expect(report.status).toBe('gates-failed');
    expect(report.gates.map((gate) => `${gate.command}:${String(gate.ok)}`)).toEqual([
      'pnpm install --frozen-lockfile:true',
      'pnpm lint:true',
      'pnpm type-check:true',
      'pnpm test:false'
    ]);
    expect(repo.calls).not.toContain('build');
    expect(repo.read('docs/ai/memory/AGENT_MEMORY.md')).toBe(MEMORY_CRLF);
  });

  it('adds overrides only when every advisory left is a transitive development dependency', () => {
    const eligible = fixture({
      audits: [[DEV_TRANSITIVE], [DEV_TRANSITIVE], []],
      onFix: { override: (root) => writeFileSync(join(root, 'pnpm-workspace.yaml'), 'overrides:\n  brace-expansion@<1.1.22: ^1.1.22\n') }
    });

    const report = eligible.run();

    expect(report).toMatchObject({ status: 'patched', overridesAdded: true, lockfileOnly: false });
    expect(eligible.calls.slice(0, 6)).toEqual([
      'audit --json',
      'audit --fix update',
      'audit --json',
      'audit --fix override',
      'install --no-frozen-lockfile',
      'audit --json'
    ]);

    const mixed = fixture({ audits: [[DEV_TRANSITIVE, PROD_DIRECT]] });
    expect(mixed.run().status).toBe('unresolved');
    expect(mixed.calls).not.toContain('audit --fix override');

    const disabled = fixture({ audits: [[DEV_TRANSITIVE]] });
    expect(disabled.run({ overrides: false }).status).toBe('unresolved');
    expect(disabled.calls).not.toContain('audit --fix override');
  });

  it('reports a partial fix and keeps what is still open in the record', () => {
    const repo = fixture({
      audits: [[PROD_DIRECT, DEV_DIRECT], [DEV_DIRECT]],
      onFix: { update: bumpDirect('dependencies', 'left-pad', '1.3.1') }
    });

    const report = repo.run();

    expect(report).toMatchObject({ status: 'partial', needsHuman: true });
    expect(report.advisoriesAfter.map((advisory) => advisory.ghsa)).toEqual(['GHSA-gggg-hhhh-iiii']);
    expect(repo.read('docs/ai/memory/AGENT_MEMORY.md')).toContain('- Status: in-progress');
    expect(repo.read('pr-body.md')).toContain('Still open: [GHSA-gggg-hhhh-iiii]');
  });

  it('keeps every local path out of the report', () => {
    const repo = fixture({ audits: [[PROD_DIRECT], []], onFix: { update: bumpDirect('dependencies', 'left-pad', '1.3.1') } });

    const serialized = JSON.stringify(repo.run());

    expect(serialized).not.toContain(repo.root);
    expect(serialized).not.toContain(repo.root.replaceAll('\\', '/'));
    expect(serialized).not.toContain(tmpdir());
  });

  it('refuses to record without the gates', () => {
    const repo = fixture({ audits: [[PROD_DIRECT]] });

    expect(() => repo.run({ verify: false, record: true })).toThrow(/requires the gates/u);
  });
});

describe('parseCliOptions', () => {
  it('fixes, verifies and records by default', () => {
    expect(parseCliOptions([], '/repo')).toMatchObject({
      check: false,
      verify: true,
      record: true,
      overrides: true,
      taskId: 'T-025',
      agent: 'security-patch',
      prBodyFile: null
    });
  });

  it('never records what it did not verify', () => {
    expect(parseCliOptions(['--no-verify'], '/repo')).toMatchObject({ verify: false, record: false });
    expect(parseCliOptions(['--no-record', '--task=T-031', '--pr-body=body.md'], '/repo')).toMatchObject({
      record: false,
      taskId: 'T-031',
      prBodyFile: 'body.md'
    });
  });

  it('rejects unknown options and malformed values', () => {
    expect(() => parseCliOptions(['--force'], '/repo')).toThrow(/unknown option/u);
    expect(() => parseCliOptions(['--level=high'], '/repo')).toThrow(/unknown option/u);
    expect(() => parseCliOptions(['--task=25'], '/repo')).toThrow(/T-025/u);
    expect(() => parseCliOptions(['--agent=a b'], '/repo')).toThrow(/--agent/u);
  });
});
