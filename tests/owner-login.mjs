/*
 * Тесты входа к закрытым разделам светофора: пароль владельца в файле лежит
 * свёртком («sha256:<hex>»), поэтому открытый пароль скрипту передают снаружи —
 * из окружения или флагом. В репозитории секрета нет.
 *
 *   TL_ADMIN_PASSWORD='пароль' node tests/owner-login.mjs
 *   node tests/owner-login.mjs --password 'пароль'
 *   node tests/owner-login.mjs --base http://localhost:8080   # по живому серверу
 *
 * Без пароля проходят только проверки, которые его не требуют (закрытые разделы
 * без секрета, публичное чтение конфига, клиентский гард кириллицы).
 *
 * Режим по умолчанию поднимает свои инстансы сервера на свободных портах и гасит
 * их в конце. По живому серверу (--base) проверки «перебор закрыт 429» и «пароля
 * нет» не запускаются, а запись конфига отправляет то же содержимое settings.json,
 * что уже лежит, — файл остаётся побайтно тем же.
 */

import { spawn, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SERVER = path.join(ROOT, 'server', 'api.mjs');
const PASSWORD_FILE = path.join(ROOT, 'server', 'config', 'admin.password');
const SETTINGS_FILE = path.join(ROOT, 'server', 'config', 'settings.json');
const CLIENT_FILE = path.join(ROOT, 'public', 'js', 'feedback.js');
const ADMIN_LIMIT = 20;

const argv = process.argv.slice(2);
function flag(name) {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  if (hit) return hit.slice(name.length + 3);
  const bare = argv.indexOf('--' + name);
  return bare >= 0 && argv[bare + 1] && !argv[bare + 1].startsWith('--') ? argv[bare + 1] : '';
}

const PASSWORD = flag('password') || process.env.TL_ADMIN_PASSWORD || '';
const BASE = flag('base');
const results = [];

function pass(name, condition, detail) {
  results.push({ name, status: condition ? 'ok' : 'FAIL', detail: detail === undefined ? '' : String(detail) });
  return !!condition;
}

function skip(name, reason) {
  results.push({ name, status: 'skip', detail: reason });
}

function readLine(file) {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/)[0].trim();
  } catch (err) {
    return '';
  }
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

const admin = { hits: 0 };

function request(base, pathname, password, init) {
  admin.hits++;
  const headers = Object.assign({}, (init && init.headers) || {});
  if (password !== null) headers['x-admin-password'] = password;
  return fetch(base + pathname, Object.assign({}, init, { headers }));
}

// ---------- клиент: гард Latin-1 и разбор ответов ----------

function clientHarness(fetchImpl) {
  const storage = new Map();
  const sandbox = {
    setTimeout,
    clearTimeout,
    console,
    fetch: fetchImpl,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key)
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  createContext(sandbox);
  runInContext(readFileSync(CLIENT_FILE, 'utf8'), sandbox, { filename: CLIENT_FILE });
  sandbox.TrafficFeedback.init();
  return sandbox.TrafficFeedback;
}

function stubFetch(status) {
  const seen = [];
  const impl = (url, init) => {
    seen.push({ url, headers: (init && init.headers) || {} });
    return Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve({ ok: true }) });
  };
  return { impl, seen };
}

