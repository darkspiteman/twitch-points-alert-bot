import { DatabaseSync } from 'node:sqlite';
import { defaultSettings, type Settings } from './config.ts';

export interface RewardRow {
  id: string;
  title: string;
  cost: number;
  prompt: string;
  manageable: number;
  twitch_enabled: number;
  background_color: string;
  deleted: number;
  bot_enabled: number;
  media_id: string | null;
  sound_id: string | null;
  /** Видео/GIF/картинка для режима «с видео». */
  video_id: string | null;
  /** 'video' — показывать видео (если назначено), 'audio' — только звук. */
  play_mode: 'video' | 'audio';
  /** Убирать зелёный фон у видео (хромакей). */
  chroma_key: number;
  volume: number;
  duration_ms: number;
  delay_ms: number;
  cooldown_sec: number;
  show_caption: number;
  raw: string;
  created_by_bot: number;
  updated_at: number;
}

export interface MediaRow {
  id: string;
  name: string;
  file_name: string;
  kind: 'audio' | 'video' | 'image';
  mime: string;
  size: number;
  duration_ms: number;
  status: 'ok' | 'warning' | 'broken';
  status_msg: string;
  created_at: number;
  /** Откуда файл: 'upload' (загружен), 'url' (по ссылке), 'freesound', 'klipy' (онлайн, без копии на диске). */
  source: 'upload' | 'url' | 'freesound' | 'klipy';
  /** Для онлайн-медиа: «тип/slug» в Klipy (например, «clips/they-love-me»). */
  remote_ref: string;
  /** Автор и лицензия (Freesound) или источник. */
  attribution: string;
  /** Страница источника (для подписи/проверки лицензии). */
  source_url: string;
}

export interface RedemptionRow {
  id: string;
  reward_id: string;
  reward_title: string;
  user_login: string;
  user_name: string;
  user_input: string;
  redeemed_at: string;
  received_at: number;
  source: string;
  status: string;
  status_msg: string;
}

