import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import ts from 'typescript';
import {
  type DuplicateGroup,
  type DuplicateKind,
  type DuplicateMode,
  type DuplicateOccurrence,
  type DuplicateSuggestedAction,
  type FindDuplicatesRequest,
  type FindDuplicatesResult
} from './contracts.ts';
import { assertWithinWorkspace } from './safe-path.ts';
import { DuplicateCache, type CachedDuplicateWindow } from './duplicate-cache.ts';
import { safeSpawnSync } from './safe-spawn.ts';
import { collectWorkspaceFiles } from './file-collection.ts';

interface DuplicateWindow extends CachedDuplicateWindow {
  id: string;
  filePath: string;
  absoluteFilePath: string;
}

const YIELD_EVERY_OPERATIONS = 4000;

const DEFAULT_EXCLUDE = ['**/.git/**', '**/node_modules/**', '**/dist/**', '**/coverage/**', '**/.next/**'];
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function toUnixPath(value: string): string {
  return value.replaceAll('\\', '/');
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function resolveChangedFilesFromGit(workspaceRoot: string, sinceGitRef: string): Set<string> {
  const gitResult = safeSpawnSync('git', ['diff', '--name-only', sinceGitRef, 'HEAD'], {
    cwd: workspaceRoot,
    allowedCommands: ['git']
  });

  if (gitResult.status !== 0) {
    return new Set();
  }

  return new Set(
    gitResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => toUnixPath(line))
  );
}

function normalizeToken(tokenKind: ts.SyntaxKind, tokenText: string): string {
  if (tokenKind === ts.SyntaxKind.Identifier) {
    return 'ID';
  }

  if (
    tokenKind === ts.SyntaxKind.StringLiteral ||
    tokenKind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
    tokenKind === ts.SyntaxKind.TemplateHead ||
    tokenKind === ts.SyntaxKind.TemplateMiddle ||
    tokenKind === ts.SyntaxKind.TemplateTail
  ) {
    return 'STR';
  }

  if (tokenKind === ts.SyntaxKind.NumericLiteral || tokenKind === ts.SyntaxKind.BigIntLiteral) {
    return 'NUM';
  }

  return tokenText;
}

interface FileTokenScanResult {
  normalizedTokens: string[];
  rawTokens: string[];
  lineTokenOffsets: number[];
}

function scanFileTokens(content: string, lineCount: number): FileTokenScanResult {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, content);
  const sourceFile = ts.createSourceFile('duplicate-scan.ts', content, ts.ScriptTarget.Latest, true);
  const lineStarts = sourceFile.getLineStarts();

  const normalizedTokensByLine: string[][] = Array.from({ length: lineCount }, () => []);
  const rawTokensByLine: string[][] = Array.from({ length: lineCount }, () => []);

  let lineIndex = 0;
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    const tokenPos = scanner.getTokenPos();
    let nextLineStart = lineStarts[lineIndex + 1];
    while (typeof nextLineStart === 'number' && nextLineStart <= tokenPos) {
      lineIndex += 1;
      nextLineStart = lineStarts[lineIndex + 1];
    }

    const rawTokenText = scanner.getTokenText();
    const normalizedToken = normalizeToken(token, rawTokenText);
    normalizedTokensByLine[lineIndex]?.push(normalizedToken);
    rawTokensByLine[lineIndex]?.push(rawTokenText);
    token = scanner.scan();
  }

  const normalizedTokens: string[] = [];
  const rawTokens: string[] = [];
  const lineTokenOffsets: number[] = [0];

  for (let index = 0; index < lineCount; index += 1) {
    const normalizedForLine = normalizedTokensByLine[index] ?? [];
    const rawForLine = rawTokensByLine[index] ?? [];
    normalizedTokens.push(...normalizedForLine);
    rawTokens.push(...rawForLine);
    lineTokenOffsets.push(normalizedTokens.length);
  }

  return {
    normalizedTokens,
    rawTokens,
    lineTokenOffsets
  };
}

