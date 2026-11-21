import type { FetchFn } from './twitch/auth.ts';
import { tr, type Lang } from './i18n.ts';
import type { StreamSummary } from './stats.ts';

/**
 * Итоги стрима в Telegram (1.9.0) через Bot API: бот стримера (создаётся у @BotFather) пишет в личный чат,
 * группу или канал. Токен — часть адреса запроса, поэтому адреса запросов никогда не пишутся в журнал и лог.
 */

export class TelegramError extends Error {
  readonly code: number;
  constructor(message: string, code: number) { super(message); this.code = code; }
}

export interface TelegramChat { id: string; title: string; type: string }

const MAX_TEXT = 4000;

export class Telegram {
  private fetchFn: FetchFn;
  private base: string;
  private timeoutMs: number;

  constructor(o: { fetchFn?: FetchFn; base?: string; timeoutMs?: number } = {}) {
    this.fetchFn = o.fetchFn ?? fetch;
    this.base = o.base ?? 'https://api.telegram.org';
    this.timeoutMs = o.timeoutMs ?? 15_000;
  }

  private async call<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
    if (!token) throw new TelegramError('Не указан токен бота Telegram', 0);
    let r: Response;
    try {
      r = await this.fetchFn(`${this.base}/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new TelegramError('Не удалось подключиться к Telegram (api.telegram.org). Проверьте интернет; если Telegram недоступен у провайдера — включите VPN.', 0);
    }
    type Reply = { ok?: boolean; result?: T; error_code?: number; description?: string };
    let j: Reply | null = null;
    try { j = (await r.json()) as Reply; } catch { /* не JSON */ }
    if (j?.ok) return j.result as T;
    const code = Number(j?.error_code ?? r.status) || 0;
    throw new TelegramError(explain(code, String(j?.description ?? '')), code);
  }

  async send(token: string, chatId: string, text: string): Promise<number> {
    const m = await this.call<{ message_id: number }>(token, 'sendMessage', { chat_id: chatId, text: cut(text), disable_web_page_preview: true });
    return Number(m?.message_id) || 0;
  }

  /** Изменить отправленное сообщение (итоги дописались после короткого обрыва эфира). */
  async edit(token: string, chatId: string, messageId: number, text: string): Promise<void> {
    try {
      await this.call(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text: cut(text), disable_web_page_preview: true });
    } catch (e) {
      if (e instanceof TelegramError && e.code === 400 && /not modified/i.test(e.message)) return;
      throw e;
    }
  }

  /** Чаты, где боту недавно писали (личные сообщения, группы, каналы, куда его добавили). */
  async chats(token: string): Promise<TelegramChat[]> {
    type Chat = { id: number; type: string; title?: string; first_name?: string; last_name?: string; username?: string };
    const updates = await this.call<Array<Record<string, { chat?: Chat } | undefined>>>(token, 'getUpdates', {
      limit: 100, timeout: 0, allowed_updates: ['message', 'channel_post', 'my_chat_member'],
    });
    const out = new Map<string, TelegramChat>();
    for (const u of updates ?? []) {
      for (const k of ['message', 'channel_post', 'my_chat_member', 'edited_message']) {
        const c = u?.[k]?.chat;
        if (!c || typeof c.id !== 'number') continue;
        const title = c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || (c.username ? '@' + c.username : String(c.id));
        out.set(String(c.id), { id: String(c.id), title: title.slice(0, 80), type: c.type });
      }
    }
    return [...out.values()];
  }
}

function cut(text: string): string { return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + '…' : text; }

function explain(code: number, desc: string): string {
  if (code === 401 || code === 404) return 'Telegram не принял токен бота — скопируйте его из @BotFather заново';
  if (code === 400 && /chat not found/i.test(desc)) return 'Чат не найден. Напишите своему боту любое сообщение в Telegram и нажмите «Найти чат».';
  if (code === 403) return 'Бот не может писать в этот чат: откройте бота в Telegram и нажмите «Запустить», а для канала — добавьте бота в администраторы.';
  if (code === 409) return 'У этого бота Telegram уже настроена другая программа (webhook) — создайте у @BotFather отдельного бота для Twitch Alert Bot';
  if (code === 429) return 'Telegram просит подождать — попробуйте через минуту';
  if (code === 400 && /not modified/i.test(desc)) return 'message is not modified';
  return desc ? `Ошибка Telegram: код ${code} (${desc.slice(0, 200)})` : `Ошибка Telegram: код ${code}`;
}

function hms(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${h}:${m < 10 ? '0' : ''}${m}:${x < 10 ? '0' : ''}${x}`;
}

/** Текст итогов стрима для Telegram (простой текст, без разметки: ники зрителей не ломают сообщение). */
export function summaryText(s: StreamSummary, lang: Lang): string {
  const T = (text: string) => tr(text, lang);
  const loc = lang === 'en' ? 'en-US' : 'ru-RU';
  const num = (n: number) => n.toLocaleString(loc);
  const date = new Date(s.startedAt).toLocaleDateString(loc, { day: 'numeric', month: 'long' });
  const names = (list: string[] | undefined, total: number) => {
    if (!list?.length) return '';
    const shown = list.slice(0, 15);
    return `   ${shown.join(', ')}${total > shown.length ? ' ' + T(`и ещё ${total - shown.length}`) : ''}`;
  };
  const lines: string[] = [T(`📺 Итоги стрима · ${date} · ${hms(s.endedAt - s.startedAt)}`)];
  if (s.title) lines.push(s.title + (s.game ? ` — ${s.game}` : ''));
  lines.push('');
  lines.push(s.avgViewers !== null ? T(`👁 Зрители: в среднем ${num(s.avgViewers)}, пик ${num(s.peakViewers)}`) : T(`👁 Зрители: пик ${num(s.peakViewers)}`));
  lines.push(T(`❤ Новые фолловеры: +${num(s.followers)}`));
  const fn = names(s.followerNames, s.followers);
  if (fn) lines.push(fn);
  let subs = T(`⭐ Подписки: +${num(s.subs)}`);
  if (s.resubs) subs += T(`, продлений ${num(s.resubs)}`);
  if (s.gifts) subs += T(`, подарено ${num(s.gifts)}`);
  lines.push(subs);
  if (s.chatters !== null) lines.push(T(`💬 В чате было: ${num(s.chatters)}, впервые: ${num(s.newChatters)}`));
  const nn = names(s.newChatterNames, s.newChatters);
  if (nn) lines.push(nn);
  if (s.raids.length) lines.push(T(`🚀 Рейды: ${s.raids.map((r) => `${r.name} (${r.viewers})`).join(', ')}`));
  lines.push(T(`🎁 Награды за баллы: ${num(s.redemptions)}`));
  if (s.topRewards?.length) lines.push('   ' + T(`Чаще всего: ${s.topRewards.map((x) => `«${x[0]}» ×${x[1]}`).join(', ')}`));
  if (s.topUsers?.length) lines.push('   ' + T(`Больше всех потратили баллов: ${s.topUsers.map((x) => `${x[0]} ×${x[1]}`).join(', ')}`));
  if (s.markers?.length) lines.push(T(`📍 Метки в записи: ${s.markers.map((sec) => hms(sec * 1000)).join(', ')}`));
  return lines.join('\n');
}
