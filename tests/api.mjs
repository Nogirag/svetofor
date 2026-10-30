/*
 * Тесты открытого API светофора: пароля владельца больше нет, поэтому запись
 * цикла и выгрузка таблицы проверяются без единого заголовка авторизации.
 *
 *   node tests/api.mjs                                   # свои инстансы на свободных портах
 *   node tests/api.mjs --base http://localhost:8080      # по живому серверу
 *
 * В режиме по умолчанию каждый инстанс получает временный CONFIG_FILE и DATA_DIR,
 * поэтому рабочие server/config/settings.json и server/data не трогаются.
 * По живому серверу запись конфига отправляет то же содержимое, что уже лежит
 * в файле, и проверки записи в файл, лимита и удаления настроек пропускаются.
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SERVER = path.join(ROOT, 'server', 'api.mjs');
const INDEX_FILE = path.join(ROOT, 'public', 'index.html');
const CLIENT_FILE = path.join(ROOT, 'public', 'js', 'feedback.js');
const APP_FILE = path.join(ROOT, 'public', 'js', 'app.js');
const SW_FILE = path.join(ROOT, 'public', 'sw.js');
const WRITE_LIMIT = 20;

const argv = process.argv.slice(2);
function flag(name) {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  if (hit) return hit.slice(name.length + 3);
  const bare = argv.indexOf('--' + name);
  return bare >= 0 && argv[bare + 1] && !argv[bare + 1].startsWith('--') ? argv[bare + 1] : '';
}

const BASE = flag('base');
const results = [];

function pass(name, condition, detail) {
  results.push({ name, status: condition ? 'ok' : 'FAIL', detail: detail === undefined ? '' : String(detail) });
  return !!condition;
}

function skip(name, reason) {
  results.push({ name, status: 'skip', detail: reason });
}

// сервер пишет LF; в рабочей копии на Windows файл мог быть с CRLF
function sameText(a, b) {
  return a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
}

function readText(file) {
  try { return readFileSync(file, 'utf8'); } catch (err) { return ''; }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitUp(base) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) return r.json();
    } catch (err) { /* инстанс ещё поднимается */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('сервер не поднялся: ' + base);
}

function start(port, env) {
  return spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port) }, env || {}),
    stdio: 'ignore',
    windowsHide: true
  });
}

function stop(child) {
  if (!child) return;
  try {
    if (process.platform === 'win32') execSync('taskkill /PID ' + child.pid + ' /F', { stdio: 'ignore' });
    else child.kill();
  } catch (err) { /* процесс уже завершился */ }
}

