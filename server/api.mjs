/*
 * Приёмник отметок, раздача страницы и серверный конфиг светофора.
 * Без внешних зависимостей: Node 18+.
 *
 *   node server/api.mjs            → http://localhost:8080
 *
 * Часы алгоритма — московские (GMT+3): файл отметок разбивается по московским
 * дням, как и сам цикл, который стартует с красного в полночь по МСК.
 *
 * Отметки складываются в отдельную папку server/data/observations в виде
 * таблицы: по одному JSONL-файлу на день, одна строка = одна отметка.
 * /api/export.csv собирает из них единую таблицу — только по паролю владельца.
 *
 * Настройки цикла лежат в server/config/settings.json и правятся по FTP:
 * страница читает их через GET /api/config и перечитывает каждые 15 с, поэтому
 * правка файла на сервере доходит до всех телефонов сама, без доступа к браузеру.
 * Пароль владельца — в server/config/admin.password (одна строка) или в
 * ADMIN_PASSWORD. Файл может хранить и хеш: «sha256:<hex>».
 *
 * Переменные окружения:
 *   PORT                порт (по умолчанию 8080)
 *   DATA_DIR            папка с таблицей (по умолчанию server/data/observations)
 *   CONFIG_FILE         файл настроек цикла (по умолчанию server/config/settings.json)
 *   ADMIN_PASSWORD      пароль для выгрузки и записи конфига; иначе читаем файл
 *   ADMIN_PASSWORD_FILE путь к файлу с паролем (по умолчанию server/config/admin.password)
 *   FEEDBACK_KEY        если задан, отметки принимаются только с заголовком
 *                       x-feedback-key; страница должна передать его в meta-теге
 *   STATIC_DIR          папка со страницей (по умолчанию public)
 */

import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || path.join(ROOT, 'public'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'server', 'data', 'observations'));
const CONFIG_FILE = path.resolve(process.env.CONFIG_FILE || path.join(ROOT, 'server', 'config', 'settings.json'));
const ADMIN_PASSWORD_FILE = path.resolve(
  process.env.ADMIN_PASSWORD_FILE || path.join(ROOT, 'server', 'config', 'admin.password')
);
const PORT = Number(process.env.PORT || 8080);
const FEEDBACK_KEY = process.env.FEEDBACK_KEY || '';
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || readSecretFile(ADMIN_PASSWORD_FILE) || '').trim();
const MAX_BODY = 8192;
const MAX_WINDOW_DAYS = 90;
const CONFIG_TTL_MS = 15000;
const MSK_OFFSET_MS = 180 * 60000;
const RATE_LIMIT = { windowMs: 60000, max: 120 };
// пароль набирают с телефона и ошибаются; но и перебирать его не должно быть
// раздолья: 20 обращений к закрытым разделам в минуту на адрес
const ADMIN_RATE_LIMIT = { windowMs: 60000, max: 20 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8'
};

await mkdir(DATA_DIR, { recursive: true });

function readSecretFile(file) {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/)[0] : '';
  } catch (err) {
    return '';
  }
}

const buckets = new Map();
const adminBuckets = new Map();

function hit(store, ip, limit) {
  const now = Date.now();
  const bucket = store.get(ip) || { start: now, count: 0 };
  if (now - bucket.start > limit.windowMs) {
    bucket.start = now;
    bucket.count = 0;
  }
  bucket.count++;
  store.set(ip, bucket);
  if (store.size > 5000) {
    for (const [key, value] of store) if (now - value.start > limit.windowMs) store.delete(key);
  }
  return bucket.count > limit.max;
}

function rateLimited(ip) {
  return hit(buckets, ip, RATE_LIMIT);
}

