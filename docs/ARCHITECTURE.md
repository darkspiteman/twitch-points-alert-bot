# Архитектура Twitch Alert Bot

## Требования

| Что | Версия |
|---|---|
| ОС | Windows 10/11 |
| OBS Studio | 28+ (Browser Source на Chromium) |
| Node.js | 22.18+ (встроенный `node:sqlite`, запуск TypeScript без сборки — type stripping); нужен только при установке |
| .NET Framework | 4.x (входит в Windows) — для лаунчера в трее |

Награды канала бот получает через Helix после входа в Twitch. Награды сторонних сервисов
(Sound Alerts и т. п.) видны, но **не редактируются** — см. ниже. Их медиафайлы нужно скачать
из кабинета сервиса самостоятельно и загрузить в бота.

> Резервные копии сцен OBS (`data\obs-backups`) содержат ключ трансляции (`service.json`) — никому их не передавайте.

## Отклонение от предложенного стека: OAuth

Twitch **не поддерживает PKCE** (в документации Authorization Code Flow нет `code_challenge`,
требуется `client_secret`). Для приложений на Windows Twitch рекомендует **public client** +
**Device Code Grant Flow**:

* не нужен `client_secret` → в приложении нет секретов, которые можно украсть;
* вход полностью в браузере на twitch.tv (бот никогда не видит пароль);
* refresh token работает без секрета (одноразовый, живёт 30 дней без использования;
  бот обновляет токен каждые ~4 часа, поэтому срок фактически не истекает при регулярном запуске).

Это официальный и наиболее безопасный для локального приложения вариант, поэтому выбран он.

## Стек

* **Node.js 24 + TypeScript** (запуск `.ts` напрямую, `tsc --noEmit` для проверки типов).
* **node:sqlite** — без нативных модулей и компиляции.
* **ws** — единственная runtime-зависимость (EventSub-клиент + WebSocket-сервер).
* Веб-панель и overlay — чистые HTML/CSS/JS без CDN (работают офлайн).
* **Лаунчер в трее** — маленький C# WinForms `.exe`, компилируется штатным `csc.exe` из .NET Framework
  (без Electron, ~20 КБ). Запускает Node скрыто, перезапускает при сбое, показывает статус цветом значка.
* Токены — **Windows DPAPI** (CurrentUser) через PowerShell `ProtectedData`.

## Схема

```
            Twitch EventSub WS ──► EventSubClient ──► RedemptionRouter ──► PlaybackQueue ──► OverlayHub ──► Browser Source (OBS / Streamlabs)
            Twitch Helix API  ◄── HelixClient ◄── Auth (device flow, refresh, validate)          ▲                (/overlay)
                                                                                                  │
   Панель (браузер) ◄── HTTP API + WS /ws/panel ── HttpServer (127.0.0.1) ──────────────────────┘
                                   │
                                SQLite (настройки, награды, медиа, история, очередь, дедупликация)
```

### Модули (`src/`)

| Файл | Назначение |
|---|---|
| `main.ts` | точка входа: один экземпляр, запуск, корректное завершение |
| `app.ts` | сборка всех компонентов (используется и в тестах) |
| `config.ts` | пути к данным, настройки по умолчанию |
| `db.ts` | SQLite, миграции схемы |
| `logger.ts` | лог в файл с ротацией и маскировкой токенов |
| `secure-store.ts` | DPAPI-хранилище токенов |
| `twitch/auth.ts` | Device Code Flow, refresh, validate (раз в час), проверка scopes |
| `twitch/helix.ts` | Helix API: пользователи, награды, погашения, подписки EventSub |
| `twitch/eventsub.ts` | EventSub WebSocket: welcome / keepalive / reconnect / notification / revocation, backoff + jitter |
| `router.ts` | обработка погашений: дедупликация, фильтры, восстановление пропусков |
| `queue.ts` | очередь воспроизведения |
| `media.ts` | медиатека: проверка форматов по сигнатурам, безопасные пути |
| `media-codecs.ts` | кодеки внутри MP4 (разбор box: stsd, avcC, esds) и WebM (CodecID); что поддерживает браузерный движок OBS/Streamlabs. Несовместимый файл перекодируется в браузере панели (MediaRecorder → WebM VP9 + Opus) и заменяется у наград через `/api/media/:id/transcoded` |
| `server/http.ts` | HTTP API, статика, защита (Host/Origin/CSRF, traversal, CSP) |
| `server/hub.ts` | WebSocket для overlay и панели |
| `stream-app.ts` | программа для стрима: OBS Studio / Streamlabs Desktop — определение по User-Agent (`OBS/…`, метка `SLD`), путь к exe, резервная копия сцен |
| `stats.ts` | статистика стрима (1.5.0): Helix (зрители, фолловеры, подписчики, кто в чате) + EventSub (follow, sub, gift, raid, online/offline) + OBS; опрос только пока открыт док/overlay/страница; снимок для `/ws/stats` |
| `obs-ws.ts` | клиент OBS WebSocket 5 (только чтение: GetStreamStatus, GetStats, GetVideoSettings); пароль и порт — из `plugin_config/obs-websocket/config.json` |
| `autostart.ts` | автозапуск через `HKCU\...\Run` |
| `i18n.ts` | английский язык (1.4.0): словарь сообщений сервера «русский шаблон → английский», `tr()` и `localize()` для ответов панели |

