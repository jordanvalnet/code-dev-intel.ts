import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createImportResolver,
  loadPathAliasConfig,
  resetPathAliasCacheForTests
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

function rel(root: string, absolutePath: string | null): string | null {
  return absolutePath ? absolutePath.slice(root.length + 1).replaceAll('\\', '/') : null;
}

afterEach(() => {
  resetPathAliasCacheForTests();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('import-resolver', () => {
  it('resolves relative imports with extension probing, index files and .js -> .ts mapping', () => {
    const root = createWorkspace();
    write(root, 'src/a.ts', '');
    write(root, 'src/lib/index.ts', '');
    write(root, 'src/view.tsx', '');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(rel(root, resolver.resolve(from, './a'))).toBe('src/a.ts');
    expect(rel(root, resolver.resolve(from, './a.js'))).toBe('src/a.ts');
    expect(rel(root, resolver.resolve(from, './lib'))).toBe('src/lib/index.ts');
    expect(rel(root, resolver.resolve(from, './view'))).toBe('src/view.tsx');
    expect(resolver.resolve(from, './missing')).toBeNull();
  });

  it('returns null for bare package specifiers and node builtins when no config exists', () => {
    const root = createWorkspace();
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(resolver.aliasConfig).toBeNull();
    expect(resolver.resolve(from, 'react')).toBeNull();
    expect(resolver.resolve(from, 'node:fs')).toBeNull();
    expect(resolver.resolve(from, '@scope/pkg/sub')).toBeNull();
  });

  it('resolves tsconfig paths wildcards (JSON with comments and trailing commas)', () => {
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

    expect(resolver.aliasConfig?.paths).toEqual({ '@/*': ['./src/*'] });
    expect(rel(root, resolver.resolve(from, '@/utils/format'))).toBe('src/utils/format.ts');
    expect(rel(root, resolver.resolve(from, '@/lib'))).toBe('src/lib/index.ts');
    expect(resolver.resolve(from, '@/nothing/here')).toBeNull();
    // A bare package is still external even when aliases exist.
    expect(resolver.resolve(from, 'react')).toBeNull();
  });

  it('supports exact (non-wildcard) mappings and tries multiple targets in order', () => {
    const root = createWorkspace();
    write(
      root,
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          paths: {
            config: ['./src/config.ts'],
            'shared/*': ['./missing/*', './packages/shared/*']
          }
        }
      })
    );
    write(root, 'src/config.ts', '');
    write(root, 'packages/shared/money.ts', '');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(rel(root, resolver.resolve(from, 'config'))).toBe('src/config.ts');
    expect(rel(root, resolver.resolve(from, 'shared/money'))).toBe('packages/shared/money.ts');
    expect(resolver.resolve(from, 'config/extra')).toBeNull();
  });

  it('prefers the pattern with the longest prefix, like TypeScript does', () => {
    const root = createWorkspace();
    write(
      root,
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          paths: {
            '@/*': ['./src/*'],
            '@/domain/*': ['./domain-lib/*']
          }
        }
      })
    );
    write(root, 'src/domain/entity.ts', '');
    write(root, 'domain-lib/entity.ts', '');
    write(root, 'src/app/thing.ts', '');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(rel(root, resolver.resolve(from, '@/domain/entity'))).toBe('domain-lib/entity.ts');
    expect(rel(root, resolver.resolve(from, '@/app/thing'))).toBe('src/app/thing.ts');
  });

  it('falls back to baseUrl for non-relative specifiers when paths do not match', () => {
    const root = createWorkspace();
    write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: './src' } }));
    write(root, 'src/utils/format.ts', '');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(rel(root, resolver.resolve(from, 'utils/format'))).toBe('src/utils/format.ts');
    expect(resolver.resolve(from, 'react')).toBeNull();
  });

  it('follows extends and resolves paths relative to the config that defines them', () => {
    const root = createWorkspace();
    write(root, 'config/tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['../src/*'] } } }));
    write(root, 'tsconfig.json', JSON.stringify({ extends: './config/tsconfig.base.json', compilerOptions: { strict: true } }));
    write(root, 'src/feature.ts', '');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(rel(root, resolver.resolve(from, '@/feature'))).toBe('src/feature.ts');
  });

  it('returns null when the matched alias has no existing target, without falling back to baseUrl', () => {
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

    expect(resolver.resolve(from, '@/domain/entity')).toBeNull();
    // The same specifier without the alias prefix still resolves through baseUrl.
    expect(rel(root, resolver.resolve(from, 'domain/entity'))).toBe('domain/entity.ts');
  });

  it('handles targets without ./, .d.ts targets, extension-less directories and query suffixes', () => {
    const root = createWorkspace();
    write(
      root,
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          paths: {
            '@bare/*': ['src/*'],
            '@types/*': ['./types/*.d.ts'],
            '@dir/*': ['./src/*']
          }
        }
      })
    );
    write(root, 'src/thing.ts', '');
    write(root, 'types/legacy.d.ts', '');
    mkdirSync(join(root, 'src', 'empty-dir'), { recursive: true });
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(rel(root, resolver.resolve(from, '@bare/thing'))).toBe('src/thing.ts');
    expect(rel(root, resolver.resolve(from, '@types/legacy'))).toBe('types/legacy.d.ts');
    // A directory without an index file is not a module.
    expect(resolver.resolve(from, '@dir/empty-dir')).toBeNull();
    // Bundler-style suffixes are not module paths: they stay external.
    expect(resolver.resolve(from, '@bare/thing?raw')).toBeNull();
    expect(resolver.resolve(from, '')).toBeNull();
  });

  it('never resolves an alias target outside the workspace root', () => {
    const outside = createWorkspace();
    write(outside, 'secret.ts', '');
    const root = createWorkspace();
    write(
      root,
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { paths: { '@outside/*': [`${outside.replaceAll('\\', '/')}/*`] } } })
    );
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(resolver.resolve(from, '@outside/secret')).toBeNull();
    expect(resolver.resolve(from, '../../outside/secret')).toBeNull();
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
    // Both a later alias target and a baseUrl-rooted file would resolve inside the
    // workspace; the out-of-bounds target still wins the lookup, so it stays external.
    write(root, 'src/shared/money.ts', '');
    write(root, '@shared/money.ts', '');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(resolver.resolve(from, '@shared/money')).toBeNull();
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

    expect(rel(root, resolver.resolve(from, '@/index'))).toBe('src/index.ts');
    // TypeScript substitutes only a non-empty capture, so `./src/*` keeps its literal
    // `*` here and resolves to nothing instead of to `src/index.ts`.
    expect(resolver.resolve(from, '@/')).toBeNull();
    // An exact key is matched without a capture, so its target is used verbatim too.
    expect(resolver.resolve(from, 'exactstar')).toBeNull();
    // TypeScript never parses a key with two or more wildcards, so it matches nothing
    // at all -- not even the literal specifier.
    expect(resolver.resolve(from, 'two**star')).toBeNull();
    expect(resolver.resolve(from, 'a*b*c')).toBeNull();
  });

  it('resolves declaration-only modules through aliases and relative imports', () => {
    const root = createWorkspace();
    write(
      root,
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } })
    );
    write(root, 'src/types/only.d.ts', '');
    write(root, 'src/idx/index.d.ts', '');
    write(root, 'src/both.d.ts', '');
    write(root, 'src/both.ts', '');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(rel(root, resolver.resolve(from, '@/types/only'))).toBe('src/types/only.d.ts');
    expect(rel(root, resolver.resolve(from, './types/only'))).toBe('src/types/only.d.ts');
    expect(rel(root, resolver.resolve(from, '@/idx'))).toBe('src/idx/index.d.ts');
    // A real source file still wins over a declaration sitting next to it.
    expect(rel(root, resolver.resolve(from, '@/both'))).toBe('src/both.ts');
  });

  it('never throws on a config with a JSON syntax error, and recovers what tsc would', () => {
    const root = createWorkspace();
    // Unclosed brace. TypeScript parses JSON leniently, so the aliases are still read --
    // what matters is that neither the parse nor the diagnostics blow up the tool call.
    write(root, 'tsconfig.json', '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } ');
    write(root, 'src/a.ts', '');
    const from = write(root, 'src/main.ts', '');

    const resolver = createImportResolver(root);

    expect(rel(root, resolver.resolve(from, './a'))).toBe('src/a.ts');
    expect(rel(root, resolver.resolve(from, '@/a'))).toBe('src/a.ts');
  });

  it('degrades to no aliases when the config is not usable JSON at all', () => {
    for (const content of ['not json at all', '[1, 2, 3]', '']) {
      const root = createWorkspace();
      write(root, 'tsconfig.json', content);
      write(root, 'src/a.ts', '');
      const from = write(root, 'src/main.ts', '');
      resetPathAliasCacheForTests();

      const resolver = createImportResolver(root);

      expect(resolver.aliasConfig).toBeNull();
      expect(resolver.resolve(from, '@/a')).toBeNull();
      // Relative imports keep working regardless of the config.
      expect(rel(root, resolver.resolve(from, './a'))).toBe('src/a.ts');
    }
  });

  it('falls back to jsconfig.json when there is no tsconfig.json', () => {
    const root = createWorkspace();
    write(root, 'jsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '~/*': ['./app/*'] } } }));
    write(root, 'app/store.js', '');
    const from = write(root, 'app/main.js', '');

    const resolver = createImportResolver(root);

    expect(rel(root, resolver.resolve(from, '~/store'))).toBe('app/store.js');
  });

  it('caches the parsed config per workspace and reloads it when the file changes', () => {
    const root = createWorkspace();
    const tsconfigPath = write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));
    write(root, 'src/a.ts', '');
    write(root, 'lib/a.ts', '');
    const from = write(root, 'src/main.ts', '');

    expect(rel(root, createImportResolver(root).resolve(from, '@/a'))).toBe('src/a.ts');
    expect(loadPathAliasConfig(root)).toBe(loadPathAliasConfig(root));

    writeFileSync(tsconfigPath, JSON.stringify({ compilerOptions: { paths: { '@/*': ['./lib/*'] } } }), 'utf8');
    const future = new Date(Date.now() + 5_000);
    utimesSync(tsconfigPath, future, future);

    expect(rel(root, createImportResolver(root).resolve(from, '@/a'))).toBe('lib/a.ts');
  });

  it('reloads when a config in the extends chain changes', () => {
    const root = createWorkspace();
    const basePath = write(root, 'config/tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['../src/*'] } } }));
    write(root, 'tsconfig.json', JSON.stringify({ extends: './config/tsconfig.base.json' }));
    write(root, 'src/a.ts', '');
    write(root, 'lib/a.ts', '');
    const from = write(root, 'src/main.ts', '');

    expect(rel(root, createImportResolver(root).resolve(from, '@/a'))).toBe('src/a.ts');

    writeFileSync(basePath, JSON.stringify({ compilerOptions: { paths: { '@/*': ['../lib/*'] } } }), 'utf8');
    const future = new Date(Date.now() + 5_000);
    utimesSync(basePath, future, future);

    expect(rel(root, createImportResolver(root).resolve(from, '@/a'))).toBe('lib/a.ts');
  });
});
