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
 * /api/export.csv собирает из них единую таблицу.
 *
 * Настройки цикла лежат в server/config/settings.json и правятся по FTP или
 * страницей: страница читает их через GET /api/config и перечитывает каждые
 * 15 с, поэтому правка доходит до всех телефонов сама. Пароля владельца нет:
 * запись конфига и выгрузка открыты всем, кто знает адрес, — на публичном
 * хостинге это означает, что цикл может поменять любой посетитель.
 *
 * Переменные окружения:
 *   PORT                порт (по умолчанию 8080)
 *   DATA_DIR            папка с таблицей (по умолчанию server/data/observations)
 *   CONFIG_FILE         файл настроек цикла (по умолчанию server/config/settings.json)
 *   FEEDBACK_KEY        если задан, отметки принимаются только с заголовком
 *                       x-feedback-key; страница должна передать его в meta-теге
 *   STATIC_DIR          папка со страницей (по умолчанию public)
 */

import http from 'node:http';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, normalizeConfig, toClientConfig, configToJson, toInt } from './config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || path.join(ROOT, 'public'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'server', 'data', 'observations'));
const CONFIG_FILE = path.resolve(process.env.CONFIG_FILE || path.join(ROOT, 'server', 'config', 'settings.json'));
const PORT = Number(process.env.PORT || 8080);
const FEEDBACK_KEY = process.env.FEEDBACK_KEY || '';
const MAX_BODY = 8192;
const MAX_WINDOW_DAYS = 90;
const CONFIG_TTL_MS = 15000;
const MSK_OFFSET_MS = 180 * 60000;
const RATE_LIMIT = { windowMs: 60000, max: 120 };
// запись цикла и выгрузка — тяжёлые операции: 20 штук в минуту на адрес хватает
// и человеку, и скрипту проверки, а случайный цикл запросов не забьёт диск
const WRITE_RATE_LIMIT = { windowMs: 60000, max: 20 };

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

const buckets = new Map();
const writeBuckets = new Map();

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

// ---------- конфиг цикла (правится по FTP в server/config/settings.json) ----------

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

async function saveConfig(config) {
  const normalized = normalizeConfig(config);
  await writeFile(CONFIG_FILE, configToJson(normalized), 'utf8');
  configCache = { mtimeMs: -1, size: -1, stamp: Date.now(), config: normalized };
  return normalized;
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
    if (target.endsWith('index.html') || target.endsWith('add-to-home.html') || target.endsWith('sw.js')) {
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
      receiverKey: FEEDBACK_KEY ? 'on' : 'off'
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
    if (hit(writeBuckets, ip, WRITE_RATE_LIMIT)) {
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
    if (!body || typeof body !== 'object') {
      json(response, 422, { ok: false, error: 'bad-config' });
      return;
    }
    const saved = await saveConfig(body);
    json(response, 200, { ok: true, config: toClientConfig(saved) });
    return;
  }

  if (url.pathname === '/api/summary' && request.method === 'GET') {
    const days = Number(url.searchParams.get('days')) || 7;
    const rows = await readRows(days);
    json(response, 200, summarize(rows));
    return;
  }

  // Выгрузка таблицы: в ней device-id и моменты отметок, поэтому адрес сервера
  // стоит держать там, где эти данные не должны быть публичными.
  if (url.pathname === '/api/export.csv' && request.method === 'GET') {
    if (hit(writeBuckets, ip, WRITE_RATE_LIMIT)) {
      json(response, 429, { ok: false, error: 'rate-limit' });
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
  console.log('Пароля нет: запись цикла и выгрузка открыты всем, кто знает адрес');
});