function buildSignatureKey(normalizedTokens: readonly string[]): string {
  const head = normalizedTokens.slice(0, 8).join('|');
  const tail = normalizedTokens.slice(-8).join('|');
  const sizeBucket = Math.floor(normalizedTokens.length / 10);
  return `${head}::${tail}::${sizeBucket}`;
}

function buildSnippetPreview(lines: readonly string[]): string {
  return lines
    .slice(0, 2)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 240);
}

function buildWindowsForFile(
  workspaceRoot: string,
  absoluteFilePath: string,
  minLines: number,
  minTokens: number,
  maxFileBytes: number
): DuplicateWindow[] {
  const stats = statSync(absoluteFilePath);
  if (stats.size > maxFileBytes) {
    return [];
  }

  const content = readFileSync(absoluteFilePath, 'utf8');
  const lines = content.split(/\r?\n/);
  if (lines.length < minLines) {
    return [];
  }

  const scannedTokens = scanFileTokens(content, lines.length);

  const relativeFilePath = toUnixPath(relative(workspaceRoot, absoluteFilePath));
  const windows: DuplicateWindow[] = [];

  for (let startIndex = 0; startIndex <= lines.length - minLines; startIndex += 1) {
    const endIndex = startIndex + minLines;
    const windowLines = lines.slice(startIndex, endIndex);

    const startTokenOffset = scannedTokens.lineTokenOffsets[startIndex] ?? 0;
    const endTokenOffset = scannedTokens.lineTokenOffsets[endIndex] ?? startTokenOffset;
    const tokenCount = endTokenOffset - startTokenOffset;

    if (tokenCount < minTokens) {
      continue;
    }

    const normalizedTokens = scannedTokens.normalizedTokens.slice(startTokenOffset, endTokenOffset);
    const rawTokens = scannedTokens.rawTokens.slice(startTokenOffset, endTokenOffset);
    const normalizedTokenString = normalizedTokens.join(' ');
    const rawTokenString = rawTokens.join(' ');
    const startLine = startIndex + 1;
    const endLine = endIndex;

    windows.push({
      id: `${relativeFilePath}:${startLine}:${endLine}`,
      filePath: relativeFilePath,
      absoluteFilePath,
      startLine,
      endLine,
      tokenCount,
      normalizedHash: hashValue(normalizedTokenString),
      rawHash: hashValue(rawTokenString),
      signatureKey: buildSignatureKey(normalizedTokens),
      normalizedTokenString,
      snippetPreview: buildSnippetPreview(windowLines),
      startColumn: 1,
      endColumn: 1
    } as DuplicateWindow);
  }

  return windows;
}

function jaccardSimilarity(leftTokens: string, rightTokens: string, shingleSize = 4): number {
  const left = leftTokens.split(' ');
  const right = rightTokens.split(' ');

  if (left.length < shingleSize || right.length < shingleSize) {
    return 0;
  }

  const toShingles = (tokens: string[]): Set<string> => {
    const shingles = new Set<string>();
    for (let index = 0; index <= tokens.length - shingleSize; index += 1) {
      shingles.add(tokens.slice(index, index + shingleSize).join('|'));
    }
    return shingles;
  };

  const leftShingles = toShingles(left);
  const rightShingles = toShingles(right);
  let intersection = 0;

  for (const shingle of leftShingles) {
    if (rightShingles.has(shingle)) {
      intersection += 1;
    }
  }

  const union = leftShingles.size + rightShingles.size - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function buildPairKey(leftId: string, rightId: string): string {
  return leftId < rightId ? `${leftId}|${rightId}` : `${rightId}|${leftId}`;
}

function shouldYieldOperation(operationCount: number): boolean {
  return operationCount > 0 && operationCount % YIELD_EVERY_OPERATIONS === 0;
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(() => resolve());
  });
}

function computeSuggestedAction(occurrences: DuplicateOccurrence[]): DuplicateSuggestedAction {
  const fileCount = new Set(occurrences.map((item) => item.filePath)).size;
  const lines = occurrences[0] ? occurrences[0].endLine - occurrences[0].startLine + 1 : 0;
  if (fileCount <= 1) {
    return 'extract-function';
  }

  if (fileCount <= 3 && lines < 30) {
    return 'shared-util';
  }

  return 'review';
}

