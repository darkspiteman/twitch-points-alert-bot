/**
 * Перевод сообщений сервера для панели (1.4.0).
 *
 * Внутри бота все сообщения остаются русскими: они хранятся в базе (журнал, статусы медиа и погашений),
 * и код местами проверяет их текст. Поэтому перевод делается «на выходе» — когда данные уходят в панель
 * (HTTP-ответы и WebSocket). Так переводятся и события, записанные до смены языка.
 *
 * Словарь — пары «русский шаблон → английский шаблон». {имя} — подставляемая часть (имя файла, число, вложенное
 * сообщение); подставляемые части тоже переводятся, если сами являются известными сообщениями.
 * Технический лог (файлы в data\logs) не переводится.
 */

export type Lang = 'ru' | 'en';
export const LANGUAGES: readonly Lang[] = ['ru', 'en'];

/** Язык из настроек: '' (ещё не выбран) и неизвестные значения — русский. */
export function effectiveLang(v: unknown): Lang {
  return v === 'en' ? 'en' : 'ru';
}

const CYR = /[А-Яа-яЁё]/;

// ---------------------------------------------------------------------------------------------
// Словарь. Названия разделов и кнопок совпадают с английской панелью (public/panel/i18n.js).
// ---------------------------------------------------------------------------------------------
const EN: Array<[string, string]> = [
  // ---- общие ----
  ['оповещение', 'alert'],
  ['ошибка', 'error'],
  ['зритель', 'viewer'],
  ['Тест', 'Test'],
  ['Klipy и Freesound', 'Klipy and Freesound'],
  ['Требуется подтверждение', 'Confirmation required'],
  ['Требуется подтверждение удаления', 'Deletion must be confirmed'],
  ['Требуется подтверждение замены', 'Replacement must be confirmed'],
  ['Ошибка', 'Error'],
  ['Ошибка теста', 'Test failed'],
  ['Внутренняя ошибка', 'Internal error'],
  ['Сначала войдите в Twitch', 'Sign in to Twitch first'],
  ['Не выполнен вход в Twitch', 'Not signed in to Twitch'],
  ['Награда не найдена', 'Reward not found'],
  ['код {c}: {m} ({r})', 'code {c}: {m} ({r})'],
  ['код {c}: {m}', 'code {c}: {m}'],
  ['код {c} ({r})', 'code {c} ({r})'],
  ['код {c}', 'code {c}'],

  // ---- app.ts ----
  ['После перезапуска отменено незавершённых оповещений: {n} (старые награды не воспроизводятся)', 'Unfinished alerts cancelled after restart: {n} (old rewards are not played)'],
  ['«{t}»: онлайн-медиа не загрузилось в {app} ({m}) — сыграл запасной звук', '“{t}”: online media failed to load in {app} ({m}) — the fallback sound played'],
  ['{reason} Браузер панели тоже не может его прочитать — перекодируйте файл бесплатной программой HandBrake в MP4 (H.264 + AAC) и загрузите заново.', '{reason} The panel browser can’t read it either — convert the file with the free HandBrake app to MP4 (H.264 + AAC) and upload it again.'],
  ['Браузер не может воспроизвести файл: {m}', 'The browser can’t play the file: {m}'],
  ['браузер читает из файла только звук, картинку — нет (видеокодек не поддерживается)', 'the browser reads only the sound from the file, not the picture (video codec not supported)'],
  ['неизвестная длительность', 'unknown duration'],
  ['превышено время проверки', 'check timed out'],
  ['Требуется повторный вход в Twitch: события наград не принимаются', 'Sign in to Twitch again: reward events are not being received'],
  ['Выполнен выход из Twitch', 'Signed out of Twitch'],
  ['доступ приложения отозван в настройках Twitch', 'app access was revoked in Twitch settings'],
  ['пользователь удалён или заблокирован', 'the user was deleted or banned'],
  ['версия подписки больше не поддерживается Twitch', 'this subscription version is no longer supported by Twitch'],
  ['Twitch отменил подписку на награды: {r}. Переподключаюсь.', 'Twitch revoked the reward subscription: {r}. Reconnecting.'],
  ['Соединение с Twitch EventSub потеряно, переподключаюсь…', 'Connection to Twitch EventSub lost, reconnecting…'],
  ['Соединение с Twitch EventSub восстановлено', 'Connection to Twitch EventSub restored'],
  ['Подключено к Twitch EventSub', 'Connected to Twitch EventSub'],
  ['Подписка на события невозможна: {e}', 'Can’t subscribe to events: {e}'],
  ['Бот запущен (версия {v})', 'Bot started (version {v})'],
  ['Twitch: баллы канала доступны только компаньонам и партнёрам', 'Twitch: channel points are only available to Affiliates and Partners'],
  ['Нет права управлять наградами. Включите его в настройках и войдите в Twitch заново.', 'No permission to manage rewards. Turn it on in Settings and sign in to Twitch again.'],
  ['Создана копия награды «{a}» → «{b}» (на паузе)', 'Copy of reward “{a}” created → “{b}” (paused)'],
  ['Название награды: от 1 до 45 символов', 'Reward title: 1 to 45 characters'],
  ['Стоимость должна быть целым числом от 1', 'Cost must be a whole number, at least 1'],
  ['Создана награда «{t}» ({c} баллов)', 'Reward “{t}” created ({c} points)'],
  ['Эту награду создало другое приложение (например, Sound Alerts) — Twitch запрещает её изменять. Измените её на сайте Twitch или в Sound Alerts.', 'This reward was created by another app (for example, Sound Alerts) — Twitch doesn’t allow changing it. Change it on the Twitch website or in Sound Alerts.'],
  ['Название: от 1 до 45 символов', 'Title: 1 to 45 characters'],
  ['Резервная копия сцен {app} ({n} файлов): {dir}', '{app} scene backup ({n} files): {dir}'],
  ['Отменено: бот остановлен', 'Cancelled: the bot was stopped'],
  ['Отменено: приложение было перезапущено', 'Cancelled: the app was restarted'],

  // ---- autostart.ts, main.ts ----
  ['Лаунчер TwitchAlertBot.exe не найден. Запустите установку (install.cmd).', 'Launcher TwitchAlertBot.exe not found. Run the installer (install.cmd).'],
  ['Не удалось включить автозапуск', 'Couldn’t turn on autostart'],
  ['Порт {p} занят другой программой. Измените порт в настройках (или переменной TAB_PORT).', 'Port {p} is used by another program. Change the port in Settings (or the TAB_PORT variable).'],

  // ---- config.ts ----
  ['Значение «{k}» должно быть числом от {a} до {b}', 'Value “{k}” must be a number from {a} to {b}'],
  ['Неизвестная настройка: {k}', 'Unknown setting: {k}'],
  ['Неверный режим работы', 'Invalid mode'],
  ['Неверное положение overlay', 'Invalid overlay position'],
  ['Client ID выглядит неверно: ожидается 30 латинских букв и цифр из dev.twitch.tv/console', 'The Client ID looks wrong: expected 30 Latin letters and digits from dev.twitch.tv/console'],
  ['Ключ API выглядит неверно: ожидаются латинские буквы и цифры без пробелов. Скопируйте его ещё раз.', 'The API key looks wrong: expected Latin letters and digits without spaces. Copy it again.'],
  ['Неверный уровень фильтра контента', 'Invalid content filter level'],
  ['Шаблон подписи слишком длинный', 'Caption template is too long'],
  ['Неверная программа для стрима: выберите OBS Studio или Streamlabs Desktop', 'Invalid streaming app: choose OBS Studio or Streamlabs Desktop'],
  ['Слишком длинный путь', 'Path is too long'],
  ['Неверный язык: выберите русский или английский', 'Invalid language: choose Russian or English'],

  // ---- db.ts ----

  // ---- find.ts ----
  ['CC0 (без ограничений)', 'CC0 (no restrictions)'],
  ['CC BY-NC (только некоммерческое, указать автора)', 'CC BY-NC (non-commercial only, credit the author)'],
  ['CC BY (указать автора)', 'CC BY (credit the author)'],
  ['лицензия не указана', 'license not specified'],
  ['автор неизвестен', 'unknown author'],
  ['«{n}» — {u}, Freesound, {l}', '“{n}” by {u}, Freesound, {l}'],
  ['Сначала вставьте ключ Klipy: «Настройки» → «Поиск медиа».', 'Paste your Klipy key first: “Settings” → “Media search”.'],
  ['Нет связи с Klipy. Проверьте интернет и попробуйте ещё раз.', 'Can’t reach Klipy. Check your internet connection and try again.'],
  ['Klipy не принял ключ. Проверьте ключ в «Настройки» → «Поиск медиа».', 'Klipy rejected the key. Check the key in “Settings” → “Media search”.'],
  ['Превышен лимит запросов Klipy (тестовый ключ — 100 в час). Подождите немного или запросите production-доступ в Partner Panel Klipy.', 'Klipy request limit exceeded (test key: 100 per hour). Wait a bit or request production access in the Klipy Partner Panel.'],
  ['Сервис Klipy временно недоступен (ошибка {s}). Попробуйте позже.', 'Klipy is temporarily unavailable (error {s}). Try again later.'],
  ['Klipy вернул непонятный ответ', 'Klipy returned an unexpected response'],
  ['Неизвестный раздел Klipy', 'Unknown Klipy section'],
  ['Этот мем больше недоступен в Klipy (удалён или скрыт)', 'This meme is no longer available on Klipy (deleted or hidden)'],
  ['Неверный идентификатор мема', 'Invalid meme ID'],
  ['Добавлен онлайн-мем Klipy «{n}» (файл не скачивается, показывается с сервера Klipy)', 'Added online Klipy meme “{n}” (not downloaded, shown from the Klipy server)'],
  ['Неверная ссылка на онлайн-медиа', 'Invalid online media link'],
  ['«{t}»: Klipy недоступен ({w}) — сыграл запасной звук', '“{t}”: Klipy is unavailable ({w}) — the fallback sound played'],
  ['онлайн-медиа недоступно: {w}. Назначьте награде «Звук (основной файл)» — он сыграет при сбое Klipy.', 'online media unavailable: {w}. Set “Sound (main file)” for the reward — it plays if Klipy fails.'],
  ['Сначала вставьте ключ Freesound: «Настройки» → «Поиск медиа».', 'Paste your Freesound key first: “Settings” → “Media search”.'],
  ['Нет связи с Freesound. Проверьте интернет и попробуйте ещё раз.', 'Can’t reach Freesound. Check your internet connection and try again.'],
  ['Freesound не принял ключ. Проверьте ключ в «Настройки» → «Поиск медиа».', 'Freesound rejected the key. Check the key in “Settings” → “Media search”.'],
  ['Звук не найден на Freesound', 'Sound not found on Freesound'],
  ['Превышен лимит запросов Freesound (60 в минуту, 2000 в день). Подождите немного.', 'Freesound request limit exceeded (60 per minute, 2000 per day). Wait a bit.'],
  ['Сервис Freesound временно недоступен (ошибка {s}). Попробуйте позже.', 'Freesound is temporarily unavailable (error {s}). Try again later.'],
  ['Freesound вернул непонятный ответ', 'Freesound returned an unexpected response'],
  ['Введите, что искать (например: «applause», «fail», «laugh»)', 'Type what to search for (for example: “applause”, “fail”, “laugh”)'],
  ['Неверный идентификатор звука', 'Invalid sound ID'],
  ['У этого звука нет файла для скачивания', 'This sound has no file to download'],
  ['Добавлен звук Freesound «{n}» ({l}) — лицензия запрещает коммерческое использование', 'Added Freesound sound “{n}” ({l}) — the license forbids commercial use'],
  ['Добавлен звук Freesound «{n}» ({l})', 'Added Freesound sound “{n}” ({l})'],
  ['Правила {name} запрещают сохранять их файлы.', '{name} rules don’t allow saving their files.'],
  ['Найдите этот мем во вкладке «Klipy» — он будет показываться онлайн.', 'Find this meme in the “Klipy” tab — it will be shown online.'],
  ['Добавлен файл по ссылке «{n}» ({h})', 'Added file from link “{n}” ({h})'],

  // ---- media.ts, media-codecs.ts ----
  ['В файле {parts} — {verdict}. Нажмите «Перекодировать» (раздел «Медиа») или сохраните файл как MP4 (H.264 + AAC).', 'This file has {parts} — {verdict}. Click “Convert” (Media section) or save the file as MP4 (H.264 + AAC).'],
  ['В файле {parts} — {verdict}.', 'This file has {parts} — {verdict}.'],
  ['видео в кодеке {v} и звук в формате {a}', 'video in {v} and audio in {a}'],
  ['видео в кодеке {v}', 'video in {v}'],
  ['звук в формате {a}', 'audio in {a}'],
  ['может не воспроизводиться в OBS и Streamlabs', 'it may not play in OBS and Streamlabs'],
  ['не воспроизводится в OBS и Streamlabs', 'it won’t play in OBS and Streamlabs'],
  ['не воспроизводится со звуком в OBS и Streamlabs', 'it won’t play with sound in OBS and Streamlabs'],
  ['Не найден индекс MP4 (moov) — файл может быть повреждён или не дозаписан.', 'MP4 index (moov) not found — the file may be damaged or incomplete.'],
  ['Не удалось определить видеокодек WebM.', 'Couldn’t detect the WebM video codec.'],
  ['Файл пустой', 'The file is empty'],
  ['Файл больше {n} МБ', 'The file is larger than {n} MB'],
  ['Формат .{e} не поддерживается. Допустимы: MP3, WAV, OGG, M4A, WebM, MP4, GIF, PNG, JPG, WebP', 'The .{e} format isn’t supported. Allowed: MP3, WAV, OGG, M4A, WebM, MP4, GIF, PNG, JPG, WebP'],
  ['Содержимое файла не распознано: файл повреждён или это не медиафайл', 'File content not recognized: the file is damaged or isn’t a media file'],
  ['Содержимое файла не распознано: это не аудио, видео или картинка поддерживаемого формата', 'File content not recognized: it isn’t audio, video or an image in a supported format'],
  ['Файл не найден', 'File not found'],
  ['Файл используется наградами: {l}', 'The file is used by rewards: {l}'],
  ['Файл отсутствует на диске', 'The file is missing from the disk'],
  ['Файл повреждён: формат не распознан', 'The file is damaged: format not recognized'],

  // ---- queue.ts ----
  ['Очередь переполнена (максимум {n})', 'The queue is full (maximum {n})'],
  ['Пропущено вручную', 'Skipped manually'],
  ['Очередь очищена', 'Queue cleared'],
  ['Удалено из очереди', 'Removed from the queue'],
  ['ошибка воспроизведения', 'playback error'],
  ['Ошибка воспроизведения: {e}', 'Playback error: {e}'],
  ['Overlay отключился во время воспроизведения', 'The overlay disconnected during playback'],
  ['Устарело: ждало дольше {n} с', 'Expired: waited longer than {n} s'],
  ['Завершено по таймауту', 'Finished by timeout'],
  ['Не удалось отправить в overlay', 'Couldn’t send to the overlay'],

  // ---- ошибки overlay (overlay.js присылает их по-русски) ----
  ['неизвестная ошибка воспроизведения', 'unknown playback error'],
  ['воспроизведение прервано', 'playback aborted'],
  ['ошибка сети при загрузке файла', 'network error while loading the file'],
  ['не удалось декодировать файл (повреждён или неподдерживаемый кодек)', 'couldn’t decode the file (damaged or unsupported codec)'],
  ['кодек или формат файла не поддерживается программой для стрима (MEDIA_ERR_SRC_NOT_SUPPORTED)', 'the codec or file format isn’t supported by the streaming app (MEDIA_ERR_SRC_NOT_SUPPORTED)'],
  ['код ошибки {c}', 'error code {c}'],
  ['не удалось загрузить изображение (файл повреждён?)', 'couldn’t load the image (is the file damaged?)'],
  ['браузер запретил автозапуск звука (в OBS и Streamlabs этого не происходит)', 'the browser blocked sound autoplay (this doesn’t happen in OBS and Streamlabs)'],
  ['не удалось начать воспроизведение: {e}', 'couldn’t start playback: {e}'],
  ['файл не начал воспроизводиться за 10 секунд', 'the file didn’t start playing within 10 seconds'],

  // ---- router.ts ----
  ['Файл «{n}» не воспроизводится: {m}', 'File “{n}” doesn’t play: {m}'],
  ['Файл «{n}» отсутствует на диске', 'File “{n}” is missing from the disk'],
  ['Новая награда «{t}» добавлена в список. Настройте её в разделе «Награды».', 'New reward “{t}” added to the list. Set it up in the “Rewards” section.'],
  ['Погашение устарело (старше {n} с) — не воспроизводится', 'Redemption expired (older than {n} s) — not played'],
  ['Не воспроизведено (устарело): «{t}» от {u}', 'Not played (expired): “{t}” from {u}'],
  ['Награда выключена в боте', 'The reward is turned off in the bot'],
  ['«{t}» от {u} — награда выключена в боте', '“{t}” from {u} — the reward is turned off in the bot'],
  ['Режим наблюдения: без воспроизведения', 'Observe mode: not played'],
  ['«{t}» от {u} (режим наблюдения)', '“{t}” from {u} (observe mode)'],
  ['Антиспам: {u} активировал(а) награду менее {n} с назад', 'Anti-spam: {u} redeemed this reward less than {n} s ago'],
  ['«{t}» от {u} пропущено (антиспам)', '“{t}” from {u} skipped (anti-spam)'],
  ['«{t}» от {u} (восстановлено после разрыва)', '“{t}” from {u} (recovered after a disconnect)'],
  ['«{t}» от {u}: {r}', '“{t}” from {u}: {r}'],
  ['«{t}» от {u}', '“{t}” from {u}'],
  ['«{t}»: {e} — воспроизводится только звук', '“{t}”: {e} — playing sound only'],
  ['«{t}»: {e}', '“{t}”: {e}'],
  ['Тест: «{t}»', 'Test: “{t}”'],
  ['Встроенный тест', 'Built-in test'],
  ['Тест: оверлей работает!', 'Test: the overlay works!'],
  ['Встроенный тест оповещения', 'Built-in alert test'],
  ['Файл: {n}', 'File: {n}'],
  ['Для награды не выбран медиафайл', 'No media file selected for the reward'],
  ['Основной файл удалён(о) из медиатеки', 'The main file was removed from the media library'],
  ['Видео удалён(о) из медиатеки', 'The video was removed from the media library'],
  ['Дополнительный звук удалён(о) из медиатеки', 'The extra sound was removed from the media library'],
  ['Нет подходящего файла для выбранного режима', 'No suitable file for the selected mode'],
  ['Не воспроизводится в программе для стрима: {m}. Нажмите «Перекодировать» у файла в разделе «Медиа».', 'Doesn’t play in the streaming app: {m}. Click “Convert” on the file in the “Media” section.'],
  ['Не воспроизводится в программе для стрима: {m}.', 'Doesn’t play in the streaming app: {m}.'],
  ['«{n}» не воспроизводится в программе для стрима. Нажмите «Перекодировать» у файла в разделе «Медиа».', '“{n}” doesn’t play in the streaming app. Click “Convert” on the file in the “Media” section.'],
  ['Баллы за «{t}» возвращены зрителю', 'Points for “{t}” were refunded to the viewer'],
  ['Связь с Twitch EventSub отсутствовала с {a} по {b} ({s} с).', 'There was no connection to Twitch EventSub from {a} to {b} ({s} s).'],
  ['Найдено и обработано пропущенных погашений: {n}.', 'Missed redemptions found and processed: {n}.'],
  ['Погашения наград других приложений за это время восстановить невозможно (ограничение Twitch): {l}.', 'Redemptions of other apps’ rewards during this time can’t be recovered (Twitch limitation): {l}.'],

  // ---- stream-app.ts ----
  ['Папка сцен {app} не найдена: {p}. Проверьте «Папку настроек» в разделе «Настройки».', '{app} scenes folder not found: {p}. Check the “Settings folder” in the “Settings” section.'],
  ['В папке {p} нет файлов сцен {app}', 'No {app} scene files in the folder {p}'],

  // ---- update.ts ----
  ['неверный формат списка изменений', 'invalid changelog format'],
  ['Скачивание новой версии…', 'Downloading the new version…'],
  ['Проверка архива…', 'Checking the archive…'],
  ['Установка файлов…', 'Installing files…'],
  ['Установка зависимостей…', 'Installing dependencies…'],
  ['Обновление лаунчера…', 'Updating the launcher…'],
  ['Перезапуск бота…', 'Restarting the bot…'],
  ['Эта копия бота — рабочая папка разработчика (git). Обновляйте её через git, автоматическая установка отключена.', 'This copy of the bot is a developer working folder (git). Update it with git; automatic installation is turned off.'],
  ['Автоматическое обновление работает только в Windows.', 'Automatic updates only work on Windows.'],
  ['Нет связи с GitHub — проверьте интернет', 'Can’t reach GitHub — check your internet connection'],
  ['GitHub ответил ошибкой {s}', 'GitHub responded with error {s}'],
  ['Не удалось прочитать список изменений', 'Couldn’t read the changelog'],
  ['Список изменений пуст', 'The changelog is empty'],
  ['Обновление уже устанавливается', 'The update is already being installed'],
  ['Новой версии нет — установлена последняя', 'No new version — you have the latest'],
  ['Новой версии нет', 'No new version'],
  ['Не удалось скачать обновление: {e}', 'Couldn’t download the update: {e}'],
  ['Не удалось скачать обновление', 'Couldn’t download the update'],
  ['Архив обновления повреждён', 'The update archive is damaged'],
  ['В архиве обновления нет корректного package.json', 'The update archive has no valid package.json'],
  ['Архив обновления не похож на Twitch Alert Bot', 'The update archive doesn’t look like Twitch Alert Bot'],
  ['В архиве версия {a}, а ожидалась {b}. Попробуйте позже.', 'The archive has version {a}, but {b} was expected. Try again later.'],
  ['В архиве обновления нет файла {f}', 'The update archive has no file {f}'],
  ['Недопустимый путь в архиве', 'Invalid path in the archive'],
  ['Не удалось установить зависимости ({l}). Запустите install.cmd вручную.', 'Couldn’t install dependencies ({l}). Run install.cmd manually.'],
  ['Не установлены зависимости: {l}. Запустите install.cmd вручную.', 'Dependencies not installed: {l}. Run install.cmd manually.'],
  ['Лаунчер не обновлён ({e}). Он продолжит работать; при желании запустите install.cmd.', 'The launcher wasn’t updated ({e}). It keeps working; run install.cmd if you like.'],
  ['Обновление до {v} не установлено: {e} Прежняя версия восстановлена.', 'Update to {v} wasn’t installed: {e} The previous version was restored.'],
  ['Обновление до {v} не установлено: {e}', 'Update to {v} wasn’t installed: {e}'],
  ['Установлена версия {v} (была {f}). Резервная копия прежних файлов: {d}', 'Version {v} installed (was {f}). Backup of the previous files: {d}'],
  ['файл не создан', 'file not created'],

  // ---- net/safe-download.ts ----
  ['Ссылка слишком длинная', 'The link is too long'],
  ['Это не похоже на ссылку. Скопируйте адрес целиком, начиная с https://', 'This doesn’t look like a link. Copy the whole address starting with https://'],
  ['Поддерживаются только ссылки https://', 'Only https:// links are supported'],
  ['Ссылки с логином и паролем не поддерживаются', 'Links with a login and password aren’t supported'],
  ['Ссылки с нестандартным портом не поддерживаются', 'Links with a non-standard port aren’t supported'],
  ['Скачивание с этого компьютера и из локальной сети запрещено', 'Downloading from this computer and the local network isn’t allowed'],
  ['Адрес сайта указан неверно', 'The site address is wrong'],
  ['Скачивание с сайта {h} здесь не разрешено', 'Downloading from {h} isn’t allowed here'],
  ['Адрес не найден', 'Address not found'],
  ['Ссылка ведёт на этот компьютер или в локальную сеть — скачивание запрещено', 'The link points to this computer or the local network — downloading isn’t allowed'],
  ['Сайт отвечает слишком долго — попробуйте позже', 'The site is taking too long to respond — try again later'],
  ['Не удалось подключиться к сайту. Проверьте интернет и ссылку.', 'Couldn’t connect to the site. Check your internet connection and the link.'],
  ['Сайт вернул перенаправление без адреса', 'The site returned a redirect without an address'],
  ['Слишком много перенаправлений', 'Too many redirects'],
  ['файл не найден (404)', 'file not found (404)'],
  ['доступ к файлу закрыт', 'access to the file is denied'],
  ['ошибка {s}', 'error {s}'],
  ['Сайт не отдал файл: {t}', 'The site didn’t return the file: {t}'],
  ['Файл слишком большой ({a}, максимум {b})', 'The file is too large ({a}, maximum {b})'],
  ['Файл слишком большой (максимум {b})', 'The file is too large (maximum {b})'],
  ['{n} МБ', '{n} MB'],
  ['Скачивание заняло слишком много времени', 'The download took too long'],
  ['Связь оборвалась во время скачивания', 'The connection dropped during the download'],

  // ---- net/zip.ts ----
  ['Архив повреждён: не найден каталог ZIP', 'The archive is damaged: ZIP directory not found'],
  ['В архиве слишком много файлов', 'The archive has too many files'],
  ['Архив повреждён: неверный каталог', 'The archive is damaged: invalid directory'],
  ['Зашифрованные архивы не поддерживаются', 'Encrypted archives aren’t supported'],
  ['Недопустимый путь в архиве: {p}', 'Invalid path in the archive: {p}'],
  ['Архив слишком большой после распаковки', 'The archive is too large after unpacking'],
  ['Архив повреждён: неверный заголовок файла', 'The archive is damaged: invalid file header'],
  ['Архив повреждён: файл обрезан', 'The archive is damaged: a file is truncated'],
  ['Архив повреждён: не удалось распаковать {f}', 'The archive is damaged: couldn’t unpack {f}'],
  ['Неподдерживаемый метод сжатия в архиве ({m})', 'Unsupported compression method in the archive ({m})'],
  ['Архив повреждён: контрольная сумма не совпала ({f})', 'The archive is damaged: checksum mismatch ({f})'],

  // ---- server/http.ts ----
  ['Client ID сохранён. Теперь нажмите «Войти через Twitch».', 'Client ID saved. Now click “Sign in with Twitch”.'],
  ['Права изменены — войдите в Twitch заново, чтобы применить.', 'Permissions changed — sign in to Twitch again to apply them.'],
  ['Новый порт начнёт работать после перезапуска бота. Не забудьте изменить адрес в Browser Source (OBS или Streamlabs).', 'The new port starts working after the bot restarts. Don’t forget to change the address in the Browser Source (OBS or Streamlabs).'],
  ['Включён режим наблюдения: оповещения не воспроизводятся', 'Observe mode on: alerts are not played'],
  ['Включён активный режим: оповещения воспроизводятся', 'Active mode on: alerts are played'],
  ['Ключ {w} сохранён.', '{w} key saved.'],
  ['Ключ {w} удалён.', '{w} key deleted.'],
  ['Язык панели: русский', 'Panel language: Russian'],
  ['Язык панели: английский', 'Panel language: English'],
  ['Тестовая награда', 'Test reward'],
  ['Неверное значение {k}: допустимо от {a} до {b}', 'Invalid value {k}: allowed from {a} to {b}'],
  ['Неверный режим воспроизведения', 'Invalid playback mode'],
  ['Выбранный файл не найден', 'The selected file wasn’t found'],
  ['Дополнительный звук должен быть аудиофайлом', 'The extra sound must be an audio file'],
  ['В поле «Видео» выберите видео, GIF или картинку', 'In the “Video” field, choose a video, GIF or image'],
  ['Награда «{t}» включена в боте. Если Sound Alerts всё ещё обрабатывает её — оповещение прозвучит дважды. Уберите источник Sound Alerts из OBS (или Streamlabs).', 'Reward “{t}” turned on in the bot. If Sound Alerts still handles it, the alert will play twice. Remove the Sound Alerts source from OBS (or Streamlabs).'],
  ['Неверный статус', 'Invalid status'],
  ['Неверное имя файла', 'Invalid file name'],
  ['Добавлен файл «{n}» (предупреждение: {w})', 'Added file “{n}” (warning: {w})'],
  ['Добавлен файл «{n}»', 'Added file “{n}”'],
  ['Не удалось удалить', 'Couldn’t delete'],
  ['Удалён файл «{n}»', 'Deleted file “{n}”'],
  ['Неверный файл', 'Invalid file'],
  ['«{a}» перекодирован в WebM: исходный файл заменён, наград переключено: {n}', '“{a}” converted to WebM: original file replaced, rewards switched: {n}'],
  ['«{a}» перекодирован в WebM: исходный файл заменён', '“{a}” converted to WebM: original file replaced'],
  ['«{a}» перекодирован в WebM — новый файл «{b}»', '“{a}” converted to WebM — new file “{b}”'],
  ['Пустое имя', 'Empty name'],
  ['Онлайн-медиа не найдено', 'Online media not found'],
  ['Неизвестная папка', 'Unknown folder'],
  ['Доступ запрещён: неверный заголовок Host', 'Access denied: invalid Host header'],
  ['Нет такого метода API', 'No such API method'],
  ['Неверный JSON', 'Invalid JSON'],
  ['Метод не поддерживается', 'Method not supported'],
  ['Страница не найдена', 'Page not found'],
  ['Запрос отклонён (защита от подделки запросов)', 'Request rejected (request forgery protection)'],
  ['Запрос с чужого сайта отклонён', 'Request from another site rejected'],
  ['Слишком большой файл (максимум {n} МБ)', 'The file is too large (maximum {n} MB)'],
  ['Streamlabs Desktop не найден. Укажите путь к «Streamlabs OBS.exe» в «Настройки → Программа для стрима».', 'Streamlabs Desktop not found. Set the path to “Streamlabs OBS.exe” in “Settings → Streaming app”.'],
  ['OBS не найден по указанному пути. Проверьте путь в «Настройки → Программа для стрима».', 'OBS wasn’t found at the specified path. Check the path in “Settings → Streaming app”.'],
  ['Не удалось запустить {app}: {e}', 'Couldn’t start {app}: {e}'],

  // ---- twitch/auth.ts ----
  ['Подключено как {login}', 'Connected as {login}'],
  ['Укажите Client ID приложения Twitch в настройках', 'Enter the Twitch app Client ID in Settings'],
  ['Сохранённый вход повреждён — войдите в Twitch снова', 'The saved sign-in is damaged — sign in to Twitch again'],
  ['Client ID изменён — войдите в Twitch снова', 'The Client ID changed — sign in to Twitch again'],
  ['Недостаточно прав ({m}). Нажмите «Войти через Twitch» ещё раз.', 'Not enough permissions ({m}). Click “Sign in with Twitch” again.'],
  ['Нет связи с Twitch при обновлении токена: {e}', 'Can’t reach Twitch while refreshing the token: {e}'],
  ['Срок входа истёк или доступ отозван — войдите в Twitch снова', 'The sign-in expired or access was revoked — sign in to Twitch again'],
  ['Twitch вернул ошибку при обновлении токена: HTTP {s}', 'Twitch returned an error while refreshing the token: HTTP {s}'],
  ['Сначала укажите Client ID в настройках', 'Enter the Client ID in Settings first'],
  ['Проверьте Client ID.', 'Check the Client ID.'],
  ['Убедитесь, что тип клиента приложения — «Public» (Общедоступный).', 'Make sure the app client type is “Public”.'],
  ['Twitch отклонил запрос входа (HTTP {s}).', 'Twitch rejected the sign-in request (HTTP {s}).'],
  ['Подтвердите вход на сайте Twitch', 'Confirm the sign-in on the Twitch website'],
  ['Время на подтверждение входа истекло. Нажмите «Войти через Twitch» ещё раз.', 'Time to confirm the sign-in ran out. Click “Sign in with Twitch” again.'],
  ['Вход отклонён на сайте Twitch', 'Sign-in was declined on the Twitch website'],
  ['Код входа недействителен или истёк. Попробуйте ещё раз.', 'The sign-in code is invalid or expired. Try again.'],
  ['Вы вышли из Twitch', 'You signed out of Twitch'],

  // ---- twitch/eventsub.ts, helix.ts ----
  ['Ошибка соединения: {e}', 'Connection error: {e}'],
  ['Не удалось подписаться на события: {e}', 'Couldn’t subscribe to events: {e}'],
  ['обрыв сети', 'network dropped'],
  ['внутренняя ошибка сервера Twitch', 'Twitch server internal error'],
  ['клиент отправил лишние данные', 'the client sent unexpected data'],
  ['не отвечен ping', 'ping not answered'],
  ['не создана подписка вовремя', 'subscription not created in time'],
  ['истекло время на переподключение', 'reconnect time ran out'],
  ['сетевой таймаут', 'network timeout'],
  ['сетевая ошибка', 'network error'],
  ['неверный адрес переподключения', 'invalid reconnect address'],
  ['Нет связи с Twitch API: {e}', 'Can’t reach the Twitch API: {e}'],
];

