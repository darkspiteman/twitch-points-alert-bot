import crypto from 'node:crypto';

/**
 * Подпись обновлений (1.4.1).
 *
 * Автор перед выкладкой подписывает список всех файлов версии с их SHA-256 секретным ключом Ed25519
 * (scripts/sign-update.ts; ключ хранится только на компьютере автора, вне репозитория). Подпись лежит в архиве
 * в файле update-signature.json. Бот перед установкой проверяет подпись открытым ключом из этого файла и сверяет
 * каждый файл архива: подменённый, лишний или недостающий файл — установка отменяется. Так обновление нельзя подменить,
 * даже получив доступ к репозиторию на GitHub.
 */

export const SIGNATURE_FILE = 'update-signature.json';

/**
 * Открытые ключи автора (SPKI DER, base64). Несколько — чтобы можно было сменить ключ: новая версия бота
 * подписывается старым ключом и уже содержит новый.
 */
export const UPDATE_PUBLIC_KEYS: readonly string[] = [
  'MCowBQYDK2VwAyEAChse3UyhF/l4lCkHsyqF40Cp7bKX3ptV1aobswg7SdQ=', // ключ автора, создан 15.11.2026
];

export interface UpdateManifest { format: 1; version: string; files: Record<string, string> }

export const sha256 = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex');

/** Подписываемые данные: JSON с файлами по алфавиту — одинаковый у автора и у бота. */
function payload(version: string, files: Record<string, string>): Buffer {
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(files).sort()) sorted[k] = files[k];
  return Buffer.from(JSON.stringify({ format: 1, version, files: sorted }), 'utf8');
}

/** Список файлов версии: путь → SHA-256 (без самого файла подписи). */
export function manifestOf(files: Map<string, Buffer>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rel, data] of files) if (rel !== SIGNATURE_FILE) out[rel] = sha256(data);
  return out;
}

/** Содержимое update-signature.json для версии (подписывает автор). */
export function signUpdate(version: string, files: Map<string, Buffer>, privateKeyPem: string): string {
  const list = manifestOf(files);
  const signature = crypto.sign(null, payload(version, list), crypto.createPrivateKey(privateKeyPem)).toString('base64');
  return JSON.stringify({ format: 1, version, signature, files: list }, null, 2) + '\n';
}

/** Открытый ключ (SPKI DER, base64) для секретного ключа — чтобы проверить, тем ли ключом подписываем. */
export function publicKeyOf(privateKeyPem: string): string {
  return crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'der' }).toString('base64');
}

/**
 * Проверка архива обновления. files — все файлы архива (путь относительно корня программы).
 * Возвращает подписанный список (версия в нём сверяется с package.json архива). Ошибка — по-русски, для журнала и панели.
 */
export function verifyUpdate(files: Map<string, Buffer>, publicKeys: readonly string[] = UPDATE_PUBLIC_KEYS): UpdateManifest {
  const raw = files.get(SIGNATURE_FILE);
  if (!raw) throw new Error('Обновление не подписано автором — установка отменена ради безопасности.');
  let sig: { format?: unknown; version?: unknown; signature?: unknown; files?: unknown };
  try { sig = JSON.parse(raw.toString('utf8')); } catch { throw new Error('Подпись обновления повреждена — установка отменена.'); }
  const list = sig.files as Record<string, unknown> | undefined;
  if (sig.format !== 1 || typeof sig.version !== 'string' || typeof sig.signature !== 'string' || !list || typeof list !== 'object'
    || Object.values(list).some((h) => typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h))) {
    throw new Error('Подпись обновления повреждена — установка отменена.');
  }
  const signed = list as Record<string, string>;
  const data = payload(sig.version, signed);
  const signature = Buffer.from(sig.signature, 'base64');
  const ok = publicKeys.some((k) => {
    try { return crypto.verify(null, data, crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' }), signature); } catch { return false; }
  });
  if (!ok) throw new Error('Подпись обновления не прошла проверку — архив мог быть подменён. Установка отменена.');
  const actual = manifestOf(files);
  for (const [rel, hash] of Object.entries(actual)) {
    if (!(rel in signed)) throw new Error(`В архиве обновления лишний файл ${rel}, которого нет в подписи, — установка отменена.`);
    if (signed[rel] !== hash) throw new Error(`Файл ${rel} в архиве обновления не совпадает с подписанным — установка отменена.`);
  }
  for (const rel of Object.keys(signed)) if (!files.has(rel)) throw new Error(`В архиве обновления не хватает файла ${rel} из подписи — установка отменена.`);
  return { format: 1, version: sig.version, files: signed };
}