function createGroup(
  groupId: string,
  fingerprint: string,
  kind: DuplicateKind,
  similarity: number,
  windows: DuplicateWindow[]
): DuplicateGroup {
  const occurrences: DuplicateOccurrence[] = windows
    .map((window) => ({
      filePath: window.filePath,
      startLine: window.startLine,
      endLine: window.endLine,
      startColumn: window.startColumn,
      endColumn: window.endColumn,
      snippetPreview: window.snippetPreview
    }))
    .sort((a, b) => `${a.filePath}:${a.startLine}`.localeCompare(`${b.filePath}:${b.startLine}`));

  const linesPerOccurrence =
    windows.length > 0
      ? Math.round(
          windows.reduce((accumulator, current) => accumulator + (current.endLine - current.startLine + 1), 0) /
            windows.length
        )
      : 0;
  const tokenCount = windows.length > 0 ? Math.round(windows.reduce((acc, curr) => acc + curr.tokenCount, 0) / windows.length) : 0;
  const occurrenceCount = occurrences.length;
  const estimatedDupLines = linesPerOccurrence * Math.max(0, occurrenceCount - 1);
  const dispersionFactor = Math.log2(1 + new Set(occurrences.map((item) => item.filePath)).size);
  const impactScore = Math.round(estimatedDupLines * Math.max(1, dispersionFactor));

  return {
    groupId,
    fingerprint,
    kind,
    similarity,
    occurrences,
    metrics: {
      linesPerOccurrence,
      tokenCount,
      occurrenceCount,
      estimatedDupLines,
      impactScore
    },
    suggestedAction: computeSuggestedAction(occurrences)
  };
}

function renderMarkdownReport(result: FindDuplicatesResult): string {
  const lines: string[] = [];
  lines.push('# Duplicate code report');
  lines.push('');
  lines.push(`- scannedFiles: ${result.summary.scannedFiles}`);
  lines.push(`- candidateWindows: ${result.summary.candidateWindows}`);
  lines.push(`- groupsFound: ${result.summary.groupsFound}`);
  lines.push(`- durationMs: ${result.summary.durationMs}`);
  lines.push('');

  for (const group of result.groups) {
    lines.push(`## ${group.groupId} (${group.kind})`);
    lines.push(`- similarity: ${group.similarity}`);
    lines.push(`- impactScore: ${group.metrics.impactScore}`);
    lines.push(`- occurrences: ${group.metrics.occurrenceCount}`);
    lines.push('');

    for (const occurrence of group.occurrences) {
      lines.push(
        `- ${occurrence.filePath}:${occurrence.startLine}-${occurrence.endLine} — ${occurrence.snippetPreview}`
      );
    }

    lines.push('');
  }

  return lines.join('\n');
}

function resolveMode(request: FindDuplicatesRequest): DuplicateMode {
  return request.mode ?? 'balanced';
}

function resolveMinSimilarity(request: FindDuplicatesRequest, mode: DuplicateMode): number {
  if (typeof request.minSimilarity === 'number') {
    return request.minSimilarity;
  }

  return mode === 'strict' ? 0.92 : 0.86;
}