// Таблица разбивается по московским дням — так же, как привязан к МСК и цикл.
function dayKey(timestamp) {
  return new Date(timestamp + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

// Разрешённые значения полей: таблица не должна принимать мусор с клиента.
const PHASES = new Set(['red', 'yellow', 'green', 'flashing']);
const ANSWERS = new Set(['red', 'green']);
const PROFILES = new Set(['day', 'night']);

function toInt(value, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

// ---------- конфиг цикла (правится по FTP в server/config/settings.json) ----------

const MODES = new Set(['flashing', 'cycle']);
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
// Момент, в который по расписанию включается красный: «ЧЧ:ММ», «ЧЧ:ММ:СС»
// или число секунд от полуночи МСК.
const PHASE_RE = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

const DEFAULT_CONFIG = {
  day: { red: 120, yellow: 3, green: 25, phaseStart: '00:00:00' },
  night: { enabled: false, start: '23:00', end: '06:00', mode: 'flashing', cycle: { red: 60, yellow: 3, green: 25, phaseStart: '23:00:00' } }
};

function normalizeDurations(raw, fallback) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    red: toInt(src.red, 1, 3600) ?? fallback.red,
    yellow: toInt(src.yellow, 1, 60) ?? fallback.yellow,
    green: toInt(src.green, 1, 3600) ?? fallback.green,
    phaseStart: phaseStartOf(src.phaseStart, fallback.phaseStart)
  };
}

// Секунды от полуночи МСК в «ЧЧ:ММ:СС». Значение вне суток или битая строка —
// дефолт, страницу оно не ломает.
function padClock(value) {
  const seconds = Math.max(0, Math.min(86399, Math.round(value)));
  const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  return h + ':' + m + ':' + s;
}

function phaseStartOf(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 0 && value < 86400 ? padClock(value) : fallback;
  }
  const text = String(value == null ? '' : value).trim();
  const match = PHASE_RE.exec(text);
  if (match) {
    return padClock(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] || 0));
  }
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return seconds < 86400 ? padClock(seconds) : fallback;
  }
  return fallback;
}

// Приводим любое содержимое файла к валидному виду: битое значение не должно
// уронить страницу — оно молча заменяется значением по умолчанию.
// Окно ночного времени приходит в двух формах: файл конфига
// { night: { enabled, start, end, mode, cycle } } и форма со страницы
// { nightEnabled, nightStart, nightEnd, nightMode, night: { red, yellow, green } }.
function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const block = src.night && typeof src.night === 'object' ? src.night : {};
  const nested = block.enabled !== undefined || typeof block.start === 'string';
  const enabled = nested ? block.enabled === true : src.nightEnabled === true;
  const start = nested ? block.start : src.nightStart;
  const end = nested ? block.end : src.nightEnd;
  const mode = nested ? block.mode : src.nightMode;
  const nightStart = padTime(TIME_RE.test(String(start || '')) ? start : DEFAULT_CONFIG.night.start);
  const nightEnd = padTime(TIME_RE.test(String(end || '')) ? end : DEFAULT_CONFIG.night.end);
  // Якорь по умолчанию продолжает прежнее поведение: дневной цикл начинается
  // с красного сразу после ночного окна, а без ночи — в полночь; ночной цикл —
  // в начало ночного окна.
  const dayFallback = Object.assign({}, DEFAULT_CONFIG.day,
    { phaseStart: enabled ? nightEnd + ':00' : DEFAULT_CONFIG.day.phaseStart });
  const nightFallback = Object.assign({}, DEFAULT_CONFIG.night.cycle, { phaseStart: nightStart + ':00' });
  const cycle = normalizeDurations(nested ? block.cycle : block, nightFallback);
  return {
    day: normalizeDurations(src.day, dayFallback),
    night: {
      enabled: enabled,
      start: nightStart,
      end: nightEnd,
      mode: MODES.has(String(mode)) ? String(mode) : DEFAULT_CONFIG.night.mode,
      cycle: cycle
    }
  };
}

function padTime(value) {
  const parts = String(value).split(':');
  return String(Number(parts[0])).padStart(2, '0') + ':' + String(Number(parts[1])).padStart(2, '0');
}

// То, чего ждёт public/js/schedule.js
function toClientConfig(config) {
  return {
    day: config.day,
    night: config.night.cycle,
    nightEnabled: config.night.enabled,
    nightStart: config.night.start,
    nightEnd: config.night.end,
    nightMode: config.night.mode
  };
}

let configCache = { mtimeMs: -1, size: -1, stamp: 0, config: null };

async function loadConfig() {
  const now = Date.now();
  let info = null;
  try {
    info = await stat(CONFIG_FILE);
  } catch (err) {
    info = null; // файла нет — отдаём дефолт и пробуем его создать
  }
  const fresh = configCache.config !== null &&
    now - configCache.stamp < CONFIG_TTL_MS &&
    info !== null && info.mtimeMs === configCache.mtimeMs && info.size === configCache.size;
  if (fresh) return configCache.config;

  if (info === null) {
    const boot = normalizeConfig(DEFAULT_CONFIG);
    await writeFile(CONFIG_FILE, configToJson(boot), 'utf8').catch(() => {});
    configCache = { mtimeMs: -1, size: -1, stamp: now, config: boot };
    return boot;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  } catch (err) {
    parsed = null; // невалидный JSON после ручной правки — держим последний хороший
  }
  const config = parsed === null ? (configCache.config || normalizeConfig(DEFAULT_CONFIG)) : normalizeConfig(parsed);
  configCache = { mtimeMs: info.mtimeMs, size: info.size, stamp: now, config: config };
  return config;
}

