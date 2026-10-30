/*
 * Сборка конфига для статической публикации.
 *
 *   node tools/build-config.mjs [settings.json] [public/config.json]
 *
 * GitHub Pages не умеет отдавать /api/config, поэтому при деплое кладём рядом
 * со страницей готовый ответ сервера: страница читает его, если API нет.
 * Значения проходят через тот же normalizeConfig, что и на сервере, — иначе
 * статика и сервер разошлись бы в трактовке битых полей.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, normalizeConfig, toClientConfig } from '../server/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.resolve(process.argv[2] || path.join(ROOT, 'server', 'config', 'settings.json'));
const TARGET = path.resolve(process.argv[3] || path.join(ROOT, 'public', 'config.json'));

let raw = null;
try {
  raw = JSON.parse(await readFile(SOURCE, 'utf8'));
} catch (err) {
  // Нет файла или битый JSON: публикуем дефолт, как это делает сервер при старте.
  console.warn('Конфиг не прочитан (' + SOURCE + '): ' + err.message + ' — публикую дефолт');
}

const config = toClientConfig(normalizeConfig(raw === null ? DEFAULT_CONFIG : raw));
const payload = {
  ok: true,
  source: 'file',
  builtAt: new Date().toISOString(),
  config: config
};

await mkdir(path.dirname(TARGET), { recursive: true });
await writeFile(TARGET, JSON.stringify(payload, null, 2) + '\n', 'utf8');

console.log('config.json → ' + TARGET + ' (' + config.day.red + '/' + config.day.yellow + '/' + config.day.green +
  ', ночь ' + (config.nightEnabled ? 'вкл ' + config.nightStart + '–' + config.nightEnd : 'выкл') + ')');