function postConfig(base, body) {
  return fetch(base + '/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  }).then(async (response) => ({ status: response.status, data: await response.json().catch(() => null) }));
}

// ---------- статика: в странице не осталось ничего про пароль ----------

function staticTests() {
  const html = readText(INDEX_FILE);
  const client = readText(CLIENT_FILE);
  const app = readText(APP_FILE);
  const sw = readText(SW_FILE);

  pass('S01 в index.html нет поля пароля', !/type="password"|settingsPassword|calibPassword/.test(html));
  pass('S02 index.html не грузит owner-key.js', !/owner-key\.js/.test(html));
  pass('S03 в клиенте нет заголовка x-admin-password', !/x-admin-password/.test(client));
  pass('S04 в клиенте нет сохранения пароля', !/ownerPassword|setOwnerPassword|verifyStoredPassword/.test(client));
  pass('S05 canEdit требует серверный конфиг',
    /function canEdit\(\)\s*\{\s*return configSource === 'server';\s*\}/.test(app));
  pass('S06 service worker не знает про owner-key.js', !/owner-key\.js/.test(sw));
  pass('S07 sw.js и index.html не ссылаются на удалённый файл',
    !existsSync(path.join(ROOT, 'public', 'js', 'owner-key.js')));
}

// ---------- инстанс с временным конфигом: открытая запись ----------

async function suiteOpenConfig(base, dir) {
  const health = await waitUp(base);
  pass('A01 health отвечает', health.ok === true, JSON.stringify(health));
  pass('A02 в health нет признака пароля', !('ownerPassword' in health), Object.keys(health).join(','));
  pass('A03 timezone московский', health.timezone === 'GMT+3 (МСК)', health.timezone);
  pass('A04 ключ приёмника по умолчанию выключен', health.receiverKey === 'off', health.receiverKey);

  const first = await fetch(base + '/api/config');
  const firstBody = await first.json();
  pass('A05 GET /api/config открыт', first.status === 200, first.status);
  pass('A06 источник — сервер', firstBody.source === 'server', firstBody.source);
  pass('A07 по умолчанию 120 / 3 / 25',
    firstBody.config.day.red === 120 && firstBody.config.day.yellow === 3 && firstBody.config.day.green === 25,
    JSON.stringify(firstBody.config.day));

  const desired = Object.assign({}, firstBody.config, {
    day: { red: 77, yellow: 4, green: 33, phaseStart: '07:15:00' }
  });
  const saved = await postConfig(base, desired);
  pass('A08 POST конфига без заголовков → 200', saved.status === 200, saved.status);
  pass('A09 ответ содержит сохранённый цикл', !!saved.data && saved.data.config.day.red === 77,
    saved.data ? JSON.stringify(saved.data.config.day) : 'нет тела');

  const reread = await (await fetch(base + '/api/config')).json();
  pass('A10 GET видит правку', reread.config.day.red === 77 && reread.config.day.green === 33,
    JSON.stringify(reread.config.day));
  pass('A11 момент старта сохранился', reread.config.day.phaseStart === '07:15:00', reread.config.day.phaseStart);

  const file = path.join(dir, 'settings.json');
  const onDisk = readText(file);
  let parsed = null;
  try { parsed = JSON.parse(onDisk); } catch (err) { parsed = null; }
  pass('A12 правка легла в файл на диске', parsed !== null && parsed.day && parsed.day.red === 77,
    parsed ? JSON.stringify(parsed.day) : onDisk.slice(0, 40));
  pass('A13 файл записан с LF', onDisk.length > 0 && !onDisk.includes('\r\n'));

  const empty = await postConfig(base, '');
  pass('A14 пустое тело → 400', empty.status === 400, empty.status);
  const broken = await postConfig(base, '{nope');
  pass('A15 битый JSON → 400', broken.status === 400, broken.status);
  const nullBody = await postConfig(base, 'null');
  pass('A16 null → 422', nullBody.status === 422, nullBody.status);

  const admin = await fetch(base + '/api/admin/check', { method: 'POST' });
  pass('A17 /api/admin/check больше нет → 404', admin.status === 404, admin.status);

  const csv = await fetch(base + '/api/export.csv?days=7');
  pass('A18 выгрузка без заголовков → 200', csv.status === 200, csv.status);
  pass('A19 выгрузка отдаётся как CSV',
    (csv.headers.get('content-type') || '').includes('text/csv'), csv.headers.get('content-type'));
  pass('A20 выгрузка не кэшируется', csv.headers.get('cache-control') === 'no-store',
    csv.headers.get('cache-control'));

  const unknown = await fetch(base + '/api/nope');
  pass('A21 неизвестный адрес API → 404', unknown.status === 404, unknown.status);

  // раздача статики: ошибка в импортах сервера роняет её в 500 только здесь
  const page = await fetch(base + '/');
  const pageText = await page.text();
  pass('A24 страница отдаётся', page.status === 200 && pageText.includes('<title>Светофор'), page.status);
  const script = await fetch(base + '/js/app.js');
  pass('A25 скрипт интерфейса отдаётся',
    script.status === 200 && (script.headers.get('content-type') || '').includes('javascript'), script.status);

  // отметка по-прежнему принимается и попадает в сводку — без пароля
  const mark = await fetch(base + '/api/observations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ display: 'red', observed: 'red', profile: 'day', device: 'test-device',
      phaseElapsedMs: 1000, durationMs: 148000 })
  });
  pass('A22 отметка без ключа → 201', mark.status === 201, mark.status);
  const exportText = await (await fetch(base + '/api/export.csv?days=7')).text();
  pass('A23 отметка видна в выгрузке', exportText.includes('test-device'), exportText.split('\n')[1] || '');
}

// ---------- лимит записи: файл не должен забиваться частыми POST ----------

