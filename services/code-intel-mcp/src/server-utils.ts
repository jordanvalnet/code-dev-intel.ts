import { existsSync, statSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { assertWithinWorkspace, isPathWithinWorkspace } from './safe-path.ts';

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, message: string, code: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function isExistingDirectory(pathToCheck: string): boolean {
  if (!existsSync(pathToCheck)) {
    return false;
  }

  return statSync(pathToCheck).isDirectory();
}

export function normalizeWorkspaceRoot(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveAndValidateWorkspaceRoot(
  requestWorkspaceRoot: string | undefined,
  defaultWorkspaceRoot?: string
): string | undefined {
  const canonicalDefaultRoot = defaultWorkspaceRoot ? assertWithinWorkspace(defaultWorkspaceRoot, '.') : undefined;
  const canonicalRequestRoot = requestWorkspaceRoot ? assertWithinWorkspace(requestWorkspaceRoot, '.') : undefined;
  const effectiveRoot = canonicalRequestRoot ?? canonicalDefaultRoot;

  if (!effectiveRoot) {
    return undefined;
  }

  if (!isExistingDirectory(effectiveRoot)) {
    throw new HttpError(400, 'invalid workspaceRoot', 'INVALID_WORKSPACE_ROOT');
  }

  if (canonicalDefaultRoot && canonicalRequestRoot && !isPathWithinWorkspace(canonicalDefaultRoot, canonicalRequestRoot)) {
    throw new HttpError(
      400,
      'workspaceRoot must stay within configured default workspace root',
      'WORKSPACE_ROOT_OUT_OF_BOUNDARY'
    );
  }

  return effectiveRoot;
}

export function toErrorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return 'unknown error';
  }
}

export function summarizePayloadForLogs(payload: unknown): unknown {
  if (payload === undefined) {
    return undefined;
  }

  const serialized = JSON.stringify(payload);
  if (serialized.length <= 5000) {
    return payload;
  }

  return {
    truncated: true,
    totalChars: serialized.length,
    preview: serialized.slice(0, 5000)
  };
}

export async function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    if (typeof chunk === 'string') {
      const bufferChunk = Buffer.from(chunk);
      totalBytes += bufferChunk.length;
      if (totalBytes > maxBodyBytes) {
        throw new HttpError(413, 'payload too large', 'PAYLOAD_TOO_LARGE');
      }
      chunks.push(bufferChunk);
      continue;
    }

    if (Buffer.isBuffer(chunk)) {
      totalBytes += chunk.length;
      if (totalBytes > maxBodyBytes) {
        throw new HttpError(413, 'payload too large', 'PAYLOAD_TOO_LARGE');
      }
      chunks.push(chunk);
    } else {
      throw new HttpError(400, 'invalid request body', 'INVALID_REQUEST_CHUNK');
    }
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid json body', 'INVALID_JSON_BODY');
  }
}
