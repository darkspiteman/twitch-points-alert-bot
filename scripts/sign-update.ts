// Подпись обновления (только для автора). Запуск — из папки с веткой публичной копии, после коммита версии:
//
//   node scripts/sign-update.ts                  — подписать HEAD текущей папки, записать update-signature.json
//   node scripts/sign-update.ts --generate       — один раз: создать ключ подписи (печатает открытый ключ)
//   --key <путь>  — другой файл секретного ключа; --repo <папка> — другая папка git
//
// Секретный ключ по умолчанию: %USERPROFILE%\.twitch-alert-bot\update-signing-key.pem — НЕ кладите его в репозиторий,
// сделайте резервную копию (без него нельзя выпустить обновление, которое примут уже установленные боты).
// Подписываются файлы именно из коммита (как их отдаёт GitHub), а не из рабочей папки: на Windows там другие переводы строк.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SIGNATURE_FILE, UPDATE_PUBLIC_KEYS, signUpdate, publicKeyOf, verifyUpdate } from '../src/update-signature.ts';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const keyFile = opt('--key') ?? path.join(os.homedir(), '.twitch-alert-bot', 'update-signing-key.pem');
const repo = path.resolve(opt('--repo') ?? process.cwd());

if (args.includes('--generate')) {
  if (fs.existsSync(keyFile)) { console.error(`Ключ уже есть: ${keyFile} — не перезаписываю.`); process.exit(1); }
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, pem, { mode: 0o600, flag: 'wx' });
  console.log(`Секретный ключ сохранён: ${keyFile}`);
  console.log(`Открытый ключ (вставьте в UPDATE_PUBLIC_KEYS в src/update-signature.ts):\n${publicKeyOf(pem)}`);
  process.exit(0);
}

if (!fs.existsSync(keyFile)) { console.error(`Нет секретного ключа: ${keyFile}. Создайте его: node scripts/sign-update.ts --generate`); process.exit(1); }
const pem = fs.readFileSync(keyFile, 'utf8');
if (!UPDATE_PUBLIC_KEYS.includes(publicKeyOf(pem))) { console.error('Этот ключ не совпадает ни с одним открытым ключом в src/update-signature.ts — боты не примут подпись.'); process.exit(1); }

const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { maxBuffer: 512 * 1024 * 1024 });
const files = new Map<string, Buffer>();
for (const line of git('ls-tree', '-r', '-z', '--full-tree', 'HEAD').toString('utf8').split('\0')) {
  if (!line) continue;
  const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(line);
  if (!m || m[2] !== 'blob') { console.error(`Неожиданная запись в коммите: ${line}`); process.exit(1); }
  if (m[1] === '120000') { console.error(`Символическая ссылка не поддерживается: ${m[4]}`); process.exit(1); }
  if (m[4] === SIGNATURE_FILE) continue;
  files.set(m[4], git('cat-file', 'blob', m[3]));
}
const pkg = JSON.parse(files.get('package.json')?.toString('utf8') ?? '{}') as { version?: string };
if (!pkg.version) { console.error('В коммите нет package.json с версией.'); process.exit(1); }
const text = signUpdate(pkg.version, files, pem);
// Самопроверка — тем же кодом, что и в боте.
verifyUpdate(new Map([...files, [SIGNATURE_FILE, Buffer.from(text)]]));
fs.writeFileSync(path.join(repo, SIGNATURE_FILE), text);
console.log(`Подписана версия ${pkg.version}: ${files.size} файлов (${git('rev-parse', '--short', 'HEAD').toString().trim()}).`);
console.log(`Дальше: git add ${SIGNATURE_FILE} && git commit --amend --no-edit (другие файлы не менять, иначе подписать заново).`);