export interface EventRow { id: number; ts: number; level: string; type: string; message: string }

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rewards (
     id TEXT PRIMARY KEY, title TEXT NOT NULL, cost INTEGER NOT NULL DEFAULT 0, prompt TEXT NOT NULL DEFAULT '',
     manageable INTEGER NOT NULL DEFAULT 0, twitch_enabled INTEGER NOT NULL DEFAULT 1, background_color TEXT NOT NULL DEFAULT '',
     deleted INTEGER NOT NULL DEFAULT 0, bot_enabled INTEGER NOT NULL DEFAULT 0,
     media_id TEXT, sound_id TEXT, volume INTEGER NOT NULL DEFAULT 100, duration_ms INTEGER NOT NULL DEFAULT 0,
     delay_ms INTEGER NOT NULL DEFAULT 0, cooldown_sec INTEGER NOT NULL DEFAULT 0, show_caption INTEGER NOT NULL DEFAULT 1,
     raw TEXT NOT NULL DEFAULT '{}', created_by_bot INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS media (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, file_name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, mime TEXT NOT NULL,
     size INTEGER NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ok',
     status_msg TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS redemptions (
     id TEXT PRIMARY KEY, reward_id TEXT NOT NULL, reward_title TEXT NOT NULL DEFAULT '', user_login TEXT NOT NULL DEFAULT '',
     user_name TEXT NOT NULL DEFAULT '', user_input TEXT NOT NULL DEFAULT '', redeemed_at TEXT NOT NULL DEFAULT '',
     received_at INTEGER NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, status_msg TEXT NOT NULL DEFAULT '')`,
  `CREATE INDEX IF NOT EXISTS idx_redemptions_received ON redemptions(received_at)`,
  `CREATE TABLE IF NOT EXISTS seen_messages (message_id TEXT PRIMARY KEY, ts INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)`,
];

export class Db {
  readonly raw: DatabaseSync;
  private settingsCache: Settings | null = null;

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    for (const s of SCHEMA) this.raw.exec(s);
    this.raw.prepare(`INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1')`).run();
    this.migrate();
  }

  /** Миграции схемы для уже существующих баз. */
  private migrate(): void {
    const cols = (this.raw.prepare('PRAGMA table_info(rewards)').all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('video_id')) this.raw.exec('ALTER TABLE rewards ADD COLUMN video_id TEXT');
    if (!cols.includes('chroma_key')) this.raw.exec('ALTER TABLE rewards ADD COLUMN chroma_key INTEGER NOT NULL DEFAULT 0');
    if (!cols.includes('play_mode')) this.raw.exec("ALTER TABLE rewards ADD COLUMN play_mode TEXT NOT NULL DEFAULT 'video'");
    const mcols = (this.raw.prepare('PRAGMA table_info(media)').all() as { name: string }[]).map((c) => c.name);
    if (!mcols.includes('source')) this.raw.exec("ALTER TABLE media ADD COLUMN source TEXT NOT NULL DEFAULT 'upload'");
    if (!mcols.includes('remote_ref')) this.raw.exec("ALTER TABLE media ADD COLUMN remote_ref TEXT NOT NULL DEFAULT ''");
    if (!mcols.includes('attribution')) this.raw.exec("ALTER TABLE media ADD COLUMN attribution TEXT NOT NULL DEFAULT ''");
    if (!mcols.includes('source_url')) this.raw.exec("ALTER TABLE media ADD COLUMN source_url TEXT NOT NULL DEFAULT ''");
    this.setMeta('schema_version', '3');
  }

  close(): void {
    try { this.raw.close(); } catch { /* уже закрыта */ }
  }

  // ---------- настройки ----------
  getSettings(): Settings {
    if (this.settingsCache) return { ...this.settingsCache };
    const s = defaultSettings() as unknown as Record<string, unknown>;
    for (const row of this.raw.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]) {
      if (row.key in s) { try { s[row.key] = JSON.parse(row.value); } catch { /* испорченное значение → по умолчанию */ } }
    }
    this.settingsCache = s as unknown as Settings;
    return { ...this.settingsCache };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const stmt = this.raw.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(patch)) stmt.run(k, JSON.stringify(v));
    this.settingsCache = null;
    return this.getSettings();
  }

  getMeta(key: string): string | null {
    const r = this.raw.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? r.value : null;
  }
  setMeta(key: string, value: string): void {
    this.raw.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---------- награды ----------
  listRewards(includeDeleted = false): RewardRow[] {
    const sql = includeDeleted ? 'SELECT * FROM rewards ORDER BY deleted, cost, title' : 'SELECT * FROM rewards WHERE deleted = 0 ORDER BY cost, title';
    return this.raw.prepare(sql).all() as unknown as RewardRow[];
  }
  getReward(id: string): RewardRow | undefined {
    return this.raw.prepare('SELECT * FROM rewards WHERE id = ?').get(id) as unknown as RewardRow | undefined;
  }

  /** Синхронизация с Twitch: обновляет данные Twitch, не трогая настройки бота. Новые награды — выключены в боте. */
  upsertTwitchReward(r: { id: string; title: string; cost: number; prompt: string; manageable: boolean; is_enabled: boolean; background_color: string; raw: unknown }): void {
    this.raw.prepare(`INSERT INTO rewards(id, title, cost, prompt, manageable, twitch_enabled, background_color, deleted, raw, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, cost = excluded.cost, prompt = excluded.prompt, manageable = excluded.manageable,
        twitch_enabled = excluded.twitch_enabled, background_color = excluded.background_color, deleted = 0, raw = excluded.raw, updated_at = excluded.updated_at`)
      .run(r.id, r.title, r.cost, r.prompt, r.manageable ? 1 : 0, r.is_enabled ? 1 : 0, r.background_color, JSON.stringify(r.raw), Date.now());
  }

  markRewardsDeletedExcept(ids: string[]): void {
    const all = this.raw.prepare('SELECT id FROM rewards WHERE deleted = 0').all() as { id: string }[];
    const keep = new Set(ids);
    const stmt = this.raw.prepare('UPDATE rewards SET deleted = 1, updated_at = ? WHERE id = ?');
    for (const r of all) if (!keep.has(r.id)) stmt.run(Date.now(), r.id);
  }

  updateRewardConfig(id: string, cfg: Partial<Pick<RewardRow, 'bot_enabled' | 'media_id' | 'sound_id' | 'video_id' | 'play_mode' | 'chroma_key' | 'volume' | 'duration_ms' | 'delay_ms' | 'cooldown_sec' | 'show_caption' | 'created_by_bot'>>): RewardRow | undefined {
    const allowed = ['bot_enabled', 'media_id', 'sound_id', 'video_id', 'play_mode', 'chroma_key', 'volume', 'duration_ms', 'delay_ms', 'cooldown_sec', 'show_caption', 'created_by_bot'];
    const keys = Object.keys(cfg).filter((k) => allowed.includes(k));
    if (keys.length) {
      const sql = `UPDATE rewards SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
      this.raw.prepare(sql).run(...keys.map((k) => (cfg as Record<string, string | number | null>)[k]), Date.now(), id);
    }
    return this.getReward(id);
  }

  /** Тестовая/ручная награда (например, для режима тестирования без Twitch). */
  insertLocalReward(id: string, title: string, cost: number): void {
    this.raw.prepare(`INSERT OR IGNORE INTO rewards(id, title, cost, manageable, raw, updated_at) VALUES (?, ?, ?, 0, '{}', ?)`).run(id, title, cost, Date.now());
  }

  // ---------- медиа ----------
  listMedia(): MediaRow[] { return this.raw.prepare('SELECT * FROM media ORDER BY created_at DESC').all() as unknown as MediaRow[]; }
  getMedia(id: string): MediaRow | undefined { return this.raw.prepare('SELECT * FROM media WHERE id = ?').get(id) as unknown as MediaRow | undefined; }
  insertMedia(m: MediaRow): void {
    this.raw.prepare(`INSERT INTO media(id, name, file_name, kind, mime, size, duration_ms, status, status_msg, created_at, source, remote_ref, attribution, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(m.id, m.name, m.file_name, m.kind, m.mime, m.size, m.duration_ms, m.status, m.status_msg, m.created_at, m.source ?? 'upload', m.remote_ref ?? '', m.attribution ?? '', m.source_url ?? '');
  }
  updateMediaStatus(id: string, status: MediaRow['status'], msg: string, durationMs?: number): void {
    if (durationMs !== undefined) this.raw.prepare('UPDATE media SET status = ?, status_msg = ?, duration_ms = ? WHERE id = ?').run(status, msg, Math.round(durationMs), id);
    else this.raw.prepare('UPDATE media SET status = ?, status_msg = ? WHERE id = ?').run(status, msg, id);
  }
  renameMedia(id: string, name: string): void { this.raw.prepare('UPDATE media SET name = ? WHERE id = ?').run(name, id); }
  deleteMedia(id: string): void { this.raw.prepare('DELETE FROM media WHERE id = ?').run(id); }
  mediaUsage(id: string): RewardRow[] {
    return this.raw.prepare('SELECT * FROM rewards WHERE deleted = 0 AND (media_id = ? OR sound_id = ? OR video_id = ?)').all(id, id, id) as unknown as RewardRow[];
  }

  // ---------- дедупликация ----------
  /** true — сообщение новое (и теперь запомнено); false — уже было. */
  markMessageSeen(messageId: string): boolean {
    const r = this.raw.prepare('INSERT OR IGNORE INTO seen_messages(message_id, ts) VALUES (?, ?)').run(messageId, Date.now());
    return Number(r.changes) > 0;
  }

  /** true — погашение новое (запись создана); false — дубликат. */
  insertRedemption(r: Omit<RedemptionRow, 'status_msg'> & { status_msg?: string }): boolean {
    const res = this.raw.prepare(`INSERT OR IGNORE INTO redemptions(id, reward_id, reward_title, user_login, user_name, user_input, redeemed_at, received_at, source, status, status_msg)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.id, r.reward_id, r.reward_title, r.user_login, r.user_name, r.user_input, r.redeemed_at, r.received_at, r.source, r.status, r.status_msg ?? '');
    return Number(res.changes) > 0;
  }
  hasRedemption(id: string): boolean { return !!this.raw.prepare('SELECT 1 FROM redemptions WHERE id = ?').get(id); }
  setRedemptionStatus(id: string, status: string, msg = ''): void {
    this.raw.prepare('UPDATE redemptions SET status = ?, status_msg = ? WHERE id = ?').run(status, msg, id);
  }
  recentRedemptions(limit = 50): RedemptionRow[] {
    return this.raw.prepare('SELECT * FROM redemptions ORDER BY received_at DESC LIMIT ?').all(limit) as unknown as RedemptionRow[];
  }
  lastUserRedemption(userLogin: string, sinceMs: number): RedemptionRow | undefined {
    return this.raw.prepare(`SELECT * FROM redemptions WHERE user_login = ? AND received_at >= ? AND status IN ('queued','playing','done') AND source != 'test' ORDER BY received_at DESC LIMIT 1`)
      .get(userLogin, sinceMs) as unknown as RedemptionRow | undefined;
  }
  /** При старте: всё, что осталось «в очереди» после прошлого запуска, — не воспроизводить. */
  dropStaleQueue(): number {
    const r = this.raw.prepare(`UPDATE redemptions SET status = 'dropped', status_msg = 'Отменено: приложение было перезапущено' WHERE status IN ('queued','playing')`).run();
    return Number(r.changes);
  }

  // ---------- журнал ----------
  addEvent(level: string, type: string, message: string): EventRow {
    const ts = Date.now();
    const r = this.raw.prepare('INSERT INTO events(ts, level, type, message) VALUES (?, ?, ?, ?)').run(ts, level, type, message);
    return { id: Number(r.lastInsertRowid), ts, level, type, message };
  }
  recentEvents(limit = 100): EventRow[] {
    return this.raw.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as unknown as EventRow[];
  }

  cleanup(retentionDays: number): void {
    const cutoff = Date.now() - retentionDays * 86400_000;
    this.raw.prepare('DELETE FROM seen_messages WHERE ts < ?').run(Date.now() - 7 * 86400_000);
    this.raw.prepare('DELETE FROM redemptions WHERE received_at < ?').run(cutoff);
    this.raw.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
  }
}