export async function findDuplicates(request: FindDuplicatesRequest): Promise<FindDuplicatesResult> {
  const startedAt = Date.now();
  const mode = resolveMode(request);
  const minSimilarity = resolveMinSimilarity(request, mode);
  const minLines = request.minLines ?? 6;
  const minTokens = request.minTokens ?? 40;
  const includeIntraFile = request.includeIntraFile ?? true;
  const maxGroups = request.maxGroups ?? 100;
  const paths = request.paths && request.paths.length > 0 ? request.paths : ['.'];
  const exclude = [...DEFAULT_EXCLUDE, ...(request.exclude ?? [])];
  const maxFileBytes = Number.parseInt(process.env.CODE_INTEL_DUP_MAX_FILE_BYTES ?? '512000', 10);
  const workspaceRoot = assertWithinWorkspace(request.workspaceRoot, '.');
  const changedFiles = request.sinceGitRef ? resolveChangedFilesFromGit(workspaceRoot, request.sinceGitRef) : undefined;

  const allFiles = collectWorkspaceFiles({
    workspaceRoot,
    includePaths: paths,
    excludePatterns: exclude,
    allowedExtensions: CODE_EXTENSIONS
  });
  const files = changedFiles
    ? allFiles.filter((filePath) => changedFiles.has(toUnixPath(relative(workspaceRoot, filePath))))
    : allFiles;

  const cache = new DuplicateCache(workspaceRoot);
  const windows: DuplicateWindow[] = [];
  const validFilePaths = new Set<string>();
  let truncated = false;
  let peakMemoryMb = 0;

  for (const absoluteFilePath of files) {
    const relativePath = toUnixPath(relative(workspaceRoot, absoluteFilePath));
    validFilePaths.add(relativePath);
    const stats = statSync(absoluteFilePath);
    const cached = cache.get(relativePath, stats.mtimeMs, stats.size);

    let fileWindows: DuplicateWindow[];
    if (cached) {
      fileWindows = cached.map((window) => ({
        ...window,
        id: `${relativePath}:${window.startLine}:${window.endLine}`,
        filePath: relativePath,
        absoluteFilePath
      }));
    } else {
      fileWindows = buildWindowsForFile(workspaceRoot, absoluteFilePath, minLines, minTokens, maxFileBytes);
      cache.set(
        relativePath,
        stats.mtimeMs,
        stats.size,
        fileWindows.map((window) => ({
          startLine: window.startLine,
          endLine: window.endLine,
          startColumn: window.startColumn,
          endColumn: window.endColumn,
          tokenCount: window.tokenCount,
          normalizedHash: window.normalizedHash,
          rawHash: window.rawHash,
          signatureKey: window.signatureKey,
          normalizedTokenString: window.normalizedTokenString,
          snippetPreview: window.snippetPreview
        }))
      );
    }

    windows.push(...fileWindows);

    const heapUsedMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    peakMemoryMb = Math.max(peakMemoryMb, heapUsedMb);
    if (heapUsedMb > 300) {
      truncated = true;
      break;
    }

    await yieldToEventLoop();
  }

  cache.prune(validFilePaths);
  cache.save();

  const exactBuckets = new Map<string, DuplicateWindow[]>();
  for (const window of windows) {
    if (!includeIntraFile) {
      const duplicateInSameFile = exactBuckets
        .get(window.normalizedHash)
        ?.some((existing) => existing.filePath === window.filePath);
      if (duplicateInSameFile) {
        continue;
      }
    }

    const bucket = exactBuckets.get(window.normalizedHash) ?? [];
    bucket.push(window);
    exactBuckets.set(window.normalizedHash, bucket);
  }

  const groups: DuplicateGroup[] = [];
  const usedByExact = new Set<string>();

  for (const [hash, bucket] of exactBuckets.entries()) {
    if (bucket.length < 2) {
      continue;
    }

    bucket.sort((a, b) => a.id.localeCompare(b.id));
    const rawHashes = new Set(bucket.map((item) => item.rawHash));
    const kind: DuplicateKind = rawHashes.size === 1 ? 'type1' : 'type2';
    const groupId = `dup_exact_${hash.slice(0, 12)}`;
    groups.push(createGroup(groupId, `sha256:${hash}`, kind, 1, bucket));
    bucket.forEach((item) => usedByExact.add(item.id));
  }

  if (mode !== 'fast') {
    const signatureBuckets = new Map<string, DuplicateWindow[]>();
    for (const window of windows) {
      if (usedByExact.has(window.id)) {
        continue;
      }
      const bucket = signatureBuckets.get(window.signatureKey) ?? [];
      bucket.push(window);
      signatureBuckets.set(window.signatureKey, bucket);
    }

    for (const [signature, bucket] of signatureBuckets.entries()) {
      if (bucket.length < 2) {
        continue;
      }

      const adjacent: Map<string, Set<string>> = new Map();
      const similarityByPair = new Map<string, number>();
      const windowById = new Map(bucket.map((window) => [window.id, window]));
      let operationCount = 0;

      for (let i = 0; i < bucket.length; i += 1) {
        for (let j = i + 1; j < bucket.length; j += 1) {
          const left = bucket[i];
          const right = bucket[j];
          if (!left || !right || left.normalizedHash === right.normalizedHash) {
            continue;
          }

          if (!includeIntraFile && left.filePath === right.filePath) {
            continue;
          }

          const similarity = jaccardSimilarity(left.normalizedTokenString, right.normalizedTokenString);
          similarityByPair.set(buildPairKey(left.id, right.id), similarity);
          operationCount += 1;
          if (shouldYieldOperation(operationCount)) {
            await yieldToEventLoop();
          }

          if (similarity >= minSimilarity && similarity < 1) {
            const leftSet = adjacent.get(left.id) ?? new Set<string>();
            leftSet.add(right.id);
            adjacent.set(left.id, leftSet);

            const rightSet = adjacent.get(right.id) ?? new Set<string>();
            rightSet.add(left.id);
            adjacent.set(right.id, rightSet);
          }
        }
      }

      const visited = new Set<string>();
      for (const node of adjacent.keys()) {
        if (visited.has(node)) {
          continue;
        }

        const stack = [node];
        const componentIds: string[] = [];
        while (stack.length > 0) {
          const current = stack.pop();
          if (!current || visited.has(current)) {
            continue;
          }

          visited.add(current);
          componentIds.push(current);
          const neighbors = adjacent.get(current);
          if (neighbors) {
            stack.push(...neighbors);
          }
        }

        if (componentIds.length < 2) {
          continue;
        }

        const componentWindows = componentIds
          .map((id) => windowById.get(id))
          .filter((window): window is DuplicateWindow => Boolean(window));

        if (componentWindows.length < 2) {
          continue;
        }

        const pairSimilarities: number[] = [];
        for (let i = 0; i < componentWindows.length; i += 1) {
          for (let j = i + 1; j < componentWindows.length; j += 1) {
            const left = componentWindows[i];
            const right = componentWindows[j];
            if (!left || !right) {
              continue;
            }
            const pairKey = buildPairKey(left.id, right.id);
            const existingSimilarity = similarityByPair.get(pairKey);
            if (typeof existingSimilarity === 'number') {
              pairSimilarities.push(existingSimilarity);
              continue;
            }

            const similarity = jaccardSimilarity(left.normalizedTokenString, right.normalizedTokenString);
            similarityByPair.set(pairKey, similarity);
            pairSimilarities.push(similarity);
          }
        }

        const avgSimilarity =
          pairSimilarities.length > 0
            ? Number((pairSimilarities.reduce((acc, value) => acc + value, 0) / pairSimilarities.length).toFixed(2))
            : minSimilarity;

        const fingerprint = hashValue(componentIds.sort().join('|'));
        groups.push(
          createGroup(`dup_type3_${fingerprint.slice(0, 12)}`, `sha256:${signature}`, 'type3', avgSimilarity, componentWindows)
        );

        operationCount += componentWindows.length;
        if (shouldYieldOperation(operationCount)) {
          await yieldToEventLoop();
        }
      }

      await yieldToEventLoop();
    }
  }

  const sortedGroups = groups
    .sort((left, right) => {
      const impactDiff = right.metrics.impactScore - left.metrics.impactScore;
      if (impactDiff !== 0) {
        return impactDiff;
      }
      return left.fingerprint.localeCompare(right.fingerprint);
    })
    .slice(0, maxGroups)
    .map((group, index) => ({
      ...group,
      groupId: `dup_${String(index + 1).padStart(4, '0')}`
    }));

  const result: FindDuplicatesResult = {
    groups: sortedGroups,
    summary: {
      scannedFiles: files.length,
      candidateWindows: windows.length,
      groupsFound: sortedGroups.length,
      durationMs: Date.now() - startedAt,
      mode,
      peakMemoryMb,
      truncated
    }
  };

  if (request.outputFormat === 'markdown') {
    result.markdownReport = renderMarkdownReport(result);
  }

  return result;
}