## Ключевые решения

**OBS Studio и Streamlabs Desktop.** У Streamlabs тот же движок Browser Source (форк obs-browser): `window.obsstudio`,
автозапуск звука без клика, User-Agent `… OBS/x.y.z SLD`. Overlay сообщает программу в `hello` (`isObs`, `app`),
хаб дополнительно смотрит User-Agent. Оповещения получают только overlay в программах для стрима; вкладка браузера —
предпросмотр и получает оповещения, только если программ нет. Сцены Streamlabs: `%APPDATA%\slobs-client\SceneCollections`
(`*.json`, `*.json.bak`, `*.json.absolute.bak`), exe — `Streamlabs OBS.exe` (по умолчанию `C:\Program Files\Streamlabs OBS`).

**Дедупликация.** Таблица `seen_messages` (message_id EventSub) и `redemptions` (UNIQUE redemption id).
Повтор любого из ID — событие игнорируется. Старые записи чистятся через 7 дней.

**Потеря событий.** Twitch не переотправляет события, пропущенные пока сессии не было.
После разрыва бот:
1. для **своих** наград (созданных этим ботом) запрашивает Helix «Get Custom Reward Redemption»
   за период разрыва и доигрывает свежие (не старше `maxItemAgeSec`), остальные помечает «пропущено»;
2. для **чужих** наград (Sound Alerts) Twitch API это запрещает (403) — бот записывает в журнал
   окно возможной потери «с … по …».
При **перезапуске приложения** ничего старого не проигрывается: незавершённые элементы очереди
помечаются «отменено (перезапуск)».

**Чужие награды (Sound Alerts).** Подписка EventSub без `reward_id` получает погашения **всех**
наград канала, включая созданные Sound Alerts. Изменять/выполнять/возвращать их может только
создавшее приложение. Поэтому:
* новые награды в Twitch по умолчанию **выключены** в боте (режим «только наблюдение»),
  чтобы не было двойного воспроизведения;
* можно создать копии наград Sound Alerts (только по подтверждению) — они создаются **на паузе**
  и с пометкой в названии (Twitch требует уникальных названий).

**Безопасность обновлений (1.4.1).** Архив обновления (ветка `main` публичного репозитория) содержит `update-signature.json`:
список всех файлов с SHA-256 и версия, подписанные Ed25519 (`src/update-signature.ts`). Подписывает автор скриптом
`scripts/sign-update.ts` по содержимому коммита (как его отдаёт GitHub); секретный ключ — только на компьютере автора,
открытые ключи — в `UPDATE_PUBLIC_KEYS`. Перед установкой бот проверяет подпись и каждый файл: подпись не та, файл
изменён, лишний или отсутствует, версия не совпадает — ничего не устанавливается. `npm install` при обновлении — с `--ignore-scripts`.

**Прочая защита (1.4.1).** Запросы к `/api/*` с `Sec-Fetch-Site: cross-site/same-site` отклоняются (браузер помечает так
запросы по команде чужого сайта — даже GET-картинки). Кнопка запуска OBS/Streamlabs и автозапуск — только `obs64.exe` /
`Streamlabs OBS.exe` из Program Files или папки текущего пользователя (`launchDenied` в `stream-app.ts`): другой пользователь
этого компьютера не может подложить свою программу. Ключи Klipy и Freesound в базе — `enc:<DPAPI>`, в памяти — открытые
(`App.loadSecrets/saveSecret`, `Db.setSecretPlain`); ключи версий до 1.4.1 шифруются при первом запуске.

