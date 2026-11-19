import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Db, RewardRow, MediaRow } from './db.ts';
import { isRemote, type MediaLibrary } from './media.ts';
import type { PlaybackQueue, PlayItem, MediaRef, ItemResult } from './queue.ts';
import type { EventSubMessage } from './twitch/eventsub.ts';
import type { HelixClient } from './twitch/helix.ts';
import type { ScopedLogger } from './logger.ts';
import { tr, effectiveLang } from './i18n.ts';
import { ttsText } from './tts.ts';

export const REDEMPTION_TYPE = 'channel.channel_points_custom_reward_redemption.add';
export const REDEMPTION_VERSION = '1';

export interface RedemptionEvent {
  id: string;
  broadcaster_user_id?: string;
  user_id?: string;
  user_login: string;
  user_name: string;
  user_input: string;
  status?: string;
  reward: { id: string; title: string; cost: number; prompt?: string };
  redeemed_at: string;
}

export type HandleResult = 'duplicate' | 'ignored' | 'observed' | 'queued' | 'skipped' | 'failed' | 'missed' | 'wrong_type';

export interface RouterDeps {
  db: Db;
  media: MediaLibrary;
  queue: PlaybackQueue;
  log: ScopedLogger;
  helix: () => HelixClient | null;
  broadcasterId: () => string | null;
  journal: (level: 'info' | 'warn' | 'error', type: string, message: string) => void;
}

/**
 * Обработка погашений: дедупликация, фильтры (включена ли награда, режим, антиспам),
 * постановка в очередь, восстановление пропущенных событий после разрыва.
 */
/** Почему файл не будет показан: нет на диске, не распознан или не воспроизводится (с причиной). */
function unplayable(m: MediaRow): string {
  if (m.status === 'broken' && m.status_msg && !m.status_msg.startsWith('Файл')) return `Файл «${m.name}» не воспроизводится: ${m.status_msg}`;
  if (m.status === 'broken' && m.status_msg) return `«${m.name}»: ${m.status_msg}`;
  return `Файл «${m.name}» отсутствует на диске`;
}

export class RedemptionRouter extends EventEmitter {
  private d: RouterDeps;
  /** Статусы событий Twitch по redemption id — нужны для FULFILLED/CANCELED. */
  private twitchStatus = new Map<string, string>();

  constructor(deps: RouterDeps) {
    super();
    this.d = deps;
    deps.queue.on('finished', (e: { item: PlayItem; result: ItemResult; message: string }) => this.onFinished(e));
    deps.queue.on('started', (item: PlayItem) => { if (item.redemptionId) deps.db.setRedemptionStatus(item.redemptionId, 'playing'); });
  }

  /** Сообщение EventSub типа notification. */
  handleNotification(msg: EventSubMessage): HandleResult {
    const md = msg.metadata;
    if (md.subscription_type !== REDEMPTION_TYPE) return 'wrong_type';
    if (!md.message_id || !this.d.db.markMessageSeen(md.message_id)) {
      this.d.log.info(`Повторная доставка сообщения EventSub ${md.message_id} — пропущено`);
      return 'duplicate';
    }
    const ev = msg.payload.event as unknown as RedemptionEvent | undefined;
    if (!ev?.id || !ev.reward?.id) { this.d.log.warn('Уведомление без данных о погашении'); return 'ignored'; }
    const bid = this.d.broadcasterId();
    if (bid && ev.broadcaster_user_id && ev.broadcaster_user_id !== bid) { this.d.log.warn('Событие для чужого канала — пропущено'); return 'ignored'; }
    return this.handleRedemption(ev, md.subscription_type === REDEMPTION_TYPE ? 'eventsub' : 'eventsub');
  }

