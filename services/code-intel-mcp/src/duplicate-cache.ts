import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface CachedDuplicateWindow {
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  tokenCount: number;
  normalizedHash: string;
  rawHash: string;
  signatureKey: string;
  normalizedTokenString: string;
  snippetPreview: string;
}

interface DuplicateCacheEntry {
  mtimeMs: number;
  size: number;
  windows: CachedDuplicateWindow[];
}

interface DuplicateCacheFile {
  version: 1;
  files: Record<string, DuplicateCacheEntry>;
}

const CACHE_FILE_RELATIVE_PATH = '.code-intel-cache/dup-cache.json';

function getCacheFilePath(workspaceRoot: string): string {
  return resolve(workspaceRoot, CACHE_FILE_RELATIVE_PATH);
}

export class DuplicateCache {
  private readonly cacheFilePath: string;

  private readonly data: DuplicateCacheFile;

  private dirty = false;

  constructor(workspaceRoot: string) {
    this.cacheFilePath = getCacheFilePath(workspaceRoot);
    this.data = this.load();
  }

  private load(): DuplicateCacheFile {
    if (!existsSync(this.cacheFilePath)) {
      return { version: 1, files: {} };
    }

    try {
      const raw = readFileSync(this.cacheFilePath, 'utf8');
      const parsed = JSON.parse(raw) as DuplicateCacheFile;
      if (parsed.version !== 1 || typeof parsed.files !== 'object' || !parsed.files) {
        return { version: 1, files: {} };
      }
      return parsed;
    } catch {
      return { version: 1, files: {} };
    }
  }

  get(filePath: string, mtimeMs: number, size: number): CachedDuplicateWindow[] | undefined {
    const entry = this.data.files[filePath];
    if (!entry) {
      return undefined;
    }

    if (entry.mtimeMs !== mtimeMs || entry.size !== size) {
      return undefined;
    }

    return entry.windows;
  }

  set(filePath: string, mtimeMs: number, size: number, windows: CachedDuplicateWindow[]): void {
    const previous = this.data.files[filePath];
    if (
      previous &&
      previous.mtimeMs === mtimeMs &&
      previous.size === size &&
      JSON.stringify(previous.windows) === JSON.stringify(windows)
    ) {
      return;
    }

    this.data.files[filePath] = {
      mtimeMs,
      size,
      windows
    };
    this.dirty = true;
  }

  prune(validFilePaths: Set<string>): void {
    for (const filePath of Object.keys(this.data.files)) {
      if (!validFilePaths.has(filePath)) {
        delete this.data.files[filePath];
        this.dirty = true;
      }
    }
  }

  save(): void {
    if (!this.dirty) {
      return;
    }

    mkdirSync(dirname(this.cacheFilePath), { recursive: true });
    const tmpFilePath = `${this.cacheFilePath}.tmp`;
    writeFileSync(tmpFilePath, JSON.stringify(this.data), 'utf8');
    renameSync(tmpFilePath, this.cacheFilePath);
    this.dirty = false;
  }
}
