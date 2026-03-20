PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  language TEXT,
  content_hash TEXT,
  last_indexed_at TEXT NOT NULL,
  git_commit TEXT
);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  symbol_name TEXT NOT NULL,
  symbol_kind TEXT NOT NULL,
  signature TEXT,
  start_line INTEGER NOT NULL,
  start_col INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_col INTEGER NOT NULL,
  exported INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS references_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_symbol_id INTEGER,
  source_file_id INTEGER NOT NULL,
  target_symbol_name TEXT,
  target_file_path TEXT,
  ref_kind TEXT,
  line INTEGER NOT NULL,
  col INTEGER NOT NULL,
  FOREIGN KEY (source_symbol_id) REFERENCES symbols(id) ON DELETE SET NULL,
  FOREIGN KEY (source_file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS imports_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file_id INTEGER NOT NULL,
  import_path TEXT NOT NULL,
  imported_symbol TEXT,
  is_type_only INTEGER NOT NULL DEFAULT 0,
  line INTEGER,
  col INTEGER,
  FOREIGN KEY (source_file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS index_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  files_scanned INTEGER NOT NULL DEFAULT 0,
  files_changed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(symbol_name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_refs_source_file ON references_map(source_file_id);
CREATE INDEX IF NOT EXISTS idx_refs_target_name ON references_map(target_symbol_name);
CREATE INDEX IF NOT EXISTS idx_imports_source_file ON imports_map(source_file_id);
CREATE INDEX IF NOT EXISTS idx_imports_path ON imports_map(import_path);