  handleRedemption(ev: RedemptionEvent, source: 'eventsub' | 'recovery' | 'simulate'): HandleResult {
    const db = this.d.db;
    const s = db.getSettings();
    const inserted = db.insertRedemption({
      id: ev.id, reward_id: ev.reward.id, reward_title: ev.reward.title, user_login: ev.user_login ?? '', user_name: ev.user_name ?? ev.user_login ?? '',
      user_input: ev.user_input ?? '', redeemed_at: ev.redeemed_at ?? new Date().toISOString(), received_at: Date.now(), source, status: 'received',
    });
    if (!inserted) {
      this.d.log.info(`Погашение ${ev.id} уже обработано — повтор пропущен`);
      return 'duplicate';
    }
    if (ev.status) this.twitchStatus.set(ev.id, ev.status);
    const who = ev.user_name || ev.user_login || 'зритель';
    const set = (status: string, msg: string): void => { db.setRedemptionStatus(ev.id, status, msg); this.emit('redemption', { id: ev.id, status, msg }); };

    let reward = db.getReward(ev.reward.id);
    if (!reward) {
      // Новая награда, которой ещё нет в базе: запоминаем (выключенной в боте).
      db.upsertTwitchReward({ id: ev.reward.id, title: ev.reward.title, cost: ev.reward.cost, prompt: ev.reward.prompt ?? '', manageable: false, is_enabled: true, background_color: '', raw: {} });
      reward = db.getReward(ev.reward.id)!;
      this.d.journal('info', 'reward', `Новая награда «${ev.reward.title}» добавлена в список. Настройте её в разделе «Награды».`);
    }
    const redeemedAt = Date.parse(ev.redeemed_at);
    if (Number.isFinite(redeemedAt) && Date.now() - redeemedAt > s.maxItemAgeSec * 1000) {
      set('missed', `Погашение устарело (старше ${s.maxItemAgeSec} с) — не воспроизводится`);
      this.d.journal('warn', 'missed', `Не воспроизведено (устарело): «${reward.title}» от ${who}`);
      this.maybeCancel(reward, ev.id);
      return 'missed';
    }
    if (!reward.bot_enabled) { set('ignored', 'Награда выключена в боте'); this.d.journal('info', 'redemption', `«${reward.title}» от ${who} — награда выключена в боте`); return 'ignored'; }
    if (s.mode === 'observe') { set('observed', 'Режим наблюдения: без воспроизведения'); this.d.journal('info', 'redemption', `«${reward.title}» от ${who} (режим наблюдения)`); return 'observed'; }

    // Антиспам: кулдаун на пользователя (общий и для конкретной награды).
    const login = ev.user_login || ev.user_id || '';
    if (login && source !== 'simulate') {
      const cds: Array<[number, string | null]> = [[s.userCooldownSec, null], [reward.cooldown_sec, reward.id]];
      for (const [sec, rid] of cds) {
        if (sec <= 0) continue;
        const last = this.lastByUser(login, Date.now() - sec * 1000, rid, ev.id);
        if (last) {
          set('skipped', `Антиспам: ${who} активировал(а) награду менее ${sec} с назад`);
          this.d.journal('warn', 'spam', `«${reward.title}» от ${who} пропущено (антиспам)`);
          this.maybeCancel(reward, ev.id);
          return 'skipped';
        }
      }
    }

    const built = this.buildItem(reward, { id: ev.id, userName: who, userInput: ev.user_input ?? '', source });
    if ('error' in built) {
      set('failed', built.error);
      this.d.journal('error', 'media', `«${reward.title}»: ${built.error}`);
      this.maybeCancel(reward, ev.id);
      return 'failed';
    }
    const r = this.d.queue.enqueue(built.item);
    if (!r.ok) {
      set('skipped', r.reason);
      this.d.journal('warn', 'queue', `«${reward.title}» от ${who}: ${r.reason}`);
      this.maybeCancel(reward, ev.id);
      return 'skipped';
    }
    set('queued', '');
    this.d.journal('info', 'redemption', `«${reward.title}» от ${who}${source === 'recovery' ? ' (восстановлено после разрыва)' : ''}`);
    return 'queued';
  }

  private lastByUser(login: string, since: number, rewardId: string | null, exceptId: string): boolean {
    const rows = this.d.db.raw.prepare(
      `SELECT id FROM redemptions WHERE (user_login = ? ) AND received_at >= ? AND status IN ('queued','playing','done') AND id != ? ${rewardId ? 'AND reward_id = ?' : ''} LIMIT 1`,
    ).all(...([login, since, exceptId, ...(rewardId ? [rewardId] : [])] as string[]));
    return rows.length > 0;
  }

  /** Текст тестовых оповещений (видят стример и зрители) — на языке панели. */
  private t(text: string): string { return tr(text, effectiveLang(this.d.db.getSettings().language)); }

