/*
 * Сбор отметок: локальная копия, отправка на сервер, офлайн-очередь,
 * аналитика смещения зелёного, чтение и запись серверного конфига.
 * Вешается на window.TrafficFeedback.
 */
(function (global) {
  'use strict';

  var KEYS = {
    observations: 'trafficlight.observations.v1',
    queue: 'trafficlight.queue.v1',
    device: 'trafficlight.device.v1'
  };
  var MAX_OBSERVATIONS = 5000;
  var MAX_QUEUE = 300;
  var MIN_SAMPLES = 3;

  var memory = {};
  var storageOk = true;
  var observations = [];
  var queue = [];
  var deviceId = '';
  var endpoint = '/api/observations';
  var summaryEndpoint = '/api/summary';
  var configEndpoint = '/api/config';
  var exportEndpoint = '/api/export.csv';
  var serverState = 'unknown';
  var summary = null;
  var feedbackKey = '';

  function read(key, fallback) {
    try {
      var raw = storageOk ? localStorage.getItem(key) : memory[key];
      if (raw == null) return fallback;
      var parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch (err) {
      storageOk = false;
      return fallback;
    }
  }

  function write(key, value) {
    try {
      if (storageOk) localStorage.setItem(key, JSON.stringify(value));
      else memory[key] = value;
    } catch (err) {
      storageOk = false;
      memory[key] = value;
    }
  }

  function init() {
    deviceId = read(KEYS.device, '');
    if (!deviceId) {
      deviceId = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      write(KEYS.device, deviceId);
    }
    var storedObs = read(KEYS.observations, []);
    observations = Array.isArray(storedObs) ? storedObs : [];
    var storedQueue = read(KEYS.queue, []);
    queue = Array.isArray(storedQueue) ? storedQueue : [];
    return { deviceId: deviceId, storageOk: storageOk };
  }

  // Отметка — это строка будущей таблицы. Набор полей одинаковый в локальной
  // копии, в очереди и на сервере, поэтому выгрузка с сервера читается как есть.
  // shiftMs считается сразу при записи: определение «насколько зелёный опережает
  // или отстаёт» живёт в одном месте, а не пересобирается на сервере.
  function build(state, answerId, timestamp, clockOffsetMs, yellowMs) {
    var flashing = state.mode === 'flashing';
    var match = flashing ? null : state.id === answerId;
    var remaining = state.remainingMs == null ? null : Math.max(0, Math.round(state.remainingMs));
    var elapsed = Math.max(0, Math.round(state.elapsedMs || 0));
    var shiftMs = null;
    if (match === false) {
      if (answerId === 'green' && (state.id === 'red' || state.id === 'yellow') && remaining != null) {
        shiftMs = remaining + (state.id === 'red' ? Math.round(yellowMs || 0) : 0);
      } else if (answerId === 'red' && state.id === 'green') {
        shiftMs = -elapsed;
      }
    }
    return {
      ts: Math.round(timestamp),
      device: deviceId,
      display: flashing ? 'flashing' : state.id,
      observed: answerId,
      profile: state.profile,
      phaseElapsedMs: elapsed,
      remainingMs: remaining,
      durationMs: Math.round(state.durationMs || 0),
      cycleAnchor: state.cycleAnchor,
      clockOffsetMs: Math.round(clockOffsetMs || 0),
      match: match,
      shiftMs: shiftMs
    };
  }

  function add(item) {
    observations.push(item);
    if (observations.length > MAX_OBSERVATIONS) {
      observations = observations.slice(observations.length - MAX_OBSERVATIONS);
    }
    write(KEYS.observations, observations);
  }

  function send(item) {
    var headers = { 'content-type': 'application/json' };
    if (feedbackKey) headers['x-feedback-key'] = feedbackKey;
    return global.fetch(endpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(item)
    }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json().catch(function () { return {}; });
    }).then(function () {
      serverState = 'online';
      return true;
    });
  }

  function enqueue(item) {
    queue.push(item);
    if (queue.length > MAX_QUEUE) queue = queue.slice(queue.length - MAX_QUEUE);
    write(KEYS.queue, queue);
  }

  function record(state, answerId, timestamp, clockOffsetMs, yellowMs) {
    var item = build(state, answerId, timestamp, clockOffsetMs, yellowMs);
    add(item);
    return flushOne(item);
  }

  function flushOne(item) {
    if (!global.fetch) { serverState = 'offline'; return Promise.resolve(false); }
    return send(item).catch(function () {
      serverState = 'offline';
      enqueue(item);
      return false;
    });
  }

  function flush() {
    if (!global.fetch || !queue.length) return Promise.resolve(0);
    var pending = queue.slice();
    queue = [];
    write(KEYS.queue, queue);
    var sent = 0;
    return pending.reduce(function (chain, item) {
      return chain.then(function () {
        return send(item).then(function () { sent++; }, function () {
          serverState = 'offline';
          enqueue(item);
        });
      });
    }, Promise.resolve()).then(function () { return sent; });
  }

  function loadSummary() {
    if (!global.fetch) return Promise.resolve(null);
    return global.fetch(summaryEndpoint, { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        summary = data && data.ok ? data : null;
        serverState = 'online';
        return summary;
      })
      .catch(function (err) {
        serverState = 'offline';
        return null;
      });
  }

  // ---------- конфиг и выгрузка ----------

  // Публичное чтение: серверный settings.json — единственный источник расписания.
  // null означает «серверного конфига нет»: статик-хостинг без API либо ошибка сети.
  function loadConfig() {
    if (!global.fetch) return Promise.resolve(null);
    return global.fetch(configEndpoint, { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        serverState = 'online';
        return data && data.ok && data.config ? data.config : null;
      })
      .catch(function () {
        serverState = 'offline';
        return null;
      });
  }

  function saveConfig(config) {
    if (!global.fetch) return Promise.reject(new Error('браузер без fetch'));
    return global.fetch(configEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config)
    }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    }).then(function (data) {
      serverState = 'online';
      return data && data.config ? data.config : null;
    });
  }

  function serverExportCsv(days) {
    if (!global.fetch) return Promise.reject(new Error('браузер без fetch'));
    var url = exportEndpoint + (exportEndpoint.indexOf('?') === -1 ? '?' : '&') + 'days=' + (days || 90);
    return global.fetch(url, { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.text();
      });
  }

  function percentile(values, p) {
    if (!values.length) return null;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var rank = (sorted.length - 1) * p;
    var low = Math.floor(rank);
    var high = Math.ceil(rank);
    if (low === high) return sorted[low];
    return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
  }
  // Смещение = насколько реально включаемый зелёный опережает (+) или отстаёт (-)
  // от расписания. Поле shiftMs заполнено только на несовпавших отметках.
  function shifts(items) {
    var values = [], early = 0, late = 0, confirms = 0;
    for (var i = 0; i < items.length; i++) {
      var o = items[i];
      if (o.match === true) { confirms++; continue; }
      if (typeof o.shiftMs === 'number' && isFinite(o.shiftMs)) {
        values.push(o.shiftMs / 1000);
        if (o.shiftMs > 0) early++; else late++;
      }
    }
    return {
      values: values, early: early, late: late, confirms: confirms,
      median: percentile(values, 0.5), p90: percentile(values, 0.9)
    };
  }

  function clampRed(value) {
    return Math.min(3600, Math.max(5, Math.round(value)));
  }

  // Источник смещения — серверная сводка, если она есть: тогда алгоритм учит
  // опыт всех устройств, а не одного телефона.
  function analyze(currentRed) {
    var local = shifts(observations);
    var values = local.values;
    var early = local.early, late = local.late, confirms = local.confirms;
    var source = 'локальные отметки этого устройства';

    if (summary && typeof summary.medianShift === 'number' && summary.mismatches >= MIN_SAMPLES) {
      values = null;
      early = summary.early;
      late = summary.late;
      confirms = summary.confirms;
      source = 'сводка сервера: ' + summary.rows + ' строк, ' + summary.devices + ' устройств';
    }

    var median = values ? percentile(values, 0.5) : summary.medianShift;
    var p90 = values ? percentile(values, 0.9) : summary.p90Shift;
    var count = values ? values.length : summary.mismatches;
    var result = {
      count: count, early: early, late: late, confirms: confirms,
      median: median, p90: p90, source: source, suggestion: null
    };
    if (count < MIN_SAMPLES || median == null) return result;

    var recommended = clampRed(currentRed - median);
    if (recommended !== currentRed) {
      result.suggestion = { current: currentRed, recommended: recommended, median: median, samples: count };
    }
    return result;
  }

  // Момент в московском времени: смещение фиксированное (+3), перехода на летнее
  // время нет, поэтому достаточно сдвинуть эпоху и взять UTC-представление.
  function mskStamp(ts) {
    return new Date(ts + 180 * 60000).toISOString().slice(0, 19).replace('T', ' ');
  }

  function csv(rows) {
    var header = ['timestamp_iso', 'timestamp_msk', 'device', 'profile', 'displayed', 'observed',
      'phase_elapsed_s', 'remaining_s', 'phase_duration_s', 'clock_offset_s', 'shift_s', 'match'];
    var lines = [header.join(';')];
    var items = rows || observations;
    for (var i = 0; i < items.length; i++) {
      var o = items[i];
      lines.push([
        new Date(o.ts).toISOString(),
        mskStamp(o.ts),
        o.device,
        o.profile || '',
        o.display,
        o.observed,
        (o.phaseElapsedMs / 1000).toFixed(3),
        o.remainingMs == null ? '' : (o.remainingMs / 1000).toFixed(3),
        (o.durationMs / 1000).toFixed(3),
        ((o.clockOffsetMs || 0) / 1000).toFixed(3),
        typeof o.shiftMs === 'number' ? (o.shiftMs / 1000).toFixed(3) : '',
        o.match === null ? 'n/a' : (o.match ? 'yes' : 'no')
      ].join(';'));
    }
    return lines.join('\r\n');
  }

  global.TrafficFeedback = {
    init: init,
    record: record,
    flush: flush,
    loadSummary: loadSummary,
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    serverExportCsv: serverExportCsv,
    analyze: analyze,
    csv: csv,
    clear: function () { observations = []; write(KEYS.observations, observations); },
    all: function () { return observations.slice(); },
    status: function () {
      return {
        server: serverState,
        queued: queue.length,
        storageOk: storageOk,
        deviceId: deviceId
      };
    },
    setEndpoints: function (obs, sum) {
      if (obs) endpoint = obs;
      if (sum) summaryEndpoint = sum;
    },
    setKey: function (value) { feedbackKey = String(value || ''); },
    MIN_SAMPLES: MIN_SAMPLES
  };
})(window);