/** Слова и фразы, которые переводятся внутри подставленных частей (названия кодеков, пометки). */
const GLOSSARY: Array<[string, string]> = [
  ['может не воспроизводиться в OBS и Streamlabs', 'it may not play in OBS and Streamlabs'],
  ['не воспроизводится со звуком в OBS и Streamlabs', 'it won’t play with sound in OBS and Streamlabs'],
  ['не воспроизводится в OBS и Streamlabs', 'it won’t play in OBS and Streamlabs'],
  ['может не воспроизводиться', 'may not play'],
  ['несжатое видео', 'uncompressed video'],
  ['неизвестный кодек', 'unknown codec'],
  ['10 бит', '10-bit'],
];

// ---------------------------------------------------------------------------------------------

interface Template { re: RegExp; names: string[]; en: string; weight: number }

const exact = new Map<string, string>();
const templates: Template[] = [];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

for (const [ru, en] of EN) {
  if (!/\{\w+\}/.test(ru)) { exact.set(ru, en); continue; }
  const names: string[] = [];
  let src = '^';
  let weight = 0;
  for (const part of ru.split(/(\{\w+\})/)) {
    const m = /^\{(\w+)\}$/.exec(part);
    if (m) { names.push(m[1]); src += '([\\s\\S]*?)'; } else { src += escapeRe(part); weight += part.length; }
  }
  templates.push({ re: new RegExp(src + '$'), names, en, weight });
}
// Сначала — самые конкретные шаблоны (больше постоянного текста).
templates.sort((a, b) => b.weight - a.weight);
const glossary = [...GLOSSARY].sort((a, b) => b[0].length - a[0].length);