  /** Тест награды без Twitch и без списания баллов. Игнорирует режим наблюдения и антиспам. */
  test(rewardId: string): { ok: boolean; error?: string } {
    const reward = this.d.db.getReward(rewardId);
    if (!reward) return { ok: false, error: 'Награда не найдена' };
    const built = this.buildItem(reward, { id: `test-${crypto.randomUUID()}`, userName: this.t('Тест'), userInput: '', source: 'test' });
    if ('error' in built) return { ok: false, error: built.error };
    built.item.redemptionId = null;
    const r = this.d.queue.enqueue(built.item);
    if (!r.ok) return { ok: false, error: r.reason };
    this.d.journal('info', 'test', `Тест: «${reward.title}»`);
    return { ok: true };
  }

  /** Встроенный тест overlay: картинка + звук, без медиатеки и без Twitch. */
  testBuiltin(): { ok: boolean; error?: string } {
    const item: PlayItem = {
      id: `test-${crypto.randomUUID()}`, redemptionId: null, rewardId: '', rewardTitle: this.t('Встроенный тест'), userName: this.t('Тест'), userInput: '',
      visual: { id: 'builtin-svg', url: effectiveLang(this.d.db.getSettings().language) === 'en' ? '/overlay/test-alert-en.svg' : '/overlay/test-alert.svg', kind: 'image', mime: 'image/svg+xml' },
      audio: { id: 'builtin-wav', url: '/overlay/test-chime.wav', kind: 'audio', mime: 'audio/wav' },
      volume: 1, durationMs: 3000, delayMs: 0, caption: this.t('Тест: оверлей работает!'), source: 'test', createdAt: Date.now(),
    };
    const r = this.d.queue.enqueue(item);
    if (r.ok) this.d.journal('info', 'test', 'Встроенный тест оповещения');
    return r.ok ? { ok: true } : { ok: false, error: r.reason };
  }

  /** Тест медиафайла без награды. */
  testMedia(media: MediaRow, volume = 100): { ok: boolean; error?: string } {
    const ref = this.ref(media);
    if (!ref) return { ok: false, error: unplayable(media) };
    const item: PlayItem = {
      id: `test-${crypto.randomUUID()}`, redemptionId: null, rewardId: '', rewardTitle: this.t(`Файл: ${media.name}`), userName: this.t('Тест'), userInput: '',
      visual: media.kind === 'audio' ? null : ref, audio: media.kind === 'audio' ? ref : null, volume: volume / 100, durationMs: 0, delayMs: 0,
      caption: null, source: 'test', createdAt: Date.now(),
    };
    const r = this.d.queue.enqueue(item);
    return r.ok ? { ok: true } : { ok: false, error: r.reason };
  }

  private ref(m: MediaRow | undefined): MediaRef | null {
    if (!m || !this.d.media.exists(m) || m.status === 'broken') return null;
    if (isRemote(m)) return { id: m.id, url: '', kind: m.kind, mime: m.mime, remote: m.remote_ref };
    return { id: m.id, url: `/media/${m.id}`, kind: m.kind, mime: m.mime };
  }

