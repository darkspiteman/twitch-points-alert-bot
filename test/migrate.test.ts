import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db.ts';
import { legacyDataDirs, migrateLegacyData, inspectDataDir } from '../src/migrate.ts';
import { tmpDir } from './helpers.ts';

/** Папка данных «как у прежней версии». */
function makeLegacy(dir: string, opts: { clientId?: string; rewards?: number; tokens?: boolean; media?: boolean }) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new Db(path.join(dir, 'bot.sqlite'));
  if (opts.clientId) db.updateSettings({ clientId: opts.clientId });
  for (let i = 0; i < (opts.rewards ?? 0); i++) db.insertLocalReward(`local-${i}`, `Награда ${i}`, 100);
  db.close(); // WAL остаётся рядом — как при аварийном завершении
  if (opts.tokens) fs.writeFileSync(path.join(dir, 'tokens.dpapi'), 'encrypted');
  if (opts.media) { fs.mkdirSync(path.join(dir, 'media')); fs.writeFileSync(path.join(dir, 'media', 'a.mp3'), 'ID3data'); }
}

test('находит копию данных в виртуализированной папке Packages\…\LocalCache', () => {
  const local = tmpDir();
  makeLegacy(path.join(local, 'TwitchAlertBot'), {});
  makeLegacy(path.join(local, 'Packages', 'Claude_x', 'LocalCache', 'Local', 'TwitchAlertBot'), { clientId: 'abc' });
  const dirs = legacyDataDirs(local);
  assert.equal(dirs.length, 2);
  assert.ok(dirs.some((d) => d.includes('LocalCache')));
});

test('переносит самую полную копию (Client ID, вход, награды, медиа), пустую новую — игнорирует', () => {
  const local = tmpDir();
  const fresh = path.join(local, 'TwitchAlertBot');
  const full = path.join(local, 'Packages', 'Claude_x', 'LocalCache', 'Local', 'TwitchAlertBot');
  makeLegacy(fresh, {}); // пустая база, созданная после перезагрузки
  makeLegacy(full, { clientId: 'abcdefghijklmnopqrstuvwxyz0123', rewards: 3, tokens: true, media: true });
  assert.ok(inspectDataDir(full)!.score > inspectDataDir(fresh)!.score);
  const target = path.join(tmpDir(), 'data');
  const r = migrateLegacyData(target, legacyDataDirs(local));
  assert.ok(r);
  assert.equal(r!.from.dir, full);
  const db = new Db(path.join(target, 'bot.sqlite'));
  assert.equal(db.getSettings().clientId, 'abcdefghijklmnopqrstuvwxyz0123');
  assert.equal(db.listRewards().length, 3);
  db.close();
  assert.ok(fs.existsSync(path.join(target, 'tokens.dpapi')));
  assert.ok(fs.existsSync(path.join(target, 'media', 'a.mp3')));
  assert.ok(fs.existsSync(path.join(full, 'bot.sqlite')), 'исходные данные не удаляются');
});

test('повторно не переносит, если в новой папке уже есть база', () => {
  const local = tmpDir();
  makeLegacy(path.join(local, 'TwitchAlertBot'), { clientId: 'old', rewards: 1 });
  const target = path.join(tmpDir(), 'data');
  makeLegacy(target, { clientId: 'current' });
  assert.equal(migrateLegacyData(target, legacyDataDirs(local)), null);
  const db = new Db(path.join(target, 'bot.sqlite'));
  assert.equal(db.getSettings().clientId, 'current');
  db.close();
});

test('нет старых данных — ничего не делает', () => {
  assert.equal(migrateLegacyData(path.join(tmpDir(), 'data'), legacyDataDirs(tmpDir())), null);
});

test('1.5.0: предел длительности 60 с (старое значение по умолчанию) поднимается до 5 минут один раз, своё значение не трогается', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'bot.sqlite');
  let db = new Db(file);
  assert.equal(db.getSettings().maxDurationMs, 300000, 'новая установка — 5 минут');
  db.updateSettings({ maxDurationMs: 60000 });
  db.raw.prepare(`DELETE FROM meta WHERE key = 'max_duration_5min'`).run(); // как база версии 1.4
  db.close();
  db = new Db(file);
  assert.equal(db.getSettings().maxDurationMs, 300000);
  db.updateSettings({ maxDurationMs: 60000 }); // пользователь сам вернул 60 с — больше не трогаем
  db.close();
  db = new Db(file);
  assert.equal(db.getSettings().maxDurationMs, 60000);
  db.close();
  const dir2 = tmpDir();
  db = new Db(path.join(dir2, 'bot.sqlite'));
  db.updateSettings({ maxDurationMs: 90000 });
  db.raw.prepare(`DELETE FROM meta WHERE key = 'max_duration_5min'`).run();
  db.close();
  db = new Db(path.join(dir2, 'bot.sqlite'));
  assert.equal(db.getSettings().maxDurationMs, 90000);
  db.close();
});