**Язык панели (1.4.0).** Настройка `language` (`''` — не выбран, `ru`, `en`). Внутри бота все сообщения — русские:
они лежат в базе (журнал, статусы медиа и погашений), и код местами проверяет их текст (`startsWith('Файл')`, кодеки).
Поэтому сервер переводит **на выходе**: HTTP-ответы `/api/*` и WebSocket-сообщения панели проходят через `localize()`,
которая переводит только поля-сообщения (`error`, `message`, `note`, `reason`, `stepText`, `status_msg`, `lastError`,
`licenseLabel`, `attribution`) по словарю шаблонов с подстановками `{имя}` (подставленные части переводятся рекурсивно,
сообщения из нескольких предложений — по предложениям). Так по-английски показываются и события, записанные до смены языка.
Признаки состояния файла, которые панель раньше искала в русском тексте, сервер отдаёт полями (`fileProblem`, `panelCantRead`,
`videoCodec`). Панель: `public/panel/i18n.js` — словарь «русская строка → английская», в `app.js` все строки обёрнуты в
`T('…', [подстановки])`; выбор запоминается в `localStorage` (тот же адрес у overlay — он берёт язык оттуда до подключения,
затем из `view.lang`). Файл-загрузчик переписывается при смене языка, трей читает `language` из `/api/health` и `runtime.json`.
Новая установка: панель выбирает язык по `navigator.languages` и сохраняет его; у баз 1.3.x миграция ставит `ru`.
`changelog.json`: `changes_en` рядом с `changes`.

**Файл-загрузчик overlay (1.2.1).** Browser Source загружает страницу один раз; если бот в этот момент не запущен,
CEF показывает страницу ошибки и сам её не перезагружает. Поэтому бот при запуске пишет `data\overlay.html`
(`src/overlay-loader.ts`) со своим портом. В источнике выбирается «Локальный файл» — OBS открывает его как
`http://absolute/<путь>`. Загрузчик раз в 1–3 с подключается к `ws://127.0.0.1:<порт>/ws/probe`; бот отвечает
`{type:"ready", app:"twitch-alert-bot"}` и закрывает соединение, после чего загрузчик переходит на `/overlay?via=file`.
`/ws/probe` разрешён дополнительно для `Origin` `http://absolute`, `null` и `file://` и не отдаёт никаких данных;
`/ws/overlay` и `/ws/panel` для этих источников закрыты. Overlay сообщает `via` в `hello`, и панель подсказывает
переключить источник, если он открыт по адресу.

**Очередь.** Серверная, одна на все overlay. Элемент считается проигранным, когда overlay сообщил
`ended`/`error` или истёк таймаут (длительность + запас). Повреждённый файл → ошибка в журнал,
очередь идёт дальше. Защита от спама: кулдаун на пользователя, лимит длины очереди, максимальный
возраст элемента.

**Безопасность.** Сервер слушает только `127.0.0.1`. Проверяется заголовок `Host` (защита от
DNS rebinding), изменяющие запросы требуют заголовок `X-TAB-Request` и совпадающий `Origin`
(защита от CSRF с посторонних сайтов). Медиа отдаются только по ID из базы, имена файлов
генерируются ботом. Панель выводит пользовательские строки только через `textContent`, CSP
запрещает inline-скрипты.

### Статистика 1.6.0

- Микрофоны: `ObsClient.mics` (выключен, громкость, в эфире, сколько мс тишины по индикатору громкости). Тревогу решает `public/stats/dock.js`.
- Текущий стрим — `SessionState` (meta `stats_session`): начало, счётчики, имена, уникальные зрители чата. Конец эфира → `stream_history` (итоги).
- Зрители чата — `chatter_history` (login, сколько стримов был, last_session). «Впервые» — только если `chatters_since` ≤ начала стрима.
- В payload `/ws/stats` есть `queue` (снимок очереди) — док показывает очередь и вызывает `/api/queue/*`.

### 1.7.0

