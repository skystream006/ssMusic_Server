CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
  user_handle TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'revoked')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'user', 'shared'));
CREATE TABLE IF NOT EXISTS library_shares (
  viewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (viewer_id, owner_id), CHECK (viewer_id <> owner_id)
);
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL, counter BIGINT NOT NULL, transports JSONB NOT NULL,
  created_at TEXT, last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS credentials_user ON credentials(user_id);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS private_access_tokens (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS private_access_tokens_user ON private_access_tokens(user_id);
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme TEXT NOT NULL DEFAULT 'light', theme_mode TEXT CHECK (theme_mode IN ('light', 'dark')),
  library JSONB NOT NULL DEFAULT '{"entries":[],"songOrder":{}}', library_version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_url ON jobs(url, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at DESC, id);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS song_count BIGINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS jobs_output_directory ON jobs((data->>'outputDir'));
CREATE TABLE IF NOT EXISTS job_users (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, PRIMARY KEY (user_id, job_id)
);
CREATE INDEX IF NOT EXISTS job_users_job ON job_users(job_id);
CREATE TABLE IF NOT EXISTS songs (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, name TEXT NOT NULL,
  file_order INTEGER NOT NULL, media_type TEXT, metadata JSONB NOT NULL DEFAULT '{}',
  transcription JSONB, search_text TEXT NOT NULL DEFAULT '', PRIMARY KEY (job_id, name)
);
CREATE INDEX IF NOT EXISTS songs_job_order ON songs(job_id, file_order);
CREATE INDEX IF NOT EXISTS songs_search ON songs USING gin (search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS songs_transcription_status ON songs(job_id, (transcription->>'status')) WHERE transcription IS NOT NULL;
ALTER TABLE songs ADD COLUMN IF NOT EXISTS karaoke_stem TEXT;
CREATE INDEX IF NOT EXISTS songs_karaoke ON songs(job_id, karaoke_stem) WHERE karaoke_stem IS NOT NULL;
CREATE TABLE IF NOT EXISTS media_shares (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  job_id TEXT NOT NULL, name TEXT NOT NULL,
  creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id, name) REFERENCES songs(job_id, name) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS media_shares_song ON media_shares(job_id, name);
CREATE INDEX IF NOT EXISTS media_shares_creator ON media_shares(creator_id);
CREATE TABLE IF NOT EXISTS library_entries (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL,
  parent_id TEXT, entry_type TEXT NOT NULL, position INTEGER NOT NULL, data JSONB NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS library_entries_parent ON library_entries(user_id, parent_id, position);
ALTER TABLE library_entries ADD COLUMN IF NOT EXISTS playlist_position INTEGER;
ALTER TABLE library_entries ADD COLUMN IF NOT EXISTS song_count BIGINT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS library_memberships (
  user_id TEXT NOT NULL, playlist_id TEXT NOT NULL, job_id TEXT NOT NULL, name TEXT NOT NULL,
  position BIGINT NOT NULL,
  PRIMARY KEY (user_id, playlist_id, job_id, name),
  FOREIGN KEY (user_id, playlist_id) REFERENCES library_entries(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (job_id, name) REFERENCES songs(job_id, name) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS library_memberships_page ON library_memberships(user_id, playlist_id, position, job_id, name);
CREATE INDEX IF NOT EXISTS library_memberships_song ON library_memberships(job_id, name, user_id);
CREATE TABLE IF NOT EXISTS user_songs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL, name TEXT NOT NULL, playlist_id TEXT NOT NULL,
  playlist_position INTEGER NOT NULL, position BIGINT NOT NULL,
  PRIMARY KEY (user_id, job_id, name),
  FOREIGN KEY (job_id, name) REFERENCES songs(job_id, name) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS user_songs_page ON user_songs(user_id, playlist_position, position, job_id, name);
CREATE INDEX IF NOT EXISTS user_songs_song ON user_songs(job_id, name);
CREATE TABLE IF NOT EXISTS user_catalog (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  total_songs BIGINT NOT NULL DEFAULT 0, revision BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS library_backups (
  user_id TEXT PRIMARY KEY, schedule JSONB NOT NULL DEFAULT '{"enabled":false}',
  next_run_at TEXT, latest JSONB, running INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT, last_error TEXT
);
INSERT INTO migrations (name) VALUES ('postgres-schema-v1') ON CONFLICT DO NOTHING;