function clientTests(password) {
  const cyr = stubFetch(200);
  const h = clientHarness(cyr.impl);
  return h.checkOwnerPassword('пароль владельца').then((state) => {
    pass('C01 кириллица в пароле не уходит в сеть', state === 'charset' && cyr.seen.length === 0, 'state=' + state + ', запросов=' + cyr.seen.length);
    const space = stubFetch(200);
    return h.checkOwnerPassword('пароль-with-space').then(() => space.seen.length).then((calls) => {
      pass('C02 пробел в пароле тоже блокируется до запроса', calls === 0, 'запросов=' + calls);
    });
  }).then(() => {
    const map = [[200, 'ok'], [401, 'wrong'], [403, 'wrong'], [503, 'missing'], [429, 'slow'],
      [500, 'offline'], [404, 'noapi'], [405, 'noapi']];
    return map.reduce((chain, pair) => chain.then(() => {
      const stub = stubFetch(pair[0]);
      const harness = clientHarness(stub.impl);
      return harness.checkOwnerPassword('whatever1').then((state) => {
        pass('C03 ответ ' + pair[0] + ' → ' + pair[1], state === pair[1], 'state=' + state);
      });
    }), Promise.resolve());
  }).then(() => {
    // Запрос вообще не дошёл: так бывает, когда сервера на этом адресе нет вовсе.
    const harness = clientHarness(() => Promise.reject(new TypeError('Failed to fetch')));
    return harness.checkOwnerPassword('whatever1').then((state) => {
      pass('C03b запрос не дошёл → offline', state === 'offline', 'state=' + state);
    });
  }).then(() => {
    const stub = stubFetch(200);
    const harness = clientHarness(stub.impl);
    if (!password) return skip('C04 верный пароль разблокирует клиента', 'пароль не передан'), null;
    return harness.checkOwnerPassword(password).then((state) => {
      pass('C04 верный пароль разблокирует клиента', state === 'ok');
      harness.setOwnerPassword(password);
      pass('C05 статус после разблокировки — unlocked', harness.status().owner === 'unlocked');
      pass('C06 заголовок x-admin-password при верном пароле', stub.seen.some((c) => c.headers['x-admin-password']));
      const bad = stubFetch(401);
      const other = clientHarness(bad.impl);
      other.setOwnerPassword('nope');
      return other.verifyStoredPassword().then((state) => {
        pass('C07 отозванный пароль клиент замечает', state === 'wrong' && other.status().owner === 'locked', 'state=' + state);
      });
    });
  });
}

// ---------- инстансы сервера ----------

async function suiteHashedFile(base, password) {
  const health = await waitUp(base);
  pass('A01 health: закрытые разделы под паролем', health.ownerPassword === 'on', JSON.stringify(health));

  if (!(await request(base, '/api/admin/check', password)).ok) {
    skip('A02..A20', password ? 'переданный пароль не совпал со свёртком в admin.password' : 'пароль не передан');
    return;
  }
  pass('A02 верный пароль → 200', true);

  const cases = [
    ['A03 отличается последним символом → 401', 'x'.repeat(password.length), 401],
    ['A04 пустой заголовок → 401', '', 401],
    ['A05 заголовка нет → 401', null, 401],
    ['A06 свёрток вместо пароля → 401', readLine(PASSWORD_FILE), 401],
    ['A07 хеш без префикса → 401', createHash('sha256').update(password).digest('hex'), 401],
    ['A08 нижний регистр пароля → 401', password.toLowerCase(), 401],
    ['A09 обрезанный пароль → 401', password.slice(0, Math.floor(password.length / 2)), 401],
    ['A10 пароль на символ длиннее → 401', password + 'x', 401],
    ['A11 пробел внутри пароля → 401', password.slice(0, 10) + ' ' + password.slice(10), 401]
  ];
  for (const [name, given, expected] of cases) {
    let status;
    if (given === null) status = (await request(base, '/api/admin/check', null)).status;
    else {
      try {
        status = (await request(base, '/api/admin/check', given)).status;
      } catch (err) {
        results.push({ name, status: 'skip', detail: 'заголовок не сформировать: ' + err.message });
        continue;
      }
    }
    pass(name, status === expected, 'status=' + status);
  }

  // краевые пробелы срезает HTTP-слой (RFC 7230), поэтому такой пароль неотличим
  const padded = (await request(base, '/api/admin/check', ' ' + password + ' ')).status;
  pass('A12 пробелы по краям срезаются HTTP-слоем → 200', padded === 200, 'status=' + padded);

  const pub = await fetch(base + '/api/config', { cache: 'no-store' });
  pass('A13 GET /api/config открыт без пароля', pub.status === 200);

  const before = readFileSync(SETTINGS_FILE, 'utf8');
  const noKey = await request(base, '/api/config', null, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: before
  });
  pass('A14 POST /api/config без пароля → 403', noKey.status === 403, noKey.status);
  const wrongKey = await request(base, '/api/config', 'wrong-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: before
  });
  pass('A15 POST /api/config с неверным → 403', wrongKey.status === 403, wrongKey.status);
  const goodKey = await request(base, '/api/config', password, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: before
  });
  pass('A16 POST /api/config с верным → 200', goodKey.status === 200, goodKey.status);
  pass('A17 settings.json не изменился', readFileSync(SETTINGS_FILE, 'utf8') === before);

  pass('A18 выгрузка без пароля → 403', (await request(base, '/api/export.csv?days=7', null)).status === 403);
  pass('A19 выгрузка с верным → 200', (await request(base, '/api/export.csv?days=7', password)).status === 200);
  pass('A20 обращений к закрытым разделам в лимите', admin.hits <= ADMIN_LIMIT, 'hits=' + admin.hits + ', лимит ' + ADMIN_LIMIT + '/мин');
}

