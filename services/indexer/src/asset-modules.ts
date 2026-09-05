import { extname } from 'node:path';

/**
 * Non-code files a module can depend on. Code imports them, bundlers turn them into
 * modules, and changing one changes the behaviour of every file that imports it — so
 * they belong in the graph. What they are NOT is a source of edges: nothing here is
 * parsed, so an asset is always a leaf.
 *
 * `.module.css` and friends need no entry of their own: only the last extension counts.
 * Order is the order the tool description lists them in, so a reader can predict the
 * answer from the description alone.
 */
export const ASSET_EXTENSIONS = [
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.json',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.woff',
  '.woff2',
  '.graphql',
  '.gql',
  '.md',
  '.txt',
  '.yaml',
  '.yml'
] as const;

const ASSET_EXTENSION_SET = new Set<string>(ASSET_EXTENSIONS);

/**
 * The one extension on this list that a JavaScript resolver appends by itself:
 * `require('./data/fixture')`, Node's CommonJS loader and every bundler find
 * `fixture.json`. So an extensionless specifier is allowed to land on a `.json` file
 * and on nothing else — no bundler resolves `./button` to a stylesheet, and inventing
 * that edge would be worse than reporting the gap.
 */
export const IMPLICIT_ASSET_EXTENSION = '.json';

/** The list as the tool descriptions and the README spell it. */
export const ASSET_EXTENSION_LIST = ASSET_EXTENSIONS.join(' ');

/**
 * Default for the `includeAssets` option of `dependencyGraph` and `impactedFiles`.
 *
 * Measured on a 4,000-file synthetic workspace with ~3,600 asset imports: resolving
 * asset specifiers by exact filename is CHEAPER than letting TypeScript's module
 * resolution probe them and fail, and it removes the far larger cost of reporting
 * thousands of healthy asset imports as `not-found`. Including them makes
 * `impactedFiles` answer the question it exists to answer — a changed stylesheet or
 * JSON fixture really does impact the code that imports it — at a payload cost of a
 * few entries per response.
 */
export const DEFAULT_INCLUDE_ASSETS = true;

/**
 * Bundlers accept a query suffix on an asset specifier (`./logo.svg?react`,
 * `./sprite.svg?url`) to pick an import flavour. The file it names is the part before
 * the `?`, and that file is a real dependency, so the suffix is dropped before the
 * lookup. Only a suffix is dropped — a leading `#` is a package-internal specifier and
 * is left alone.
 */
export function withoutSpecifierQuery(specifier: string): string {
  const queryIndex = specifier.indexOf('?');
  return queryIndex === -1 ? specifier : specifier.slice(0, queryIndex);
}

/** Is this path (as written on disk) one of the non-code files the graph can point at? */
export function isAssetPath(filePath: string): boolean {
  return ASSET_EXTENSION_SET.has(extname(filePath).toLowerCase());
}

/** Does this import specifier name an asset rather than a module? */
export function isAssetSpecifier(specifier: string): boolean {
  return isAssetPath(withoutSpecifierQuery(specifier));
}
