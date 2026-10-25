import type { SqlDatabase } from './sql';
import { transaction } from './sql';
import { migrateThinkingRows } from './thinking-migration';

export const DATABASE_VERSION = 5;

const VERSION_ONE = `
CREATE TABLE cot_presets (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, prefix TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  description TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT 'sparkles', position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE models (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('deepseek', 'moonshot', 'dashscope', 'zhipu', 'custom')),
  base_url TEXT NOT NULL, api_model TEXT NOT NULL, api_key_alias TEXT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  cot_mode TEXT NOT NULL DEFAULT 'off' CHECK (cot_mode IN ('off', 'native', 'prefill', 'persona')),
  cot_preset_id TEXT REFERENCES cot_presets(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX models_one_default ON models(is_default) WHERE is_default = 1;
CREATE TABLE personas (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  cover_uri TEXT, avatar_uri TEXT, traits TEXT NOT NULL DEFAULT '[]', interests TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE memories (
  id TEXT PRIMARY KEY NOT NULL, persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  content TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto')),
  icon TEXT NOT NULL DEFAULT 'heart', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX memories_persona ON memories(persona_id, position);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL,
  model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
  persona_id TEXT REFERENCES personas(id) ON DELETE SET NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX sessions_updated_at ON sessions(updated_at DESC);
CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  content TEXT NOT NULL DEFAULT '', reasoning TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending', 'streaming', 'done', 'aborted', 'error')),
  error TEXT, cot_mode TEXT NOT NULL DEFAULT 'off' CHECK (cot_mode IN ('off', 'native', 'prefill', 'persona')),
  cot_preset_id TEXT, model_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX messages_session_created ON messages(session_id, created_at);
CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
`;

/** A failed migration rolls back its tables and version together. Newer databases are never reset. */
export function migrateDatabase(db: SqlDatabase) {
  const version = db.getFirstSync<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0;
  if (version > DATABASE_VERSION) throw new Error('本地数据库来自较新版本，请更新应用后重试。已有数据尚未覆盖。');
  db.execSync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  if (version === DATABASE_VERSION) return;
  transaction(db, () => {
    if (version < 1) db.execSync(VERSION_ONE);
    if (version < 2) db.execSync('ALTER TABLE messages ADD COLUMN cot_audit TEXT');
    if (version < 3) {
      const oldMarker = db.getFirstSync<{ value: string }>("SELECT value FROM settings WHERE key = '_companion_persona_id'");
      let markedId: unknown = null;
      if (oldMarker) markedId = JSON.parse(oldMarker.value);
      const marked = typeof markedId === 'string' ? db.getFirstSync<{ id: string }>('SELECT id FROM personas WHERE id = ?', [markedId]) : null;
      const active = marked ?? db.getFirstSync<{ id: string }>('SELECT id FROM personas ORDER BY is_active DESC, rowid LIMIT 1');
      if (active) {
        db.runSync('UPDATE personas SET is_active = CASE WHEN id = ? THEN 1 ELSE 0 END', [active.id]);
        db.runSync('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          ['_companion_persona_id', JSON.stringify(active.id)]);
      }
      db.execSync('CREATE UNIQUE INDEX IF NOT EXISTS personas_one_active ON personas(is_active) WHERE is_active = 1');
    }
    if (version < 4) {
      db.execSync(`ALTER TABLE models ADD COLUMN thinking_mode TEXT NOT NULL DEFAULT 'off'
        CHECK (thinking_mode IN ('off','official','instruction','persona'));
        ALTER TABLE models ADD COLUMN thinking_config TEXT;
        ALTER TABLE messages ADD COLUMN thinking_mode TEXT
        CHECK (thinking_mode IS NULL OR thinking_mode IN ('off','official','instruction','persona'));
        ALTER TABLE cot_presets ADD COLUMN kind TEXT NOT NULL DEFAULT 'persona'
        CHECK (kind IN ('official','instruction','persona','unclassified'));`);
      migrateThinkingRows(db);
    }
    if (version < 5) db.execSync('ALTER TABLE personas ADD COLUMN role_config TEXT');
    db.execSync('PRAGMA user_version = 5');
  });
}