function configToJson(config) {
  return JSON.stringify(config, null, 2) + '\n';
}

async function saveConfig(config) {
  const normalized = normalizeConfig(config);
  await writeFile(CONFIG_FILE, configToJson(normalized), 'utf8');
  configCache = { mtimeMs: -1, size: -1, stamp: Date.now(), config: normalized };
  return normalized;
}

function equalSecrets(given, expected) {
  const a = Buffer.from(String(given), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  // timingSafeEqual требует равной длины; неравную сравниваем через хеши,
  // чтобы длина пароля не читалась по времени ответа
  if (a.length === b.length) {
    try { return timingSafeEqual(a, b); } catch (err) { return false; }
  }
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

// В файле пароля можно хранить сам секрет одной строкой, можно хеш:
// «sha256:<hex>» — тогда утечка дерева сервера не отдаёт готовый пароль.
function matchesPassword(request) {
  if (!ADMIN_PASSWORD) return false;
  const given = String(request.headers['x-admin-password'] || '');
  if (!given) return false;
  if (/^sha256:[0-9a-f]{64}$/i.test(ADMIN_PASSWORD)) {
    const hex = createHash('sha256').update(given, 'utf8').digest('hex');
    return equalSecrets(hex, ADMIN_PASSWORD.slice(7).toLowerCase());
  }
  return equalSecrets(given, ADMIN_PASSWORD);
}

function normalizeRow(body, receivedAt) {
  if (!body || typeof body !== 'object') return null;
  const ts = toInt(body.ts, 1577836800000, receivedAt + 86400000);
  const display = String(body.display || '');
  const observed = String(body.observed || '');
  if (!PHASES.has(display) || !ANSWERS.has(observed)) return null;

  const elapsed = toInt(body.phaseElapsedMs, 0, 3600000);
  const duration = toInt(body.durationMs, 0, 3600000);
  if (elapsed === null || duration === null) return null;

  const remaining = body.remainingMs === null || body.remainingMs === undefined
    ? null
    : toInt(body.remainingMs, 0, 3600000);
  const shift = body.shiftMs === null || body.shiftMs === undefined
    ? null
    : toInt(body.shiftMs, -3600000, 3600000);
  const offset = toInt(body.clockOffsetMs, -86400000, 86400000);
  const device = String(body.device || '').slice(0, 32).replace(/[^a-zA-Z0-9_-]/g, '');

  return {
    ts: ts === null ? receivedAt : ts,
    received_at: receivedAt,
    device: device || 'unknown',
    profile: PROFILES.has(String(body.profile)) ? String(body.profile) : 'day',
    display: display,
    observed: observed,
    phase_elapsed_ms: elapsed,
    remaining_ms: remaining,
    duration_ms: duration,
    clock_offset_ms: offset === null ? 0 : offset,
    shift_ms: shift,
    match: display === observed
  };
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  const rank = (sortedValues.length - 1) * p;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sortedValues[low];
  return sortedValues[low] + (sortedValues[high] - sortedValues[low]) * (rank - low);
}

async function readRows(days) {
  const files = (await readdir(DATA_DIR)).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
  const wanted = files.slice(Math.max(0, files.length - Math.max(1, Math.min(days, MAX_WINDOW_DAYS))));
  const rows = [];
  for (const name of wanted) {
    const text = await readFile(path.join(DATA_DIR, name), 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch (err) {
        // битая строка не должна ронять весь выгруз
      }
    }
  }
  return rows;
}

function summarize(rows) {
  const shifts = [];
  let early = 0;
  let late = 0;
  let confirms = 0;
  const devices = new Set();
  for (const row of rows) {
    devices.add(row.device);
    if (row.match === true) { confirms++; continue; }
    if (typeof row.shift_ms !== 'number') continue;
    shifts.push(row.shift_ms / 1000);
    if (row.shift_ms > 0) early++; else late++;
  }
  shifts.sort((a, b) => a - b);
  return {
    ok: true,
    rows: rows.length,
    devices: devices.size,
    confirms: confirms,
    mismatches: shifts.length,
    early: early,
    late: late,
    medianShift: percentile(shifts, 0.5),
    p90Shift: percentile(shifts, 0.9)
  };
}

function toCsv(rows) {
  const header = ['timestamp_iso', 'timestamp_msk', 'received_at_iso', 'device', 'profile', 'displayed', 'observed',
    'phase_elapsed_s', 'remaining_s', 'phase_duration_s', 'clock_offset_s', 'shift_s', 'match'];
  const lines = [header.join(';')];
  for (const row of rows) {
    lines.push([
      new Date(row.ts).toISOString(),
      mskStamp(row.ts),
      new Date(row.received_at).toISOString(),
      row.device,
      row.profile,
      row.display,
      row.observed,
      (row.phase_elapsed_ms / 1000).toFixed(3),
      row.remaining_ms == null ? '' : (row.remaining_ms / 1000).toFixed(3),
      (row.duration_ms / 1000).toFixed(3),
      (row.clock_offset_ms / 1000).toFixed(3),
      typeof row.shift_ms === 'number' ? (row.shift_ms / 1000).toFixed(3) : '',
      row.match ? 'yes' : 'no'
    ].join(';'));
  }
  return '\ufeff' + lines.join('\r\n');
}

// Отметки смотрят по московским стенам: цикл и ночное окно привязаны к МСК.
function mskStamp(timestamp) {
  const shifted = new Date(timestamp + MSK_OFFSET_MS);
  const pad = (n) => (n < 10 ? '0' : '') + n;
  return shifted.getUTCFullYear() + '-' + pad(shifted.getUTCMonth() + 1) + '-' + pad(shifted.getUTCDate()) +
    ' ' + pad(shifted.getUTCHours()) + ':' + pad(shifted.getUTCMinutes()) + ':' + pad(shifted.getUTCSeconds());
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        // дочитываем и отбрасываем остальное, чтобы клиент получил 413, а не обрыв
        request.removeAllListeners('data');
        request.resume();
        reject(new Error('too-large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

function serveStatic(request, response, url) {
  const relative = decodeURIComponent(url.pathname);
  const requested = relative === '/' ? 'index.html' : relative.replace(/^\/+/, '');
  const target = path.resolve(STATIC_DIR, requested);
  // выход за пределы STATIC_DIR запрещён
  if (target !== STATIC_DIR && !target.startsWith(STATIC_DIR + path.sep)) {
    response.writeHead(403).end('forbidden');
    return;
  }
  if (!existsSync(target)) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    return;
  }
  readFile(target).then((data) => {
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    const headers = { 'content-type': type };
    // свёрток пароля меняется при смене пароля — кэшировать его нельзя
    if (target.endsWith('owner-key.js')) {
      headers['cache-control'] = 'no-store';
    } else if (target.endsWith('index.html') || target.endsWith('add-to-home.html') || target.endsWith('sw.js')) {
      headers['cache-control'] = 'no-cache';
    } else if (type.startsWith('image/') || type.startsWith('text/css') || type.startsWith('text/javascript')) {
      headers['cache-control'] = 'public, max-age=3600';
    }
    response.writeHead(200, headers).end(data);
  }).catch(() => {
    response.writeHead(500).end('read error');
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const ip = (request.headers['x-forwarded-for'] || request.socket.remoteAddress || 'unknown')
    .toString().split(',')[0].trim();

  if (request.method === 'HEAD' && url.pathname !== '/api/observations') {
    response.writeHead(200, { date: new Date().toUTCString() }).end();
    return;
  }

  if (url.pathname === '/api/health') {
    json(response, 200, {
      ok: true,
      timezone: 'GMT+3 (МСК)',
      receiverKey: FEEDBACK_KEY ? 'on' : 'off',
      ownerPassword: ADMIN_PASSWORD ? 'on' : 'off'
    });
    return;
  }

  if (url.pathname === '/api/observations' && request.method === 'POST') {
    if (FEEDBACK_KEY && request.headers['x-feedback-key'] !== FEEDBACK_KEY) {
      json(response, 403, { ok: false, error: 'key' });
      return;
    }
    if (rateLimited(ip)) {
      json(response, 429, { ok: false, error: 'rate-limit' });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(request));
    } catch (err) {
      json(response, err.message === 'too-large' ? 413 : 400, { ok: false, error: 'bad-body' });
      return;
    }
    const receivedAt = Date.now();
    const row = normalizeRow(body, receivedAt);
    if (!row) {
      json(response, 422, { ok: false, error: 'bad-row' });
      return;
    }
    const file = path.join(DATA_DIR, dayKey(receivedAt) + '.jsonl');
    await appendFile(file, JSON.stringify(row) + '\n', 'utf8');
    json(response, 201, { ok: true, stored: dayKey(receivedAt) });
    return;
  }

  if (url.pathname === '/api/config' && request.method === 'GET') {
    const config = await loadConfig();
    json(response, 200, { ok: true, source: 'server', config: toClientConfig(config) });
    return;
  }

  if (url.pathname === '/api/config' && request.method === 'POST') {
    if (hit(adminBuckets, ip, ADMIN_RATE_LIMIT)) {
      json(response, 429, { ok: false, error: 'rate-limit' });
      return;
    }
    if (!ADMIN_PASSWORD) {
      json(response, 503, { ok: false, error: 'owner-password-not-configured' });
      return;
    }
    if (!matchesPassword(request)) {
      json(response, 403, { ok: false, error: 'owner-password' });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(request));
    } catch (err) {
      json(response, err.message === 'too-large' ? 413 : 400, { ok: false, error: 'bad-body' });
      return;
    }
    if (!body || typeof body !== 'object') {
      json(response, 422, { ok: false, error: 'bad-config' });
      return;
    }
    const saved = await saveConfig(body);
    json(response, 200, { ok: true, config: toClientConfig(saved) });
    return;
  }

  // Проверка пароля владельца: страница узнаёт только «верно / неверно»,
  // сам пароль в браузер не отдаётся.
  if (url.pathname === '/api/admin/check' && request.method === 'GET') {
    if (hit(adminBuckets, ip, ADMIN_RATE_LIMIT)) {
      json(response, 429, { ok: false, error: 'rate-limit' });
      return;
    }
    if (!ADMIN_PASSWORD) {
      json(response, 503, { ok: false, error: 'owner-password-not-configured' });
      return;
    }
    const allowed = matchesPassword(request);
    json(response, allowed ? 200 : 401, { ok: allowed });
    return;
  }

  if (url.pathname === '/api/summary' && request.method === 'GET') {
    const days = Number(url.searchParams.get('days')) || 7;
    const rows = await readRows(days);
    json(response, 200, summarize(rows));
    return;
  }

  // Выгрузка таблицы — только по паролю владельца: в ней device-id и моменты отметок.
  if (url.pathname === '/api/export.csv' && request.method === 'GET') {
    if (hit(adminBuckets, ip, ADMIN_RATE_LIMIT)) {
      json(response, 429, { ok: false, error: 'rate-limit' });
      return;
    }
    if (!ADMIN_PASSWORD) {
      json(response, 503, { ok: false, error: 'owner-password-not-configured' });
      return;
    }
    if (!matchesPassword(request)) {
      json(response, 403, { ok: false, error: 'owner-password' });
      return;
    }
    const days = Number(url.searchParams.get('days')) || MAX_WINDOW_DAYS;
    const rows = await readRows(days);
    const body = toCsv(rows);
    response.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="traffic-light-feedback.csv"',
      'cache-control': 'no-store'
    }).end(body);
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    json(response, 404, { ok: false, error: 'unknown-endpoint' });
    return;
  }

  if (request.method === 'GET') {
    serveStatic(request, response, url);
    return;
  }

  response.writeHead(405).end('method not allowed');
});

server.listen(PORT, () => {
  console.log('Светофор: http://localhost:' + PORT);
  console.log('Часы алгоритма:  GMT+3 (МСК), полночь цикла — по Москве');
  console.log('Таблица отметок: ' + DATA_DIR);
  console.log('Конфиг цикла:    ' + CONFIG_FILE);
  console.log(FEEDBACK_KEY ? 'Ключ приёмника включён' : 'Ключ приёмника не задан — принимает без проверки');
  console.log(ADMIN_PASSWORD
    ? 'Пароль владельца задан (' + (process.env.ADMIN_PASSWORD ? 'ADMIN_PASSWORD' : ADMIN_PASSWORD_FILE) + ')'
    : 'Пароля владельца нет — выгрузка и запись конфига закрыты (503)');
});