  private buildItem(reward: RewardRow, ctx: { id: string; userName: string; userInput: string; source: PlayItem['source'] }): { item: PlayItem } | { error: string } {
    const s = this.d.db.getSettings();
    // Озвучка текста зрителя (у теста — пример текста).
    const input = ctx.userInput.trim() || (ctx.source === 'test' ? this.t('Это проверка озвучки текста зрителя') : '');
    const speech = reward.tts === 1 && input
      ? ttsText(ctx.userName, input, { template: s.ttsTemplate, maxChars: s.ttsMaxChars, filter: s.ttsFilter, bannedWords: s.ttsBannedWords })
      : '';
    const noMedia = !reward.media_id && !reward.video_id && !reward.sound_id;
    if (noMedia && !speech) return { error: reward.tts === 1 ? 'Зритель не написал текст для озвучки, а медиафайл для награды не выбран' : 'Для награды не выбран медиафайл' };
    const load = (id: string | null, label: string): { ref: MediaRef | null; err: string | null } => {
      if (!id) return { ref: null, err: null };
      const m = this.d.db.getMedia(id);
      if (!m) return { ref: null, err: `${label} удалён(о) из медиатеки` };
      const r = this.ref(m);
      return r ? { ref: r, err: null } : { ref: null, err: unplayable(m) };
    };
    const main = load(reward.media_id, 'Основной файл');
    const video = load(reward.video_id, 'Видео');
    const extra = load(reward.sound_id, 'Дополнительный звук');
    /** Звуковая дорожка видеофайла, проигрываемая без картинки. */
    const asAudio = (r: MediaRef | null): MediaRef | null => (r && r.kind === 'video' ? { ...r, kind: 'audio' } : null);

    let visual: MediaRef | null = null;
    let audio: MediaRef | null = null;
    const wantVisual = reward.play_mode !== 'audio' && !s.audioOnly;
    if (wantVisual) {
      const vis = video.ref ?? (main.ref && main.ref.kind !== 'audio' ? main.ref : null);
      if (vis) {
        visual = vis;
        // У видео свой звук; к картинке/GIF — назначенный звук.
        audio = vis.kind === 'video' ? extra.ref : (extra.ref ?? (main.ref?.kind === 'audio' ? main.ref : null));
      } else if (video.err) {
        this.d.journal('warn', 'media', `«${reward.title}»: ${video.err} — воспроизводится только звук`);
      }
    }
    if (!visual) {
      audio = (main.ref?.kind === 'audio' ? main.ref : null) ?? extra.ref ?? asAudio(main.ref) ?? asAudio(video.ref);
    }
    if (!visual && !audio && !speech) return { error: main.err ?? video.err ?? extra.err ?? 'Нет подходящего файла для выбранного режима' };
    if (!visual && !audio && !noMedia) this.d.journal('warn', 'media', `«${reward.title}»: ${main.err ?? video.err ?? extra.err ?? 'файл недоступен'} — только озвучка`);
    // Онлайн-медиа может не загрузиться (нет интернета, сбой сервиса) — тогда сыграет локальный звук награды.
    const localAudio = (r: MediaRef | null) => (r && !r.remote && r.kind === 'audio' ? r : null);
    const fallbackAudio = visual?.remote || audio?.remote
      ? localAudio(main.ref) ?? (audio === extra.ref ? null : localAudio(extra.ref)) ?? null
      : null;
    const showCaption = s.showCaption && reward.show_caption === 1;
    const caption = showCaption
      ? s.captionTemplate.replaceAll('{user}', ctx.userName).replaceAll('{reward}', reward.title).replaceAll('{input}', ctx.userInput).replaceAll('{cost}', String(reward.cost)).trim()
      : null;
    return {
      item: {
        id: ctx.id, redemptionId: ctx.source === 'test' ? null : ctx.id, rewardId: reward.id, rewardTitle: reward.title, userName: ctx.userName,
        userInput: ctx.userInput, visual, audio, volume: Math.max(0, Math.min(100, reward.volume)) / 100, durationMs: reward.duration_ms,
        delayMs: reward.delay_ms, caption: caption || null, chromaKey: reward.chroma_key === 1 && visual?.kind === 'video' && !visual.remote,
        fallbackAudio, ttsText: speech || null, source: ctx.source, createdAt: Date.now(),
      },
    };
  }

  private onFinished(e: { item: PlayItem; result: ItemResult; message: string }): void {
    const { item, result, message } = e;
    if (result === 'failed') {
      this.d.journal('error', 'playback', `«${item.rewardTitle}»: ${message}`);
      const m = item.visual ?? item.audio;
      if (m && !m.remote && /декод|decode|не поддерж|MEDIA_ERR|повреж/i.test(message)) {
        const row = this.d.db.getMedia(m.id);
        const fix = row && row.kind !== 'image' ? ' Нажмите «Перекодировать» у файла в разделе «Медиа».' : '';
        this.d.db.updateMediaStatus(m.id, 'broken', `Не воспроизводится в программе для стрима: ${message.replace(/^Ошибка воспроизведения: /, '')}.${fix}`);
        if (fix) this.d.journal('warn', 'media', `«${row!.name}» не воспроизводится в программе для стрима.${fix}`);
      }
    }
    if (!item.redemptionId) return;
    const status = result === 'done' ? 'done' : result;
    this.d.db.setRedemptionStatus(item.redemptionId, status, message);
    this.emit('redemption', { id: item.redemptionId, status, msg: message });
    const reward = this.d.db.getReward(item.rewardId);
    if (!reward) return;
    if (result === 'done') this.maybeFulfill(reward, item.redemptionId);
    else this.maybeCancel(reward, item.redemptionId);
  }

