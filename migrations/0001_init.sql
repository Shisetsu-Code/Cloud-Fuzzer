-- R2 stores the JPEG bytes. D1 stores the queue and classifications.
CREATE TABLE IF NOT EXISTS captures (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  task_id INTEGER NOT NULL CHECK(task_id > 0),
  provider TEXT NOT NULL DEFAULT 'pragmatic',
  image_key TEXT NOT NULL,
  image_sha256 TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
  size_bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','classified','needs_review')),
  revision INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until INTEGER,
  marks_json TEXT,
  reviewer TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id,slug,task_id)
);
CREATE INDEX IF NOT EXISTS idx_capture_next ON captures(status,lease_until,created_at,id);
CREATE INDEX IF NOT EXISTS idx_capture_run ON captures(run_id,status,created_at);
CREATE TABLE IF NOT EXISTS classification_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capture_id TEXT NOT NULL,
  image_sha256 TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  marks_json TEXT NOT NULL,
  reviewer TEXT,
  saved_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(capture_id) REFERENCES captures(id),
  UNIQUE(capture_id,revision)
);
