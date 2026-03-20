type LogLevel = 'error' | 'warn' | 'info' | 'debug';

interface LoggerContext {
  [key: string]: unknown;
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LoggerContext;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

const REDACTION_PATTERNS = [
  /(bearer\s+)[a-z0-9\-._~+/]+=*/gi,
  /(api[_-]?key["'\s:=]+)[^\s,;"']+/gi,
  /(token["'\s:=]+)[^\s,;"']+/gi,
  /(password["'\s:=]+)[^\s,;"']+/gi,
  /([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi
];

type LoggerSink = (line: string, level: LogLevel) => void;

let logSink: LoggerSink = (line, level) => {
  if (level === 'error') {
    process.stderr.write(`${line}\n`);
    return;
  }

  process.stdout.write(`${line}\n`);
};

let cachedLogLevelRaw: string | undefined;
let cachedLogLevel: LogLevel = parseLogLevel(process.env.CODE_INTEL_LOG_LEVEL);

function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'error' || normalized === 'warn' || normalized === 'info' || normalized === 'debug') {
    return normalized;
  }

  return 'info';
}

function shouldLog(entryLevel: LogLevel, currentLevel: LogLevel): boolean {
  return LEVEL_PRIORITY[entryLevel] <= LEVEL_PRIORITY[currentLevel];
}

function redactString(value: string): string {
  let output = value;
  for (const pattern of REDACTION_PATTERNS) {
    output = output.replace(pattern, (_match, prefix: string) => `${prefix}[REDACTED]`);
  }

  return output;
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(input)) {
      output[key] = redactValue(nestedValue);
    }
    return output;
  }

  return value;
}

function getCurrentLogLevel(): LogLevel {
  const currentRaw = process.env.CODE_INTEL_LOG_LEVEL;
  if (currentRaw !== cachedLogLevelRaw) {
    cachedLogLevelRaw = currentRaw;
    cachedLogLevel = parseLogLevel(currentRaw);
  }

  return cachedLogLevel;
}

function writeLog(level: LogLevel, message: string, context?: LoggerContext): void {
  const currentLevel = getCurrentLogLevel();
  if (!shouldLog(level, currentLevel)) {
    return;
  }

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    context: context ? (redactValue(context) as LoggerContext) : undefined
  };

  logSink(JSON.stringify(entry), level);
}

export const logger = {
  error: (message: string, context?: LoggerContext) => writeLog('error', message, context),
  warn: (message: string, context?: LoggerContext) => writeLog('warn', message, context),
  info: (message: string, context?: LoggerContext) => writeLog('info', message, context),
  debug: (message: string, context?: LoggerContext) => writeLog('debug', message, context)
};

export function setLoggerSinkForTests(sink: LoggerSink): void {
  logSink = sink;
}

export function resetLoggerSinkForTests(): void {
  logSink = (line, level) => {
    if (level === 'error') {
      process.stderr.write(`${line}\n`);
      return;
    }

    process.stdout.write(`${line}\n`);
  };
}