  private maybeUpdateStatus(reward: RewardRow, redemptionId: string, status: 'FULFILLED' | 'CANCELED'): void {
    const s = this.d.db.getSettings();
    if (!s.manageRedemptionStatus || !reward.manageable) return;
    if (this.twitchStatus.get(redemptionId) !== 'unfulfilled') return;
    this.twitchStatus.delete(redemptionId);
    const helix = this.d.helix();
    const bid = this.d.broadcasterId();
    if (!helix || !bid) return;
    helix.request('PATCH', '/channel_points/custom_rewards/redemptions', { id: redemptionId, broadcaster_id: bid, reward_id: reward.id }, { status })
      .then(() => {
        if (status === 'CANCELED') this.d.journal('info', 'refund', `Баллы за «${reward.title}» возвращены зрителю`);
      })
      .catch((e: Error) => this.d.log.warn(`Не удалось изменить статус погашения на ${status}`, e));
  }
  private maybeFulfill(reward: RewardRow, id: string): void { this.maybeUpdateStatus(reward, id, 'FULFILLED'); }
  private maybeCancel(reward: RewardRow, id: string): void { this.maybeUpdateStatus(reward, id, 'CANCELED'); }

  /**
   * Восстановление после разрыва EventSub. Twitch не переотправляет пропущенные события.
   * Для своих наград (созданных этим ботом) запрашиваем список погашений через Helix.
   * Для наград других приложений (Sound Alerts) это запрещено API — только запись в журнал.
   */
  async recoverGap(gapStartedAt: number, gapEndedAt: number): Promise<{ recovered: number; unrecoverable: string[] }> {
    const db = this.d.db;
    const s = db.getSettings();
    const fmt = (t: number) => new Date(t).toLocaleTimeString('ru-RU');
    const seconds = Math.round((gapEndedAt - gapStartedAt) / 1000);
    const enabled = db.listRewards().filter((r) => r.bot_enabled);
    const unrecoverable = enabled.filter((r) => !r.manageable).map((r) => r.title);
    let recovered = 0;
    const helix = this.d.helix();
    const bid = this.d.broadcasterId();
    if (s.recoverMissed && helix && bid) {
      for (const reward of enabled.filter((r) => r.manageable)) {
        for (const status of ['UNFULFILLED', 'FULFILLED'] as const) {
          try {
            const list = await helix.getRedemptions(bid, reward.id, status, 50);
            for (const r of list) {
              const t = Date.parse(r.redeemed_at);
              if (!(t >= gapStartedAt - 5000 && t <= gapEndedAt + 2000)) continue;
              if (db.hasRedemption(r.id)) continue;
              const res = this.handleRedemption({ id: r.id, user_id: r.user_id, user_login: r.user_login, user_name: r.user_name, user_input: r.user_input, status: r.status.toLowerCase(), reward: r.reward, redeemed_at: r.redeemed_at }, 'recovery');
              if (res === 'queued' || res === 'missed' || res === 'observed') recovered++;
            }
          } catch (e) {
            this.d.log.warn(`Не удалось получить погашения награды «${reward.title}» для восстановления`, e);
          }
        }
      }
    }
    if (seconds >= 1 || recovered || unrecoverable.length) {
      let msg = `Связь с Twitch EventSub отсутствовала с ${fmt(gapStartedAt)} по ${fmt(gapEndedAt)} (${seconds} с).`;
      if (recovered) msg += ` Найдено и обработано пропущенных погашений: ${recovered}.`;
      if (unrecoverable.length) msg += ` Погашения наград других приложений за это время восстановить невозможно (ограничение Twitch): ${unrecoverable.slice(0, 5).join(', ')}${unrecoverable.length > 5 ? '…' : ''}.`;
      this.d.journal(unrecoverable.length ? 'warn' : 'info', 'gap', msg);
    }
    return { recovered, unrecoverable };
  }
}
