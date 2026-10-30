/*
 * Расписание сигналов: дневной цикл, ночной цикл и окно ночного времени.
 * Вешается на window.TrafficSchedule. Зависимостей нет, время передаётся извне,
 * чтобы модуль можно было проверить без браузера.
 *
 * Часы алгоритма — московские (GMT+3), независимо от часового пояса телефона.
 * У каждого цикла есть якорь — момент «ЧЧ:ММ:СС по МСК», в который включается
 * красный. Цикл непрерывен: остальные фазы идут на +красный, +(красный+жёлтый),
 * а следующая реплика якоря — через всю длину цикла. Якорь по умолчанию
 * сохраняет прежнее поведение: день начинается с красного после ночного окна
 * (или в полночь, если ночи нет), ночь — в начало ночного окна.
 * Вход и выход всех функций — обычный epoch в UTC.
 */
(function (global) {
  'use strict';

  var FLASH_PERIOD_MS = 1000;
  var PHASE_ORDER = ['red', 'yellow', 'green'];
  var DAY_MS = 86400000;
  var TZ_OFFSET_MS = 180 * 60000; // GMT+3, в России переходов на летнее время нет
  var TZ_LABEL = 'МСК';

  var DAY_DEFAULT = { red: 120, yellow: 3, green: 25 };
  var NIGHT_DEFAULT = { red: 60, yellow: 3, green: 25 };

  function clampDuration(value, fallback) {
    var n = Number(value);
    if (!isFinite(n) || n <= 0) return fallback;
    return Math.min(3600, Math.max(1, Math.round(n)));
  }

  function profile(raw, defaults) {
    var out = {};
    for (var i = 0; i < PHASE_ORDER.length; i++) {
      var id = PHASE_ORDER[i];
      out[id] = clampDuration(raw && raw[id], defaults[id]);
    }
    return out;
  }

  function parseTime(text, fallbackMinutes) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
    if (!m) return fallbackMinutes;
    var hours = Number(m[1]);
    var minutes = Number(m[2]);
    if (hours > 23 || minutes > 59) return fallbackMinutes;
    return hours * 60 + minutes;
  }

  function formatTime(minutes) {
    var h = Math.floor(minutes / 60) % 24;
    var m = minutes % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  // Якорь фазы: «ЧЧ:ММ», «ЧЧ:ММ:СС» или просто число секунд от полуночи МСК.
  function parseClockSeconds(text, fallback) {
    var value = String(text == null ? '' : text).trim();
    if (!value) return fallback;
    if (/^\d+$/.test(value)) {
      var plain = Number(value);
      return plain >= 0 && plain < 86400 ? plain : fallback;
    }
    var m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
    if (!m) return fallback;
    var hours = Number(m[1]);
    var minutes = Number(m[2]);
    var seconds = m[3] ? Number(m[3]) : 0;
    if (hours > 23 || minutes > 59 || seconds > 59) return fallback;
    return hours * 3600 + minutes * 60 + seconds;
  }

  function formatClockSeconds(totalSeconds) {
    var s = Math.max(0, Math.min(86399, Math.round(totalSeconds)));
    var h = Math.floor(s / 3600);
    var m = Math.floor(s % 3600 / 60);
    var sec = s % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  var NIGHT_DEFAULTS = { enabled: false, start: '23:00', end: '06:00', mode: 'flashing' };

  function normalize(raw) {
    raw = raw || {};
    var night = raw.night || {};
    // Ночной цикл приходит в двух формах: в кэше страницы он лежит в nightCycle,
    // в серверном файле — внутри блока night как night.cycle.
    var nightCycle = raw.nightCycle || night.cycle || {};
    var nightEnabled = night.enabled === true;
    var nightStart = parseTime(night.start, parseTime(NIGHT_DEFAULTS.start, 23 * 60));
    var nightEnd = parseTime(night.end, parseTime(NIGHT_DEFAULTS.end, 6 * 60));
    // Якорь не задан — держимся прежнего поведения: день стартует с красного сразу
    // после ночного окна, ночь — в начало окна.
    var dayAnchor = parseClockSeconds(raw.day && raw.day.phaseStart, nightEnabled ? nightEnd * 60 : 0);
    var nightAnchor = parseClockSeconds(nightCycle.phaseStart, nightStart * 60);
    return {
      day: profile(raw.day, DAY_DEFAULT),
      night: profile(nightCycle, NIGHT_DEFAULT),
      nightEnabled: nightEnabled,
      nightStart: nightStart,
      nightEnd: nightEnd,
      nightMode: night.mode === 'cycle' ? 'cycle' : 'flashing',
      dayPhaseStart: dayAnchor,
      nightPhaseStart: nightAnchor
    };
  }

  // Минуты от московской полуночи: часовой пояс телефона в расчёте не участвует.
  function wallMinutes(timestamp) {
    var shifted = (timestamp + TZ_OFFSET_MS) % DAY_MS;
    if (shifted < 0) shifted += DAY_MS;
    return Math.floor(shifted / 60000);
  }

  // Реальный epoch московской полуночи, с которой начался текущий день.
  function wallMidnight(timestamp) {
    var shifted = (timestamp + TZ_OFFSET_MS) % DAY_MS;
    if (shifted < 0) shifted += DAY_MS;
    return timestamp - shifted;
  }

  // Момент (timestamp), когда в текущем профиле включается красный: полуночь МСК
  // текущего дня плюс якорь. Берём именно сегодняшний якорь, чтобы «красный в
  // 08:00:00» означало ровно это; между репликами цикла позицию досчитывает
  // остаток от деления в stateAt.
  function profileStart(timestamp, schedule) {
    var seconds = isNight(timestamp, schedule) ? schedule.nightPhaseStart : schedule.dayPhaseStart;
    return wallMidnight(timestamp) + seconds * 1000;
  }

  function isNight(timestamp, schedule) {
    if (!schedule.nightEnabled) return false;
    var minutes = wallMinutes(timestamp);
    var crosses = schedule.nightEnd <= schedule.nightStart;
    return crosses
      ? minutes >= schedule.nightStart || minutes < schedule.nightEnd
      : minutes >= schedule.nightStart && minutes < schedule.nightEnd;
  }

  function totalMs(durations) {
    return (durations.red + durations.yellow + durations.green) * 1000;
  }

  // Стенные часы по МСК для подписей: «14:32».
  function formatClock(timestamp, withSeconds) {
    var shifted = timestamp + TZ_OFFSET_MS;
    var text = formatTime(Math.floor((((shifted % DAY_MS) + DAY_MS) % DAY_MS) / 60000));
    if (!withSeconds) return text;
    var s = Math.floor(shifted / 1000) % 60;
    return text + ':' + (s < 10 ? '0' : '') + s;
  }

  // Состояние сигнала на произвольный момент синхронизированного времени.
  // Цикл стартует с красного в момент начала профиля, поэтому переключение
  // день/ночь всегда начинается с новой фазы, а не с середины чужого цикла.
  function stateAt(timestamp, schedule) {
    var night = isNight(timestamp, schedule);

    if (night && schedule.nightMode === 'flashing') {
      return {
        profile: 'night', mode: 'flashing', id: 'yellow',
        label: LABELS.yellow.label, genitive: LABELS.yellow.genitive,
        durationMs: FLASH_PERIOD_MS, elapsedMs: timestamp % FLASH_PERIOD_MS,
        remainingMs: null, preview: false, flashOn: Math.floor(timestamp / FLASH_PERIOD_MS) % 2 === 0,
        night: true, cycleAnchor: null
      };
    }

    var durations = night && schedule.nightMode === 'cycle' ? schedule.night : schedule.day;
    var total = totalMs(durations);
    var anchor = profileStart(timestamp, schedule);
    var position = ((timestamp - anchor) % total + total) % total;

    var acc = 0;
    for (var i = 0; i < PHASE_ORDER.length; i++) {
      var id = PHASE_ORDER[i];
      var durationMs = durations[id] * 1000;
      if (position < acc + durationMs) {
        return {
          profile: night ? 'night' : 'day',
          mode: 'cycle',
          id: id,
          label: LABELS[id].label,
          genitive: LABELS[id].genitive,
          durationMs: durationMs,
          elapsedMs: position - acc,
          remainingMs: acc + durationMs - position,
          preview: false,
          flashOn: true,
          night: night,
          cycleAnchor: anchor + Math.floor((timestamp - anchor) / total) * total
        };
      }
      acc += durationMs;
    }

    return {
      profile: night ? 'night' : 'day', mode: 'cycle', id: 'red',
      label: LABELS.red.label, genitive: LABELS.red.genitive,
      durationMs: durations.red * 1000, elapsedMs: 0, remainingMs: durations.red * 1000,
      preview: false, flashOn: true, night: night, cycleAnchor: anchor
    };
  }

  function median(values) {
    if (!values.length) return null;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function modSeconds(value, modulo) {
    var rest = value % modulo;
    return rest < 0 ? rest + modulo : rest;
  }

  // Калибровка по нажатиям: marks — метки {ts, id} в порядке нажатия, id — цвет,
  // который в этот момент включился. Цикл — красный, жёлтый, зелёный, и следующий
  // красный замыкает зелёный: одна группа = четыре метки подряд. Одиночный промах
  // (не тот порядок) не ломает расчёт — группа просто не сходится в этой точке.
  // Длительности берутся медианой, якорь — круговой медианой моментов красного
  // внутри длины цикла, поэтому пропуск одной метки не сдвигает всю фазу.
  function derive(marks) {
    var list = (marks || []).filter(function (mark) {
      return mark && typeof mark.ts === 'number' && PHASE_ORDER.indexOf(mark.id) >= 0;
    });
    var reds = [];
    var yellows = [];
    var greens = [];
    var starts = [];
    var i = 0;

    while (i + 3 < list.length) {
      if (list[i].id === 'red' && list[i + 1].id === 'yellow' &&
          list[i + 2].id === 'green' && list[i + 3].id === 'red') {
        reds.push(list[i + 1].ts - list[i].ts);
        yellows.push(list[i + 2].ts - list[i + 1].ts);
        greens.push(list[i + 3].ts - list[i + 2].ts);
        starts.push(list[i].ts);
        i += 3;
      } else {
        i += 1;
      }
    }

    var cycles = starts.length;
    var empty = {
      marks: list.length, cycles: cycles, ready: false,
      red: null, yellow: null, green: null, totalSec: null,
      phaseStart: null, spreadSec: null
    };
    if (!cycles) return empty;

    var red = Math.max(1, Math.min(3600, Math.round(median(reds) / 1000)));
    var yellow = Math.max(1, Math.min(60, Math.round(median(yellows) / 1000)));
    var green = Math.max(1, Math.min(3600, Math.round(median(greens) / 1000)));
    var totalSec = red + yellow + green;

    var positions = [];
    for (var k = 0; k < starts.length; k++) {
      positions.push(modSeconds((starts[k] - wallMidnight(starts[k])) / 1000, totalSec));
    }
    var reference = positions[0];
    var offsets = [];
    for (var p = 0; p < positions.length; p++) {
      var delta = positions[p] - reference;
      if (delta > totalSec / 2) delta -= totalSec;
      if (delta < -totalSec / 2) delta += totalSec;
      offsets.push(delta);
    }
    var middle = median(offsets);
    var moduloAnchor = modSeconds(reference + middle, totalSec);
    var spread = 0;
    for (var d = 0; d < offsets.length; d++) {
      spread = Math.max(spread, Math.abs(offsets[d] - middle));
    }

    // Якорь определён с точностью до длины цикла: 00:00:37 и 14:32:07 при цикле
    // 90 с — один и тот же сигнал. Человеку у светофора показываем реплику,
    // ближайшую к последнему нажатию, чтобы «красный в 14:32:07» читалось прямо.
    var lastPosition = (starts[starts.length - 1] - wallMidnight(starts[starts.length - 1])) / 1000;
    var anchor = moduloAnchor + Math.round((lastPosition - moduloAnchor) / totalSec) * totalSec;
    while (anchor < 0) anchor += totalSec;
    while (anchor >= 86400) anchor -= totalSec;

    return {
      marks: list.length,
      cycles: cycles,
      ready: cycles >= 2,
      red: red,
      yellow: yellow,
      green: green,
      totalSec: totalSec,
      phaseStart: anchor,
      moduloPhaseStart: moduloAnchor,
      phaseStartText: formatClockSeconds(anchor),
      spreadSec: Math.round(spread)
    };
  }

  var LABELS = {
    red: { label: 'Красный', nominative: 'красный', genitive: 'красного' },
    yellow: { label: 'Жёлтый', nominative: 'жёлтый', genitive: 'жёлтого' },
    green: { label: 'Зелёный', nominative: 'зелёный', genitive: 'зелёного' }
  };

  function nextPhase(id) {
    var index = PHASE_ORDER.indexOf(id);
    return LABELS[PHASE_ORDER[(index + 1) % PHASE_ORDER.length]];
  }

  global.TrafficSchedule = {
    PHASE_ORDER: PHASE_ORDER,
    DAY_DEFAULT: DAY_DEFAULT,
    NIGHT_DEFAULT: NIGHT_DEFAULT,
    TZ_LABEL: TZ_LABEL,
    TZ_OFFSET_MS: TZ_OFFSET_MS,
    LABELS: LABELS,
    normalize: normalize,
    derive: derive,
    formatTime: formatTime,
    formatClock: formatClock,
    formatClockSeconds: formatClockSeconds,
    parseClockSeconds: parseClockSeconds,
    wallMinutes: wallMinutes,
    wallMidnight: wallMidnight,
    parseTime: parseTime,
    isNight: isNight,
    stateAt: stateAt,
    nextPhase: nextPhase,
    totalMs: totalMs,
    profileStart: profileStart
  };
})(window);