function applyGlossary(s: string): string {
  if (!CYR.test(s)) return s;
  for (const [ru, en] of glossary) if (s.includes(ru)) s = s.split(ru).join(en);
  return s;
}

function translateWhole(text: string, depth: number): string | null {
  const e = exact.get(text);
  if (e !== undefined) return e;
  if (depth > 4) return null;
  for (const t of templates) {
    const m = t.re.exec(text);
    if (!m) continue;
    const values = new Map<string, string>();
    t.names.forEach((n, i) => values.set(n, m[i + 1]));
    return t.en.replace(/\{(\w+)\}/g, (_, n: string) => translateText(values.get(n) ?? '', depth + 1));
  }
  return null;
}

const cyrCount = (s: string) => (s.match(/[А-Яа-яЁё]/g) ?? []).length;

function translateText(text: string, depth: number): string {
  if (!text || !CYR.test(text)) return text;
  const whole = translateWhole(text, depth);
  if (whole !== null && !CYR.test(whole)) return whole;
  // Сообщение из нескольких предложений (например, «основное. Дополнение.») — переводим по предложениям.
  // Шаблон с подстановкой в конце мог «захватить» следующие предложения — берём вариант, где меньше русского текста.
  const parts = text.split(/(?<=[.!?…])\s+(?=[«“"(A-ZА-ЯЁ])/);
  const bySentence = parts.length > 1 ? parts.map((p) => translateWhole(p, depth) ?? applyGlossary(p)).join(' ') : null;
  const candidates = [whole, bySentence, applyGlossary(text)].filter((c): c is string => c !== null);
  return candidates.reduce((best, c) => (cyrCount(c) < cyrCount(best) ? c : best));
}

/** Переводит сообщение сервера на язык панели. Неизвестный текст (названия наград, имена файлов) не меняется. */
export function tr(text: string, lang: Lang): string {
  if (lang === 'ru' || typeof text !== 'string') return text;
  return translateText(text, 0);
}

/** Поля с текстом сообщений, которые переводятся в ответах панели. Названия наград и файлов не трогаются. */
const MESSAGE_KEYS = new Set(['error', 'message', 'note', 'reason', 'stepText', 'status_msg', 'lastError', 'licenseLabel', 'attribution']);

/**
 * Перевод ответа для панели: копия объекта, в которой переведены поля-сообщения
 * (и выбран английский список изменений `changes_en`, если он есть).
 */
export function localize<T>(data: T, lang: Lang): T {
  if (lang === 'ru') return data;
  return walk(data, lang, 0) as T;
}

function walk(v: unknown, lang: Lang, depth: number): unknown {
  if (depth > 12 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => walk(x, lang, depth + 1));
  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(src)) {
    if (typeof val === 'string' && MESSAGE_KEYS.has(k)) out[k] = tr(val, lang);
    else if (k === 'changes' && Array.isArray(src.changes_en) && src.changes_en.length) out[k] = src.changes_en;
    else if (k === 'changes_en') continue;
    else out[k] = walk(val, lang, depth + 1);
  }
  return out;
}
