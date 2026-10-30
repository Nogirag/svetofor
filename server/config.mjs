/*
 * Разбор конфига цикла — один на два потребителя: server/api.mjs отдаёт его
 * через /api/config, а tools/build-config.mjs кладёт готовый ответ в
 * public/config.json при публикации. Поэтому статическая копия на GitHub Pages
 * показывает ровно те же значения, что и серверный файл настроек.
 */

export const MODES = new Set(['flashing', 'cycle']);
export const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
// Момент, в который по расписанию включается красный: «ЧЧ:ММ», «ЧЧ:ММ:СС»
// или число секунд от полуночи МСК.
export const PHASE_RE = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

export const DEFAULT_CONFIG = {
  day: { red: 120, yellow: 3, green: 25, phaseStart: '00:00:00' },
  night: { enabled: false, start: '23:00', end: '06:00', mode: 'flashing', cycle: { red: 60, yellow: 3, green: 25, phaseStart: '23:00:00' } }
};

export function toInt(value, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

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

function padTime(value) {
  const parts = String(value).split(':');
  return String(Number(parts[0])).padStart(2, '0') + ':' + String(Number(parts[1])).padStart(2, '0');
}

// Приводим любое содержимое файла к валидному виду: битое значение не должно
// уронить страницу — оно молча заменяется значением по умолчанию.
// Окно ночного времени приходит в двух формах: файл конфига
// { night: { enabled, start, end, mode, cycle } } и форма со страницы
// { nightEnabled, nightStart, nightEnd, nightMode, night: { red, yellow, green } }.
export function normalizeConfig(raw) {
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

// То, чего ждёт public/js/schedule.js
export function toClientConfig(config) {
  return {
    day: config.day,
    night: config.night.cycle,
    nightEnabled: config.night.enabled,
    nightStart: config.night.start,
    nightEnd: config.night.end,
    nightMode: config.night.mode
  };
}

export function configToJson(config) {
  return JSON.stringify(config, null, 2) + '\n';
}
