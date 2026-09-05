import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ASSET_EXTENSIONS } from '../../../services/indexer/src/asset-modules.ts';
import {
  createImportResolver,
  resetResolutionConfigCacheForTests,
  type ImportResolver
} from '../../../services/indexer/src/import-resolver.ts';

const tempDirs: string[] = [];

function createWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'import-resolver-'));
  tempDirs.push(root);
  return root;
}

function write(root: string, relativePath: string, content: string): string {
  const absolutePath = join(root, ...relativePath.split('/'));
  mkdirSync(resolve(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
  return absolutePath;
}

function linkDirectory(target: string, linkPath: string): void {
  mkdirSync(resolve(linkPath, '..'), { recursive: true });
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * `internal:<path>` / `asset:<path>` / `external` / `unresolved:<reason>` — the whole
 * verdict in one comparable string, so a test reads as the classification it pins.
 */
function outcome(root: string, resolver: ImportResolver, from: string, specifier: string): string {
  const result = resolver.resolveModule(from, specifier);
  if (result.kind === 'internal' || result.kind === 'asset') {
    const relativePath = relative(realpathSync(root), realpathSync(result.filePath)).replaceAll('\\', '/');
    return `${result.kind}:${relativePath}`;
  }
  return result.kind === 'external' ? 'external' : `unresolved:${result.reason}`;
}

afterEach(() => {
  resetResolutionConfigCacheForTests();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('import-resolver relative and bare specifiers', () => {
  it('resolves relative imports with extension probing, index files and .js -> .ts mapping', () => {
    const root = createWorkspace();
    write(root, 'src/a.ts', '');
    write(root, 'src/lib/index.ts', '');
    write(root, 'src/view.tsx', '');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, from, './a')).toBe('internal:src/a.ts');
    expect(outcome(root, resolver, from, './a.js')).toBe('internal:src/a.ts');
    expect(outcome(root, resolver, from, './lib')).toBe('internal:src/lib/index.ts');
    expect(outcome(root, resolver, from, './view')).toBe('internal:src/view.tsx');
  });

  it('resolves the .mts/.cts/.mjs/.cjs family, including declaration files', () => {
    const root = createWorkspace();
    write(root, 'src/esm.mts', '');
    write(root, 'src/cjs.cts', '');
    write(root, 'src/plain.mjs', '');
    write(root, 'src/legacy.cjs', '');
    write(root, 'src/typings.d.mts', '');
    write(root, 'src/typings-cjs.d.cts', '');
    const from = write(root, 'src/main.mts', '');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, from, './esm.mjs')).toBe('internal:src/esm.mts');
    expect(outcome(root, resolver, from, './esm.mts')).toBe('internal:src/esm.mts');
    expect(outcome(root, resolver, from, './cjs.cjs')).toBe('internal:src/cjs.cts');
    expect(outcome(root, resolver, from, './plain.mjs')).toBe('internal:src/plain.mjs');
    expect(outcome(root, resolver, from, './legacy.cjs')).toBe('internal:src/legacy.cjs');
    expect(outcome(root, resolver, from, './typings.mjs')).toBe('internal:src/typings.d.mts');
    expect(outcome(root, resolver, from, './typings-cjs.cjs')).toBe('internal:src/typings-cjs.d.cts');
  });

  it('reports a relative specifier that resolves to nothing as unresolved, not external', () => {
    const root = createWorkspace();
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, from, './missing')).toBe('unresolved:not-found');
    expect(outcome(root, resolver, from, '../also-missing')).toBe('unresolved:not-found');
    expect(outcome(root, resolver, from, '')).toBe('unresolved:not-found');
  });

  it('treats bare packages and node builtins as external, installed or not', () => {
    const root = createWorkspace();
    const from = write(root, 'src/main.ts', '');
    write(root, 'node_modules/installed/package.json', JSON.stringify({ name: 'installed', main: 'index.js' }));
    write(root, 'node_modules/installed/index.js', 'module.exports = 1;\n');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, from, 'installed')).toBe('external');
    expect(outcome(root, resolver, from, 'never-installed')).toBe('external');
    expect(outcome(root, resolver, from, 'node:fs')).toBe('external');
    expect(outcome(root, resolver, from, 'fs')).toBe('external');
    expect(outcome(root, resolver, from, '@scope/pkg/sub')).toBe('external');
  });

  it('follows a workspace package symlinked into node_modules to its real file', () => {
    const root = createWorkspace();
    write(root, 'packages/ui-kit/package.json', JSON.stringify({ name: '@workspace/ui-kit', main: './src/index.ts' }));
    write(root, 'packages/ui-kit/src/index.ts', 'export const kit = 1;\n');
    linkDirectory(join(root, 'packages', 'ui-kit'), join(root, 'node_modules', '@workspace', 'ui-kit'));
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, from, '@workspace/ui-kit')).toBe('internal:packages/ui-kit/src/index.ts');
  });

  it('keeps a real node_modules package external even when the workspace has one symlinked in', () => {
    const root = createWorkspace();
    write(root, 'packages/ui-kit/package.json', JSON.stringify({ name: '@workspace/ui-kit', main: './src/index.ts' }));
    write(root, 'packages/ui-kit/src/index.ts', 'export const kit = 1;\n');
    linkDirectory(join(root, 'packages', 'ui-kit'), join(root, 'node_modules', '@workspace', 'ui-kit'));
    write(root, 'node_modules/vendor/package.json', JSON.stringify({ name: 'vendor', main: 'index.js' }));
    write(root, 'node_modules/vendor/index.js', 'module.exports = 1;\n');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, from, 'vendor')).toBe('external');
  });
});