async function suiteWriteLimit(base) {
  await waitUp(base);
  const codes = [];
  for (let i = 0; i <= WRITE_LIMIT; i++) {
    codes.push((await postConfig(base, { day: { red: 100 + i, yellow: 3, green: 25 } })).status);
  }
  const accepted = codes.filter((c) => c === 200).length;
  pass('B01 в минуту проходит не больше ' + WRITE_LIMIT + ' записей', accepted === WRITE_LIMIT, 'успехов=' + accepted);
  pass('B02 лишняя запись → 429', codes.includes(429), '429 с №' + (codes.indexOf(429) + 1));
  pass('B03 чтение расписания лимит не задевает', (await fetch(base + '/api/config')).status === 200);
}

// ---------- ключ приёмника остаётся отдельной защитой отметок ----------

async function suiteReceiverKey(base, key) {
  await waitUp(base);
  const health = await (await fetch(base + '/api/health')).json();
  pass('C01 health: ключ приёмника включён', health.receiverKey === 'on', health.receiverKey);
  const denied = await fetch(base + '/api/observations', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"display":"red"}'
  });
  pass('C02 отметка без ключа → 403', denied.status === 403, denied.status);
  const allowed = await fetch(base + '/api/observations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-feedback-key': key },
    body: JSON.stringify({ display: 'red', observed: 'red', profile: 'day', device: 'keyed',
      phaseElapsedMs: 1000, durationMs: 148000 })
  });
  pass('C03 отметка с ключом → 201', allowed.status === 201, allowed.status);
  pass('C04 цикл пишется и с ключом приёмника', (await postConfig(base, { day: { red: 90 } })).status === 200);
}

// ---------- живой сервер ----------

async function runAgainstBase() {
  const health = await waitUp(BASE);
  pass('L01 живой сервер отвечает', health.ok === true);
  pass('L02 в health нет признака пароля', !('ownerPassword' in health), Object.keys(health).join(','));

  const current = await (await fetch(BASE + '/api/config')).json();
  pass('L03 расписание читается', current.source === 'server' && !!current.config);

  // отправляем то же содержимое: файл остаётся прежним
  const same = await postConfig(BASE, current.config);
  pass('L04 запись конфига открыта (без заголовков)', same.status === 200, same.status);
  const after = await (await fetch(BASE + '/api/config')).json();
  pass('L05 цикл не изменился', JSON.stringify(after.config) === JSON.stringify(current.config));

  pass('L06 выгрузка открыта', (await fetch(BASE + '/api/export.csv?days=7')).status === 200);
  pass('L07 /api/admin/check → 404', (await fetch(BASE + '/api/admin/check')).status === 404);
  skip('L08..L09 лимит записи и запись в файл', 'по живому серверу не проверяются');
}

async function runSpawned() {
  const instances = [];
  const dirs = [];
  const launch = async (env) => {
    const port = await freePort();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'svetofor-api-'));
    dirs.push(dir);
    instances.push(start(port, Object.assign({ CONFIG_FILE: path.join(dir, 'settings.json'), DATA_DIR: path.join(dir, 'data') }, env || {})));
    return { base: 'http://localhost:' + port, dir };
  };
  try {
    const open = await launch();
    await suiteOpenConfig(open.base, open.dir);
    await suiteWriteLimit((await launch()).base);
    await suiteReceiverKey((await launch({ FEEDBACK_KEY: 'receiver-secret-0123456789' })).base,
      'receiver-secret-0123456789');
  } finally {
    instances.forEach(stop);
    dirs.forEach((dir) => { try { rmSync(dir, { recursive: true, force: true }); } catch (err) { /* уже удалён */ } });
  }
}

staticTests();
if (BASE) await runAgainstBase();
else await runSpawned();

const failed = results.filter((r) => r.status === 'FAIL');
for (const r of results) {
  console.log((r.status === 'ok' ? '  ok  ' : r.status === 'skip' ? ' skip ' : ' FAIL ') + r.name +
    (r.detail ? '   [' + r.detail + ']' : ''));
}
const counted = results.filter((r) => r.status !== 'skip').length;
console.log('\n' + (counted - failed.length) + '/' + counted + ' пройдено' +
  (results.length - counted ? ', пропущено ' + (results.length - counted) : ''));
process.exit(failed.length ? 1 : 0);
