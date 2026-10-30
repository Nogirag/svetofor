/*
 * Задаёт пароль владельца этой установки и раскладывает два его свёртка:
 *   server/config/admin.password  — sha256 для серверных проверок (запись, выгрузка);
 *   public/js/owner-key.js        — свёрток для входа в панели прямо в странице.
 * Оба файла в .gitignore: в репозитории пароля и его свёртков нет.
 *
 *   node tools/set-owner-password.mjs                 # случайный пароль
 *   node tools/set-owner-password.mjs --password '…'  # свой пароль
 *
 * Пароль печатается один раз. Открытым он никуда не записывается.
 */
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = argv.indexOf('--password');
const password = (flag >= 0 && argv[flag + 1]) || randomBytes(24).toString('hex');

// Тот же предел, что у страницы: пароль уходит в HTTP-заголовок, а он живёт в Latin-1.
if (!/^[\x21-\x7E]+$/.test(password)) {
  console.error('Пароль уходит в HTTP-заголовок: только латинские буквы, цифры и знаки без пробелов.');
  process.exit(1);
}

// Копия passwordPrint из public/js/feedback.js — вход должен считать так же.
function passwordPrint(text) {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ (code + i), 0x85ebca6b);
  }
  return (a >>> 0).toString(16) + ':' + (b >>> 0).toString(16);
}

const digest = 'sha256:' + createHash('sha256').update(password).digest('hex');
const print = passwordPrint(password);

writeFileSync(path.join(ROOT, 'server', 'config', 'admin.password'), digest + '\n');
writeFileSync(path.join(ROOT, 'public', 'js', 'owner-key.js'),
  '// Свёрток пароля владельца для входа в панели. Создаётся tools/set-owner-password.mjs,\n' +
  '// в git не попадает: у каждой установки свой.\n' +
  "window.TRAFFIC_OWNER_PRINT = '" + print + "';\n");

console.log('Пароль (сохраните — второй раз его не покажут): ' + password);
console.log('server/config/admin.password   ' + digest.slice(0, 16) + '…');
console.log('public/js/owner-key.js         ' + print);