- Озвучка — `src/tts.ts` (`TtsEngine`: PowerShell 5.1 + WinRT `Windows.Media.SpeechSynthesis`, текст через stdin; `ttsText()` — фильтры; слова фильтра — `src/tts-words.ts`).
  Роутер кладёт в `PlayItem.ttsText` очищенный текст, `App.prepareItem` (хук `prepare` очереди) создаёт `data\tts\<hex>.wav` → `PlayItem.tts { url, ms }`,
  overlay играет озвучку после звука/видео (с картинкой — сразу). Старые файлы удаляются раз в 6 часов.
- Награды только в эфире — `App.applyRewardsLive` (EventSub stream.online/offline, при входе — Helix streams). Свои паузы — meta `rewards_paused_offline`.
- 1.8.0: голоса Piper — `src/piper.ts` (установка по кнопке, хеши файлов зашиты в код), `TtsEngine` выбирает Piper для голосов `piper:<key>`;
  `ttsPrepare`/`chooseVoice` — язык текста и [Имя] голоса.
- Метки — `POST /api/stats/marker` → Helix `/streams/markers`; `StreamStats.noteMarker`. Топ — `SessionState.byReward/byUser`, `Db.redemptionTop`.

### 1.9.0

- Проверка текста перед озвучкой — настройка `ttsReview` ('off' | 'new' | 'all'). Роутер (`needsReview`: «новый» — нет погашения со статусом done
  и текстом у награды с озвучкой) кладёт элемент не в очередь, а в `PlaybackQueue.hold()` (статус погашения `held`). `queue.snapshot().held` видят
  док и главная; решение — `POST /api/queue/held/:id/voice|mute|reject` → `App.decideHeld` → `queue.decide`. «Отклонить» = событие `finished`
  со `skipped`: роутер возвращает баллы, как при любом сбое (у наград бота).
- Счётчики — `src/counters.ts` (meta `counters`, до 10), `/api/counters*`; в payload `/ws/stats` — `counters` и `counterOverlay`.
  Экран — `public/stats/counter.*` (`/stats/counter`), загрузчик `data\counter-overlay.html` (вид `counter` в overlay-loader).
- Итоги в Telegram — `src/telegram.ts` (Bot API: sendMessage / editMessageText / getUpdates, `summaryText()`); токен — в `SECRET_SETTINGS` (DPAPI).
  `App.sendSummaryToTelegram` вызывается из `saveSummary` статистики; id сообщения по id стрима — meta `telegram_sent` (повторное сохранение после
  короткого обрыва правит сообщение). Адрес запроса содержит токен — не логируется.
- Резервная копия — `src/backup.ts`: ZIP без сжатия, пишется потоком (`VACUUM INTO` для базы + `media/<uuid>.<ext>` + `backup.json`), `data\backups`
  (последние 5 копий и 3 «перед восстановлением»). Восстановление: `PUT /api/backup/restore` → файл на диск → `prepareRestore` (проверка метки,
  версии, CRC, только имена медиа вида uuid, `PRAGMA quick_check`) → `data\restore-pending` → копия текущих данных → выход с кодом 4 (лаунчер
  перезапускает) → `applyPendingRestore` в main.ts до открытия базы (прежние данные — `data\restore-previous`) → запись в журнал при старте.

### 2.0.0 — новая панель

- Разделы (`#pult`, `#stream`, `#rewards`, `#media`, `#voice`, `#obs`, `#settings`, `#log`, `#help`, `#support`); старые адреса `#home`, `#stats`,
  `#find` переводятся (`PAGE_ALIASES`). Вкладки страниц — объект `TABS` в `app.js`; помощники `pageHead`, `pageTabs`, `toggle`, `opt`, `icon`, `goTo`.
- Значки — `<symbol id="i-…">` в `index.html` (inline SVG разрешён CSP), шрифты — `public/panel/fonts/*.woff2` (OFL, `OFL.txt`).
- Палитра — настройка `panelTheme` (`amethyst` | `midnight` | `graphite`), `data-palette` на `<html>`; панель запоминает её в localStorage,
  чтобы не мигала при открытии; в доке — поле `theme` payload `/ws/stats`.
- Метки источников на странице OBS / Streamlabs: страницы статистики подключаются к `/ws/stats?kind=dock|overlay|counter`
  (`&preview=1` — предпросмотр в панели, не считается); `Hub.statsSources()` → `setup.sources` в `/api/stats`.
