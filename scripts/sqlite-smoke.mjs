import { readFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = resolve(process.cwd());
const schemaPath = resolve(repoRoot, 'schemas/sqlite/001_initial.sql');
const dbPath = resolve(repoRoot, 'tmp-dev-intel.sqlite');

if (existsSync(dbPath)) {
  rmSync(dbPath);
}

const schemaSql = readFileSync(schemaPath, 'utf8');
const db = new DatabaseSync(dbPath);

try {
  db.exec(schemaSql);

  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO files (path, language, content_hash, last_indexed_at, git_commit)
     VALUES (?, ?, ?, ?, ?)`
  ).run('src/example.ts', 'ts', 'hash_123', now, 'abc123');

  const fileIdRow = db.prepare('SELECT id FROM files WHERE path = ?').get('src/example.ts');
  const fileId = fileIdRow.id;

  db.prepare(
    `INSERT INTO symbols
     (file_id, symbol_name, symbol_kind, signature, start_line, start_col, end_line, end_col, exported)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(fileId, 'ExampleService', 'class', 'class ExampleService {}', 1, 0, 10, 1, 1);

  db.prepare(
    `INSERT INTO imports_map
     (source_file_id, import_path, imported_symbol, is_type_only, line, col)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(fileId, '@/domain/entities/User', 'User', 0, 1, 10);

  db.prepare(
    `INSERT INTO index_runs
     (run_id, mode, started_at, finished_at, files_scanned, files_changed, status, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('run_smoke_001', 'git-diff', now, now, 1, 1, 'ok', null);

  const filesCount = db.prepare('SELECT COUNT(*) as count FROM files').get().count;
  const symbolsCount = db.prepare('SELECT COUNT(*) as count FROM symbols').get().count;
  const importsCount = db.prepare('SELECT COUNT(*) as count FROM imports_map').get().count;
  const runsCount = db.prepare('SELECT COUNT(*) as count FROM index_runs').get().count;

  if (filesCount < 1 || symbolsCount < 1 || importsCount < 1 || runsCount < 1) {
    throw new Error('Smoke validation failed: expected seeded rows are missing');
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        filesCount,
        symbolsCount,
        importsCount,
        runsCount,
        dbPath
      },
      null,
      2
    )
  );
} finally {
  db.close();
}
