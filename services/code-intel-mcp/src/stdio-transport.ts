import { createInterface } from 'node:readline';
import { processMcpPostRequest } from './mcp-handler.ts';
import { logger } from './logger.ts';

export function startStdioTransport(workspaceRoot?: string): void {
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      const error = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' }
      };
      process.stdout.write(JSON.stringify(error) + '\n');
      return;
    }

    const response = await processMcpPostRequest(parsed, workspaceRoot);
    if (!response.skipResponse && response.payload) {
      process.stdout.write(JSON.stringify(response.payload) + '\n');
    }
  });

  rl.on('close', () => {
    logger.info('stdio transport closed');
    process.exit(0);
  });

  logger.info('stdio transport started', { workspaceRoot });
}
