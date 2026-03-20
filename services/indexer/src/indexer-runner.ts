import {
  listChangedFilesFromGitDiff,
  type ChangeDetectorOptions,
  watchChangedFiles,
  type DetectorMode
} from './change-detector.ts';
import { calculateWorkspaceImpactedFiles } from './impacted-files-engine.ts';
import { logger } from '../../code-intel-mcp/src/logger.ts';

export interface IndexerRunOptions extends ChangeDetectorOptions {
  mode: DetectorMode;
  changedFiles?: string[];
  changedSymbolsByFile?: Record<string, string[]>;
}

export function runIndexer(options: IndexerRunOptions): void {
  if (options.mode === 'git-diff') {
    const changedFiles = listChangedFilesFromGitDiff(options);
    logger.info('indexer completed', {
      mode: 'git-diff',
      changedFiles,
      changedCount: changedFiles.length
    });
    return;
  }

  if (options.mode === 'watch') {
    logger.info('indexer watch mode started');
    const stop = watchChangedFiles(options, (files) => {
      logger.info('indexer watch detected changes', {
        mode: 'watch',
        changedFiles: files,
        changedCount: files.length
      });
    });

    process.on('SIGINT', () => {
      stop();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      stop();
      process.exit(0);
    });

    return;
  }

  if (options.mode === 'impacted') {
    const changedFiles = options.changedFiles ?? [];
    if (changedFiles.length === 0) {
      throw new Error('impacted mode requires --changed=<file1,file2,...>');
    }

    const impactedFiles = calculateWorkspaceImpactedFiles({
      workspaceRoot: options.workspaceRoot,
      changedFiles,
      changedSymbolsByFile: options.changedSymbolsByFile
    });

    logger.info('indexer completed', {
      mode: 'impacted',
      changedFiles,
      changedCount: changedFiles.length,
      impactedFiles,
      impactedCount: impactedFiles.length
    });

    return;
  }

  throw new Error(`Unsupported mode: ${String(options.mode)}`);
}

function parseChangedSymbols(value: string | undefined): Record<string, string[]> | undefined {
  if (!value) {
    return undefined;
  }

  const entries = value
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((entry) => {
      const [filePathRaw, symbolsRaw] = entry.split(':');
      const filePath = filePathRaw?.trim();
      if (!filePath) {
        return null;
      }

      const symbols = (symbolsRaw ?? '')
        .split(',')
        .map((symbol) => symbol.trim())
        .filter(Boolean);

      return [filePath, symbols] as const;
    })
    .filter((entry): entry is readonly [string, string[]] => entry !== null);

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function parseCliArgs(): IndexerRunOptions {
  const args = process.argv.slice(2);
  const modeArg = args.find((value) => value.startsWith('--mode='));
  const baseRefArg = args.find((value) => value.startsWith('--baseRef='));
  const rootArg = args.find((value) => value.startsWith('--workspaceRoot='));
  const changedArg = args.find((value) => value.startsWith('--changed='));
  const changedSymbolsArg = args.find((value) => value.startsWith('--changedSymbols='));

  const mode = (modeArg?.split('=')[1] as DetectorMode | undefined) ?? 'git-diff';
  const baseRef = baseRefArg?.split('=')[1];
  const workspaceRoot = rootArg?.split('=')[1] ?? process.cwd();
  const changedFiles = (changedArg?.split('=')[1] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const changedSymbolsByFile = parseChangedSymbols(changedSymbolsArg?.split('=')[1]);

  return {
    mode,
    baseRef,
    workspaceRoot,
    changedFiles,
    changedSymbolsByFile
  };
}

const isDirectExecution = (process.argv[1] ?? '').replaceAll('\\', '/').endsWith('indexer-runner.ts');

if (isDirectExecution) {
  const options = parseCliArgs();
  runIndexer(options);
}