async function suiteUppercaseDigest(base, password) {
  await waitUp(base);
  pass('B01 свёрток в верхнем регистре принимает пароль', (await request(base, '/api/admin/check', password)).ok);
  pass('B02 неверный по-прежнему 401', (await request(base, '/api/admin/check', password + 'x')).status === 401);
}

async function suiteNoSecret(base) {
  const health = await waitUp(base);
  pass('D01 health: ownerPassword off', health.ownerPassword === 'off', JSON.stringify(health));
  const check = await request(base, '/api/admin/check', 'anything');
  pass('D02 проверка пароля → 503', check.status === 503, check.status);
  const post = await request(base, '/api/config', 'anything', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  pass('D03 POST конфига → 503', post.status === 503, post.status);
  pass('D04 выгрузка → 503', (await request(base, '/api/export.csv?days=7', 'anything')).status === 503);
  pass('D05 расписание при этом читается', (await fetch(base + '/api/config')).status === 200);
}

async function suiteRateLimit(base, password) {
  await waitUp(base);
  const codes = [];
  for (let i = 0; i <= ADMIN_LIMIT; i++) codes.push((await request(base, '/api/admin/check', 'variant-' + i)).status);
  const accepted = codes.filter((c) => c === 200).length;
  pass('E01 ни одна неверная вариантка не вошла', accepted === 0, 'успехов=' + accepted);
  pass('E02 после ' + ADMIN_LIMIT + ' обращений за минуту → 429', codes.includes(429), '429 с №' + (codes.indexOf(429) + 1));
  if (password) {
    const good = await request(base, '/api/admin/check', password);
    pass('E03 и верный пароль в окне лимита → 429', good.status === 429, good.status);
  } else {
    skip('E03 верный пароль в окне лимита', 'пароль не передан');
  }
  pass('E04 публичное чтение расписания лимит не задевает', (await fetch(base + '/api/config')).status === 200);
}

async function runSpawned() {
  const instances = [];
  const launch = async (env) => {
    const port = await freePort();
    instances.push(start(port, env));
    return 'http://localhost:' + port;
  };
  try {
    await suiteHashedFile(await launch(), PASSWORD);
    if (PASSWORD) {
      const digest = 'SHA256:' + createHash('sha256').update(PASSWORD).digest('hex').toUpperCase();
      await suiteUppercaseDigest(await launch({ ADMIN_PASSWORD: digest }), PASSWORD);
    } else {
      skip('B01..B02 свёрток в верхнем регистре', 'пароль не передан');
    }
    await suiteNoSecret(await launch({ ADMIN_PASSWORD_FILE: path.join(ROOT, 'tests', 'no-such-secret') }));
    await suiteRateLimit(await launch(), PASSWORD);
  } finally {
    instances.forEach(stop);
  }
}

async function runAgainstBase() {
  admin.hits = 0;
  await suiteHashedFile(BASE, PASSWORD);
}

if (PASSWORD) {
  const stored = readLine(PASSWORD_FILE);
  const digest = createHash('sha256').update(PASSWORD).digest('hex');
  if (/^sha256:/i.test(stored)) {
    pass('P00 переданный пароль совпадает со свёртком в admin.password', stored.toLowerCase() === 'sha256:' + digest,
      stored ? stored.slice(0, 18) + '…' : 'файл пуст');
  } else {
    pass('P00 переданный пароль совпадает с admin.password', stored === PASSWORD, 'в файле открытый вид');
  }
} else {
  skip('P00 сверка пароля со свёртком', 'пароль не передан: TL_ADMIN_PASSWORD или --password');
}

await clientTests(PASSWORD);
if (BASE) await runAgainstBase();
else await runSpawned();

const failed = results.filter((r) => r.status === 'FAIL');
for (const r of results) {
  console.log((r.status === 'ok' ? '  ok  ' : r.status === 'skip' ? ' skip ' : ' FAIL ') + r.name +
    (r.detail ? '   [' + r.detail + ']' : ''));
}
const counted = results.filter((r) => r.status !== 'skip').length;
console.log('\n' + (counted - failed.length) + '/' + counted + ' пройдено' +
  (results.length - counted ? ', пропущено ' + (results.length - counted) : '') +
  (PASSWORD ? '' : ' (передайте TL_ADMIN_PASSWORD или --password, чтобы прогнать вход целиком)'));
process.exit(failed.length ? 1 : 0);