describe('import-resolver tsconfig paths and baseUrl', () => {
  it('resolves paths wildcards from JSON with comments and trailing commas', () => {
    const root = createWorkspace();
    write(
      root,
      'tsconfig.json',
      [
        '{',
        '  // Next.js style aliases',
        '  "compilerOptions": {',
        '    "paths": {',
        '      "@/*": ["./src/*"],',
        '    },',
        '  },',
        '}'
      ].join('\n')
    );
    write(root, 'src/utils/format.ts', '');
    write(root, 'src/lib/index.ts', '');
    const from = write(root, 'src/app/page.tsx', '');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, from, '@/utils/format')).toBe('internal:src/utils/format.ts');
    expect(outcome(root, resolver, from, '@/lib')).toBe('internal:src/lib/index.ts');
    // An alias that matches a pattern but finds no file is a broken import, not a package.
    expect(outcome(root, resolver, from, '@/nothing/here')).toBe('unresolved:not-found');
    expect(outcome(root, resolver, from, 'react')).toBe('external');
  });

  it('supports exact mappings and tries multiple targets in order', () => {
    const root = createWorkspace();
    write(
      root,
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: { paths: { config: ['./src/config.ts'], 'shared/*': ['./missing/*', './packages/shared/*'] } }
      })
    );
    write(root, 'src/config.ts', '');
    write(root, 'packages/shared/money.ts', '');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, from, 'config')).toBe('internal:src/config.ts');
    expect(outcome(root, resolver, from, 'shared/money')).toBe('internal:packages/shared/money.ts');
    // No pattern matches `config/extra`, so it is an ordinary bare specifier.
    expect(outcome(root, resolver, from, 'config/extra')).toBe('external');
  });

  it('prefers the pattern with the longest prefix, like TypeScript does', () => {
    const root = createWorkspace();
    write(
      root,
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'], '@/domain/*': ['./domain-lib/*'] } } })
    );
    write(root, 'src/domain/entity.ts', '');
    write(root, 'domain-lib/entity.ts', '');
    write(root, 'src/app/thing.ts', '');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, from, '@/domain/entity')).toBe('internal:domain-lib/entity.ts');
    expect(outcome(root, resolver, from, '@/app/thing')).toBe('internal:src/app/thing.ts');
  });

  it('falls back to baseUrl only when no pattern matched', () => {
    const root = createWorkspace();
    write(
      root,
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./missing/*'] } } })
    );
    // A file sits exactly where a baseUrl-rooted lookup of the raw specifier would land:
    // it must not be used, because in TypeScript a matched `paths` pattern is terminal.
    write(root, '@/domain/entity.ts', '');
    write(root, 'domain/entity.ts', '');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, from, '@/domain/entity')).toBe('unresolved:not-found');
    expect(outcome(root, resolver, from, 'domain/entity')).toBe('internal:domain/entity.ts');
    expect(outcome(root, resolver, from, 'react')).toBe('external');
  });

  it('follows extends and resolves paths relative to the config that defines them', () => {
    const root = createWorkspace();
    write(root, 'config/tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['../src/*'] } } }));
    write(root, 'tsconfig.json', JSON.stringify({ extends: './config/tsconfig.base.json', compilerOptions: { strict: true } }));
    write(root, 'src/feature.ts', '');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, from, '@/feature')).toBe('internal:src/feature.ts');
  });

  it('matches TypeScript on empty wildcard captures and multi-wildcard keys', () => {
    const root = createWorkspace();
    write(
      root,
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          paths: {
            '@/*': ['./src/*'],
            'two**star': ['./src/twostar.ts'],
            'a*b*c': ['./src/multi.ts'],
            exactstar: ['./src/*']
          }
        }
      })
    );
    write(root, 'src/index.ts', '');
    write(root, 'src/twostar.ts', '');
    write(root, 'src/multi.ts', '');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, from, '@/index')).toBe('internal:src/index.ts');
    // TypeScript substitutes only a non-empty capture, so `./src/*` keeps its literal `*`.
    expect(outcome(root, resolver, from, '@/')).toBe('unresolved:not-found');
    expect(outcome(root, resolver, from, 'exactstar')).toBe('unresolved:not-found');
    // TypeScript never parses a key with two or more wildcards, so those specifiers are
    // not alias-shaped at all and stay ordinary bare packages.
    expect(outcome(root, resolver, from, 'two**star')).toBe('external');
    expect(outcome(root, resolver, from, 'a*b*c')).toBe('external');
  });

  it('resolves declaration-only modules through aliases and relative imports', () => {
    const root = createWorkspace();
    write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));
    write(root, 'src/types/only.d.ts', '');
    write(root, 'src/idx/index.d.ts', '');
    write(root, 'src/both.d.ts', '');
    write(root, 'src/both.ts', '');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, from, '@/types/only')).toBe('internal:src/types/only.d.ts');
    expect(outcome(root, resolver, from, './types/only')).toBe('internal:src/types/only.d.ts');
    expect(outcome(root, resolver, from, '@/idx')).toBe('internal:src/idx/index.d.ts');
    // A real source file still wins over a declaration sitting next to it.
    expect(outcome(root, resolver, from, '@/both')).toBe('internal:src/both.ts');
  });

  it('falls back to jsconfig.json when there is no tsconfig.json', () => {
    const root = createWorkspace();
    write(root, 'jsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '~/*': ['./app/*'] } } }));
    write(root, 'app/store.js', '');
    const from = write(root, 'app/main.js', '');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, from, '~/store')).toBe('internal:app/store.js');
  });

  it('still resolves node_modules workspace packages when the config asks for classic resolution', () => {
    const root = createWorkspace();
    // `classic` ignores node_modules entirely — a legacy emit mode that would silently
    // erase real edges, so the resolver upgrades it.
    write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { moduleResolution: 'classic' } }));
    write(root, 'packages/ui-kit/package.json', JSON.stringify({ name: '@workspace/ui-kit', main: './src/index.ts' }));
    write(root, 'packages/ui-kit/src/index.ts', 'export const kit = 1;\n');
    linkDirectory(join(root, 'packages', 'ui-kit'), join(root, 'node_modules', '@workspace', 'ui-kit'));
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, from, '@workspace/ui-kit')).toBe('internal:packages/ui-kit/src/index.ts');
  });
});

describe('import-resolver nearest config', () => {
  it('lets the nearest tsconfig win over the workspace root config', () => {
    const root = createWorkspace();
    // Both configs map `@shared/*`, at different targets: the nearer project decides.
    write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@shared/*': ['./root-shared/*'] } } }));
    write(
      root,
      'packages/catalog/tsconfig.json',
      JSON.stringify({ compilerOptions: { paths: { '@shared/*': ['./local-shared/*'], '@catalog/*': ['./src/*'] } } })
    );
    write(root, 'root-shared/money.ts', '');
    write(root, 'packages/catalog/local-shared/money.ts', '');
    write(root, 'packages/catalog/src/item.ts', '');
    const fromCatalog = write(root, 'packages/catalog/src/main.ts', '');
    const fromRoot = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, fromCatalog, '@shared/money')).toBe('internal:packages/catalog/local-shared/money.ts');
    expect(outcome(root, resolver, fromCatalog, '@catalog/item')).toBe('internal:packages/catalog/src/item.ts');
    expect(outcome(root, resolver, fromRoot, '@shared/money')).toBe('internal:root-shared/money.ts');
    // A nested-only alias means nothing outside the project that declares it.
    expect(outcome(root, resolver, fromRoot, '@catalog/item')).toBe('external');
  });

  it('falls back to the root config for an alias the nearest project does not declare', () => {
    const root = createWorkspace();
    write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@root/*': ['./src/*'] } } }));
    // A nested project that redefines `paths` without re-declaring the root aliases:
    // `tsc` fails on `@root/…` here, but the file exists and the dependency is real.
    write(
      root,
      'packages/catalog/tsconfig.json',
      JSON.stringify({ compilerOptions: { paths: { '@catalog/*': ['./src/*'] } } })
    );
    write(root, 'src/root-only.ts', '');
    const fromCatalog = write(root, 'packages/catalog/src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, fromCatalog, '@root/root-only')).toBe('internal:src/root-only.ts');
    // The fallback recovers real files only; a root alias with no file behind it is
    // still reported rather than turned into a package.
    expect(outcome(root, resolver, fromCatalog, '@root/absent')).toBe('unresolved:not-found');
    // And a specifier no config claims stays an ordinary package.
    expect(outcome(root, resolver, fromCatalog, 'some-package')).toBe('external');
  });

  it('uses a nested jsconfig.json and stops the walk at the workspace root', () => {
    const root = createWorkspace();
    write(root, 'app/jsconfig.json', JSON.stringify({ compilerOptions: { paths: { '~/*': ['./lib/*'] } } }));
    write(root, 'app/lib/store.js', '');
    const from = write(root, 'app/pages/main.js', '');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, from, '~/store')).toBe('internal:app/lib/store.js');
  });
});

describe('import-resolver workspace boundary', () => {
  it('reports a target outside the workspace root as unresolved instead of resolving it', () => {
    const outside = createWorkspace();
    write(outside, 'secret.ts', '');
    const root = createWorkspace();
    write(
      root,
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { paths: { '@outside/*': [`${outside.replaceAll('\\', '/')}/*`] } } })
    );
    const from = write(root, 'src/main.ts', '');
    // Both workspaces are siblings under the temp directory, so this escape lands on a
    // real file the workspace must still not import.
    const escape = `../../${basename(outside)}/secret`;

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, from, '@outside/secret')).toBe('unresolved:outside-workspace');
    expect(outcome(root, resolver, from, escape)).toBe('unresolved:outside-workspace');
    expect(outcome(root, resolver, from, '../../nothing-here/secret')).toBe('unresolved:not-found');
  });

  it('rejects an alias whose winning target is outside the workspace even when an inside file exists', () => {
    const outside = createWorkspace();
    write(outside, 'shared/money.ts', '');
    const root = createWorkspace();
    write(
      root,
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@shared/*': [`${outside.replaceAll('\\', '/')}/shared/*`, './src/shared/*'] }
        }
      })
    );
    write(root, 'src/shared/money.ts', '');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, from, '@shared/money')).toBe('unresolved:outside-workspace');
  });
});

describe('import-resolver config caching', () => {
  it('never throws on a config with a JSON syntax error, and recovers what tsc would', () => {
    const root = createWorkspace();
    // Unclosed brace. TypeScript parses JSON leniently, so the aliases are still read --
    // what matters is that neither the parse nor the diagnostics blow up the tool call.
    write(root, 'tsconfig.json', '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } ');
    write(root, 'src/a.ts', '');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, from, './a')).toBe('internal:src/a.ts');
    expect(outcome(root, resolver, from, '@/a')).toBe('internal:src/a.ts');
  });

  it('degrades to no aliases when the config is not usable JSON at all', () => {
    for (const content of ['not json at all', '[1, 2, 3]', '']) {
      const root = createWorkspace();
      write(root, 'tsconfig.json', content);
      write(root, 'src/a.ts', '');
      const from = write(root, 'src/main.ts', '');
      resetResolutionConfigCacheForTests();

      const resolver = createImportResolver(root);

      expect(outcome(root, resolver, from, '@/a')).toBe('external');
      expect(outcome(root, resolver, from, './a')).toBe('internal:src/a.ts');
    }
  });

  it('reloads the config when it changes', () => {
    const root = createWorkspace();
    const tsconfigPath = write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));
    write(root, 'src/a.ts', '');
    write(root, 'lib/a.ts', '');
    const from = write(root, 'src/main.ts', '');

    expect(outcome(root, createImportResolver(root), from, '@/a')).toBe('internal:src/a.ts');

    writeFileSync(tsconfigPath, JSON.stringify({ compilerOptions: { paths: { '@/*': ['./lib/*'] } } }), 'utf8');
    const future = new Date(Date.now() + 5_000);
    utimesSync(tsconfigPath, future, future);

    expect(outcome(root, createImportResolver(root), from, '@/a')).toBe('internal:lib/a.ts');
  });

  it('reloads when a config in the extends chain changes', () => {
    const root = createWorkspace();
    const basePath = write(root, 'config/tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['../src/*'] } } }));
    write(root, 'tsconfig.json', JSON.stringify({ extends: './config/tsconfig.base.json' }));
    write(root, 'src/a.ts', '');
    write(root, 'lib/a.ts', '');
    const from = write(root, 'src/main.ts', '');

    expect(outcome(root, createImportResolver(root), from, '@/a')).toBe('internal:src/a.ts');

    writeFileSync(basePath, JSON.stringify({ compilerOptions: { paths: { '@/*': ['../lib/*'] } } }), 'utf8');
    const future = new Date(Date.now() + 5_000);
    utimesSync(basePath, future, future);

    expect(outcome(root, createImportResolver(root), from, '@/a')).toBe('internal:lib/a.ts');
  });

  it('reloads a nested config when it changes', () => {
    const root = createWorkspace();
    const nestedPath = write(
      root,
      'app/tsconfig.json',
      JSON.stringify({ compilerOptions: { paths: { '#/*': ['./src/*'] } } })
    );
    write(root, 'app/src/a.ts', '');
    write(root, 'app/lib/a.ts', '');
    const from = write(root, 'app/src/main.ts', '');

    expect(outcome(root, createImportResolver(root), from, '#/a')).toBe('internal:app/src/a.ts');

    writeFileSync(nestedPath, JSON.stringify({ compilerOptions: { paths: { '#/*': ['./lib/*'] } } }), 'utf8');
    const future = new Date(Date.now() + 5_000);
    utimesSync(nestedPath, future, future);

    expect(outcome(root, createImportResolver(root), from, '#/a')).toBe('internal:app/lib/a.ts');
  });
});

describe('import-resolver asset specifiers', () => {
  it('resolves an asset specifier to the exact file it names, and to nothing else', () => {
    const root = createWorkspace();
    write(root, 'src/button.css', '.button { display: block; }');
    write(root, 'src/logo.svg', '<svg></svg>');
    write(root, 'src/regions.json', '{}');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, from, './button.css')).toBe('asset:src/button.css');
    expect(outcome(root, resolver, from, './logo.svg')).toBe('asset:src/logo.svg');
    expect(outcome(root, resolver, from, './regions.json')).toBe('asset:src/regions.json');
  });

  it('never probes for an asset: no extension guessing and no directory index', () => {
    const root = createWorkspace();
    write(root, 'src/button.css', '.button {}');
    write(root, 'src/theme/index.css', '.theme {}');
    write(root, 'src/theme/index.json', '{}');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    // A probing resolver would invent an edge here; an exact-file resolver reports the gap.
    expect(outcome(root, resolver, from, './button')).toBe('unresolved:not-found');
    // A directory is never indexed, not even for the one extension that IS appended.
    expect(outcome(root, resolver, from, './theme')).toBe('unresolved:not-found');
    expect(outcome(root, resolver, from, './theme/index.css')).toBe('asset:src/theme/index.css');
  });

  it('reports an asset import that names no file as not-found', () => {
    const root = createWorkspace();
    const from = write(root, 'src/main.ts', '');

    expect(outcome(root, createImportResolver(root), from, './missing.css')).toBe('unresolved:not-found');
    expect(outcome(root, createImportResolver(root), from, '@/missing.svg')).toBe('external');
  });

  it('resolves an asset through a path alias and through baseUrl', () => {
    const root = createWorkspace();
    write(
      root,
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@styles/*': ['src/styles/*'] } } })
    );
    write(root, 'src/styles/base.css', ':root {}');
    write(root, 'src/data/limits.yaml', 'maxItems: 20');
    const from = write(root, 'src/app/main.ts', '');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, from, '@styles/base.css')).toBe('asset:src/styles/base.css');
    expect(outcome(root, resolver, from, 'src/data/limits.yaml')).toBe('asset:src/data/limits.yaml');
    expect(outcome(root, resolver, from, '@styles/nope.css')).toBe('unresolved:not-found');
  });

  it('ignores a bundler query suffix when locating the asset file', () => {
    const root = createWorkspace();
    write(root, 'src/logo.svg', '<svg></svg>');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, from, './logo.svg?react')).toBe('asset:src/logo.svg');
    expect(outcome(root, resolver, from, './logo.svg?url')).toBe('asset:src/logo.svg');
    expect(outcome(root, resolver, from, './other.svg?react')).toBe('unresolved:not-found');
  });

  it('keeps a package stylesheet external and an asset outside the workspace unresolved', () => {
    const root = createWorkspace();
    write(root, 'node_modules/theme-lib/package.json', JSON.stringify({ name: 'theme-lib', version: '1.0.0' }));
    write(root, 'node_modules/theme-lib/theme.css', '.pkg {}');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, from, 'theme-lib/theme.css')).toBe('external');
    expect(outcome(root, resolver, from, '../outside.css')).toBe('unresolved:not-found');
  });

  it('reports an asset that resolves onto a real file outside the workspace root', () => {
    const outerRoot = createWorkspace();
    const root = join(outerRoot, 'inner');
    mkdirSync(root, { recursive: true });
    write(outerRoot, 'shared.css', '.outside {}');
    const from = write(root, 'src/main.ts', '');

    expect(outcome(root, createImportResolver(root), from, '../../shared.css')).toBe('unresolved:outside-workspace');
  });

  it('covers every extension on the documented asset list, and no code extension', () => {
    const root = createWorkspace();
    const from = write(root, 'src/main.ts', '');

    for (const extension of ASSET_EXTENSIONS) {
      write(root, `src/thing${extension}`, 'x');
    }
    write(root, 'src/thing.ts', 'export const thing = 1;');

    const resolver = createImportResolver(root);

    for (const extension of ASSET_EXTENSIONS) {
      expect(outcome(root, resolver, from, `./thing${extension}`)).toBe(`asset:src/thing${extension}`);
    }
    // A code file is resolved as code even though `./thing.ts` names an exact file too.
    expect(outcome(root, resolver, from, './thing.ts')).toBe('internal:src/thing.ts');
  });
});

describe('import-resolver specifiers that name a real file it cannot follow', () => {
  it('reports a file of a kind it does not follow as unsupported-file-type, never as missing', () => {
    const root = createWorkspace();
    write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }));
    write(root, 'src/Widget.vue', '<template />');
    write(root, 'src/Panel.svelte', '<div />');
    write(root, 'src/Page.mdx', '# page');
    write(root, 'src/engine.wasm', '\0asm');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    // The file is right there. Calling it not-found is a false statement, and on a
    // component-per-file codebase it would fill the report ahead of real breakage.
    expect(outcome(root, resolver, from, './Widget.vue')).toBe('unresolved:unsupported-file-type');
    expect(outcome(root, resolver, from, './Panel.svelte')).toBe('unresolved:unsupported-file-type');
    expect(outcome(root, resolver, from, './engine.wasm')).toBe('unresolved:unsupported-file-type');
    // Through an alias as well, since that is how such files are usually imported.
    expect(outcome(root, resolver, from, '@/Page.mdx')).toBe('unresolved:unsupported-file-type');
    // A bundler query suffix still names the same file.
    expect(outcome(root, resolver, from, './Widget.vue?raw')).toBe('unresolved:unsupported-file-type');
    // And a name that really is missing keeps saying so.
    expect(outcome(root, resolver, from, './Absent.vue')).toBe('unresolved:not-found');
  });

  it('finds a JSON file named without its extension, and guesses no other extension', () => {
    const root = createWorkspace();
    write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }));
    write(root, 'src/data/fixture.json', '{}');
    write(root, 'src/data/palette.css', ':root {}');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    // `require('./data/fixture')` finds `fixture.json` in Node and in every bundler, so
    // the dependency is real; reporting it as broken would be noise on a code hole.
    expect(outcome(root, resolver, from, './data/fixture')).toBe('asset:src/data/fixture.json');
    expect(outcome(root, resolver, from, '@/data/fixture')).toBe('asset:src/data/fixture.json');
    // Nothing else on the asset list is ever appended.
    expect(outcome(root, resolver, from, './data/palette')).toBe('unresolved:not-found');
  });
});

describe('import-resolver baseUrl-shaped specifiers', () => {
  it('reports a broken baseUrl import instead of filing it as an installed package', () => {
    const root = createWorkspace();
    write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: 'src' } }));
    write(root, 'src/billing/invoice.ts', 'export const invoice = 1;');
    write(root, 'src/catalog/item.ts', 'export const item = 1;');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(outcome(root, resolver, from, 'billing/invoice')).toBe('internal:src/billing/invoice.ts');
    // `billing/` exists, so this names a workspace file that has been deleted or moved —
    // a lost edge, not an uninstalled package, and the caller has to be told.
    expect(outcome(root, resolver, from, 'billing/deleted')).toBe('unresolved:not-found');
    expect(outcome(root, resolver, from, 'catalog/removed/deep')).toBe('unresolved:not-found');
    // Nothing under baseUrl is called `some-lib`, so this stays a package.
    expect(outcome(root, resolver, from, 'some-lib')).toBe('external');
    expect(outcome(root, resolver, from, '@scope/some-lib')).toBe('external');
    expect(outcome(root, resolver, from, 'node:fs')).toBe('external');
  });

  it('keeps bare specifiers external when the workspace declares no baseUrl', () => {
    const root = createWorkspace();
    write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: {} }));
    write(root, 'src/billing/invoice.ts', 'export const invoice = 1;');
    const from = write(root, 'src/main.ts', '');

    expect(outcome(root, createImportResolver(root), from, 'billing/deleted')).toBe('external');
  });
});
