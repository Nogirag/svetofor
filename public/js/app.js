(function () {
  'use strict';

  var S = window.TrafficSchedule;
  var F = window.TrafficFeedback;

  // Последний полученный с сервера цикл. Это кэш, а не настройка устройства:
  // он нужен, чтобы страница, открытая без сети, горела по правильному расписанию.
  var SCHEDULE_CACHE_KEY = 'trafficlight.schedule.cache.v1';
  // Поправка часов этого браузера — тоже не настройка цикла, а служебная величина.
  var CLOCK_KEY = 'trafficlight.clock.v1';
  var TICK_MS = 200;
  var CONFIG_POLL_MS = 30000;
  var ANSWERS_CLOSE_MS = 1100;
  var CALIB_DEBOUNCE_MS = 250;
  // Пять светофоров = пять циклов на каждый профиль: столько меток на цвет и нужно.
  var CALIB_LIGHTS = 5;
  var PANELS = ['answers', 'owner', 'stats', 'settings', 'calib'];

  var schedule = S.normalize(readJson(SCHEDULE_CACHE_KEY) || {});
  var clockOffsetMs = readClock();
  var offsetSource = 'нет синхронизации';
  var lockedUntil = 0;
  var interacted = false;
  var lastPhaseKey = null;
  var lastClockText = '';
  var calibChipText = '';
  var closeTimer = null;
  var statsNote = '';
  var form = null;

  // Сессия настройки по нажатиям: пять светофоров на дневной цикл и пять на ночной.
  // Метки {ts, id} копятся отдельно по профилям, чтобы за одну сессию можно было
  // снять оба и сохранить одним POST. Живут только на этой странице: сервер
  // получает уже посчитанный цикл, а не сырые нажатия.
  var calib = { active: false, target: 'day', marks: { day: [], night: [] } };
  // Что открыть сразу после ввода пароля: «⚙» просит настройки, «⏱» — калибровку.
  var pendingAfterUnlock = null;

  // 'server' — цикл отдаёт server/config/settings.json, 'none' — API нет в помине
  // (чисто статический хостинг), 'unknown' — ещё не проверяли.
  var configSource = 'unknown';
  var serverStamp = '';

  function el(id) { return document.getElementById(id); }

  function readJson(key) {
    try {
      var stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored) : null;
    } catch (err) {
      return null;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      // приватный режим: переживём перезагрузку только в памяти этой страницы
    }
  }

  function readClock() {
    var stored = readJson(CLOCK_KEY);
    return stored && typeof stored.offsetMs === 'number' ? stored.offsetMs : 0;
  }

  // Текущий серверный цикл в форме черновика: он же идёт в кэш страницы, он же —
  // база для точечных правок из 📊 и из настройки по нажатиям.
  function scheduleDraft() {
    return {
      day: {
        red: schedule.day.red, yellow: schedule.day.yellow, green: schedule.day.green,
        phaseStart: S.formatClockSeconds(schedule.dayPhaseStart)
      },
      nightCycle: {
        red: schedule.night.red, yellow: schedule.night.yellow, green: schedule.night.green,
        phaseStart: S.formatClockSeconds(schedule.nightPhaseStart)
      },
      night: {
        enabled: schedule.nightEnabled,
        start: S.formatTime(schedule.nightStart),
        end: S.formatTime(schedule.nightEnd),
        mode: schedule.nightMode
      }
    };
  }

  function saveScheduleCache() {
    writeJson(SCHEDULE_CACHE_KEY, scheduleDraft());
  }

  function saveClock() {
    writeJson(CLOCK_KEY, { offsetMs: clockOffsetMs });
  }

  function now() { return Date.now() + clockOffsetMs; }

  function isOwner() { return F.status().owner === 'unlocked'; }

  // Править цикл можно только через сервер: отдельного устройства больше нет.
  function canEdit() { return isOwner() && configSource === 'server'; }

  // ---------- часы ----------

  // Фаза считается по абсолютному времени, поэтому расхождение часов телефона
  // превращается в «не тот» цвет. Смещение берётся из серверного заголовка Date.
  function syncClock() {
    var started = Date.now();
    return fetch(location.href.split('#')[0], { method: 'HEAD', cache: 'no-store' })
      .then(function (response) {
        var header = response.headers.get('date');
        if (!header) throw new Error('нет заголовка Date');
        var serverMs = Date.parse(header);
        if (isNaN(serverMs)) throw new Error('некорректная дата');
        var latency = Date.now() - started;
        clockOffsetMs = Math.round(serverMs + latency / 2 - Date.now());
        offsetSource = 'правка ' + (clockOffsetMs >= 0 ? '+' : '') + (clockOffsetMs / 1000).toFixed(1) + ' с';
        saveClock();
      })
      .catch(function () {
        offsetSource = 'часы устройства';
      })
      .then(renderFootnote);
  }

  function renderFootnote() {
    var node = el('syncState');
    if (node) node.textContent = 'часы алгоритма: GMT+3 (МСК), ' + offsetSource;
  }

  // ---------- серверный конфиг цикла ----------

  function fromServerConfig(cfg) {
    return {
      day: {
        red: cfg.day.red, yellow: cfg.day.yellow, green: cfg.day.green,
        phaseStart: cfg.day.phaseStart
      },
      nightCycle: {
        red: cfg.night.red, yellow: cfg.night.yellow, green: cfg.night.green,
        phaseStart: cfg.night.phaseStart
      },
      night: {
        enabled: cfg.nightEnabled === true,
        start: cfg.nightStart,
        end: cfg.nightEnd,
        mode: cfg.nightMode === 'cycle' ? 'cycle' : 'flashing'
      }
    };
  }

  // Форма и кэш живут в своей форме, серверный файл — в своей.
  function toServerConfig(src) {
    return {
      day: {
        red: src.day.red, yellow: src.day.yellow, green: src.day.green,
        phaseStart: src.day.phaseStart
      },
      night: {
        enabled: src.night.enabled === true,
        start: src.night.start,
        end: src.night.end,
        mode: src.night.mode,
        cycle: {
          red: src.nightCycle.red, yellow: src.nightCycle.yellow, green: src.nightCycle.green,
          phaseStart: src.nightCycle.phaseStart
        }
      }
    };
  }

  function adoptServerConfig(cfg) {
    schedule = S.normalize(fromServerConfig(cfg));
    saveScheduleCache();
    render();
    if (form && !el('settings').hidden) fillForm();
  }

  // Правка файла по FTP доходит до всех телефонов сама: перечитываем каждые 30 с.
  function pullConfig() {
    return F.loadConfig().then(function (cfg) {
      var was = configSource;
      configSource = cfg ? 'server' : 'none';
      if (!cfg) {
        if (was !== 'none') updateAccessUi();
        return;
      }
      var stamp = JSON.stringify(cfg);
      if (stamp !== serverStamp) {
        serverStamp = stamp;
        adoptServerConfig(cfg);
      }
      updateAccessUi();
    });
  }

  // ---------- сигнал ----------

  function render() {
    var stamp = now();

    // Пока идёт настройка, экран зеркалит то, что человек нажал: он сверяет его с
    // настоящим светофором, а не со старым расписанием.
    if (calib.active && calibMarks().length) {
      renderCalibLight(stamp);
      return;
    }

    var state = S.stateAt(stamp, schedule);
    var key = state.profile + ':' + state.mode + ':' + state.id + ':' + (state.flashOn ? 1 : 0);
    var body = document.body;

    body.classList.remove('is-red', 'is-yellow', 'is-green', 'is-flashing');
    body.classList.add(state.mode === 'flashing' ? 'is-flashing' : 'is-' + state.id);

    var light = el('light');
    if (light) {
      light.setAttribute('aria-label', state.mode === 'flashing'
        ? 'Мигающий жёлтый'
        : state.label + ' сигнал');
    }

    var nameEl = el('phaseName');
    if (nameEl) nameEl.textContent = state.mode === 'flashing' ? 'Мигающий жёлтый' : state.label;

    var timerEl = el('timer');
    if (timerEl) {
      if (state.mode === 'flashing') {
        timerEl.textContent = '—';
        timerEl.classList.remove('warn', 'critical');
      } else {
        var seconds = Math.max(0, Math.ceil(state.remainingMs / 1000 - 1e-6));
        timerEl.textContent = seconds;
        timerEl.classList.toggle('warn', state.remainingMs <= 5000 && state.remainingMs > 2000);
        timerEl.classList.toggle('critical', state.remainingMs <= 2000);
      }
    }

    var hintEl = el('hint');
    if (hintEl) {
      if (state.mode === 'flashing') {
        hintEl.textContent = 'ночной режим';
      } else {
        hintEl.textContent = 'до ' + S.nextPhase(state.id).genitive;
      }
    }

    var profileEl = el('profileInfo');
    if (profileEl) {
      profileEl.textContent = state.night
        ? 'ночь ' + S.formatTime(schedule.nightStart) + '–' + S.formatTime(schedule.nightEnd) + ' МСК'
        : 'день';
    }

    // Стенные часы по МСК: по ним и сверяют, что алгоритм живёт в московском времени.
    writeClock(stamp);

    if (key !== lastPhaseKey) {
      lastPhaseKey = key;
      // вибрация без предварительного касания запрещена политикой браузера,
      // поэтому включаем её только после первой отметки наблюдателя
      if (interacted && navigator.vibrate && state.mode !== 'flashing') {
        try { navigator.vibrate(30); } catch (err) { /* вне Android */ }
      }
    }
  }

  function writeClock(stamp) {
    var clockEl = el('clockState');
    if (!clockEl) return;
    var text = 'МСК ' + S.formatClock(stamp, true);
    if (text !== lastClockText) {
      lastClockText = text;
      clockEl.textContent = text;
    }
  }

  // ---------- настройка цикла по нажатиям ----------

  function calibMarks(target) {
    return calib.marks[target || calib.target];
  }

  function expectedPhase() {
    var marks = calibMarks();
    if (!marks.length) return 'red';
    var last = marks[marks.length - 1].id;
    return S.PHASE_ORDER[(S.PHASE_ORDER.indexOf(last) + 1) % S.PHASE_ORDER.length];
  }

  function targetLabel(target) {
    return (target || calib.target) === 'night' ? 'ночной цикл' : 'дневной цикл';
  }

  function targetProfile() {
    return calib.target === 'night' ? schedule.night : schedule.day;
  }

  // Светофор на экране = один цикл. Новая группа начинается на красном, поэтому
  // промах не смешивает соседние светофоры, а лишняя метка остаётся в своём.
  function groupLights(marks) {
    var lights = [];
    for (var i = 0; i < marks.length; i++) {
      var mark = marks[i];
      if (!lights.length || mark.id === 'red') lights.push({ red: null, yellow: null, green: null });
      var light = lights[lights.length - 1];
      if (!light[mark.id]) light[mark.id] = mark;
    }
    return lights;
  }

  function startCalibration() {
    if (!canEdit()) {
      pendingAfterUnlock = 'calib';
      openOwner('Пароль нужен, чтобы открыть калибровку.');
      return;
    }
    if (!calib.active) {
      // Настраиваем тот цикл, который человек видит прямо сейчас. Мигающий жёлтый
      // нажатиями не считается — вместо него берём дневной; на ночной можно
      // переключиться в панели в любой момент.
      var state = S.stateAt(now(), schedule);
      calib.target = state.night && state.mode === 'cycle' ? 'night' : 'day';
      calib.marks = { day: [], night: [] };
      calib.active = true;
      lastPhaseKey = null;
    }
    syncCalibUi();
    openPanel('calib', renderCalib);
  }

  function stopCalibration() {
    calib.active = false;
    calib.marks = { day: [], night: [] };
    lastPhaseKey = null;
    syncCalibUi();
    render();
  }

  function switchCalibTarget(target) {
    if (!calib.active || (target !== 'day' && target !== 'night') || target === calib.target) return;
    calib.target = target;
    renderCalib();
    render();
  }

  function markPhase(id) {
    if (!calib.active || S.PHASE_ORDER.indexOf(id) < 0) return;
    var marks = calibMarks();
    var stamp = now();
    var last = marks[marks.length - 1];
    // двойное срабатывание от одного касания не должно плодить фазы
    if (last && stamp - last.ts < CALIB_DEBOUNCE_MS) return;
    marks.push({ ts: stamp, id: id });
    interacted = true;
    if (navigator.vibrate) { try { navigator.vibrate(25); } catch (err) { /* вне Android */ } }
    renderCalib();
    render();
  }

  function renderCalibLight(stamp) {
    var last = calibMarks()[calibMarks().length - 1];
    var body = document.body;
    body.classList.remove('is-red', 'is-yellow', 'is-green', 'is-flashing');
    body.classList.add('is-' + last.id);

    var light = el('light');
    if (light) light.setAttribute('aria-label', S.LABELS[last.id].label + ' — настройка цикла');

    var nameEl = el('phaseName');
    if (nameEl) nameEl.textContent = S.LABELS[last.id].label;

    var timerEl = el('timer');
    if (timerEl) {
      timerEl.textContent = Math.max(0, Math.floor((stamp - last.ts) / 1000));
      timerEl.classList.remove('warn', 'critical');
    }

    var hintEl = el('hint');
    if (hintEl) hintEl.textContent = 'с момента нажатия';

    var profileEl = el('profileInfo');
    if (profileEl) profileEl.textContent = 'настройка: ' + (calib.target === 'night' ? 'ночь' : 'день');

    writeClock(stamp);
    writeCalibChip();
  }

  function writeCalibChip() {
    var node = el('calibLive');
    if (!node) return;
    var marks = calibMarks();
    var lightNo = Math.max(1, Math.min(groupLights(marks).length || 1, CALIB_LIGHTS));
    // Шестнадцатая метка — замыкающий красный: пятёрка уже собрана, и «16 из 15» читалось бы как сбой.
    var slots = CALIB_LIGHTS * 3;
    var count = marksText(marks.length) + (marks.length > slots ? '' : ' из ' + slots);
    var text = 'Настройка: ' + targetLabel() + ', светофор ' + lightNo + ' из ' + CALIB_LIGHTS +
      ', ждём ' + S.LABELS[expectedPhase()].nominative + ' · ' + count;
    if (text !== calibChipText) {
      calibChipText = text;
      node.textContent = text;
    }
  }

  // Пока настройка жива, сигнал на экране — большая кнопка: по нему и удобно
  // попадать пальцем, стоя у настоящего светофора.
  function syncCalibUi() {
    var light = el('light');
    if (light) light.classList.toggle('is-tappable', calib.active);
    var chip = el('calibLive');
    if (chip) {
      chip.hidden = !calib.active;
      if (!calib.active) chip.textContent = '';
    }
    var button = el('startCalib');
    if (button) button.textContent = calib.active ? 'Продолжить настройку' : 'Настроить по нажатиям';
    calibChipText = '';
  }

  function calibReady(target) {
    return S.derive(calibMarks(target)).ready;
  }

  // «1 полный цикл / 2 полных цикла / 5 полных циклов»
  function cyclesText(count) {
    var tail = count % 100;
    if (tail >= 11 && tail <= 14) return count + ' полных циклов';
    var last = count % 10;
    if (last === 1) return count + ' полный цикл';
    if (last >= 2 && last <= 4) return count + ' полных цикла';
    return count + ' полных циклов';
  }

  // «1 метка / 2 метки / 5 меток»
  function marksText(count) {
    var tail = count % 100;
    if (tail >= 11 && tail <= 14) return count + ' меток';
    var last = count % 10;
    if (last === 1) return count + ' метка';
    if (last >= 2 && last <= 4) return count + ' метки';
    return count + ' меток';
  }

  function renderCalibTargets() {
    var box = el('calibTargets');
    if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll('[data-target]'), function (button) {
      var target = button.dataset.target;
      var active = target === calib.target;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      var counter = button.querySelector('small');
      if (counter) counter.textContent = marksText(calibMarks(target).length);
    });
  }

  function renderCalibScope() {
    var scope = el('calibScope');
    if (!scope) return;
    var prof = targetProfile();
    scope.className = 'scope';
    scope.textContent = 'Настраиваем ' + targetLabel() + ' на пяти светофорах. Сейчас на сервере: ' +
      prof.red + ' / ' + prof.yellow + ' / ' + prof.green + ' с, красный включается в ' +
      S.formatClockSeconds(calib.target === 'night' ? schedule.nightPhaseStart : schedule.dayPhaseStart) +
      ' МСК. Сохранение заменит эти значения посчитанными по нажатиям.';
  }

  function renderCalibNext(marks) {
    var nextEl = el('calibNext');
    if (!nextEl) return;
    var lights = groupLights(marks);
    if (!marks.length) {
      nextEl.textContent = 'Первое нажатие — включился красный';
      return;
    }
    var last = lights[lights.length - 1];
    var lastFull = !!(last && last.red && last.yellow && last.green);
    var text;
    if (lights.length > CALIB_LIGHTS) {
      text = 'Пять светофоров собраны. Дальше ждём ' + S.LABELS[expectedPhase()].nominative +
        ' — лишние циклы только уточняют медиану.';
    } else if (lights.length === CALIB_LIGHTS && lastFull) {
      text = 'Все пять светофоров заполнены. Ещё один красный закроет пятый цикл: ' +
        'нажмите на большой экран или на красную лампу пятого светофора.';
    } else {
      text = 'Дальше ждём ' + S.LABELS[expectedPhase()].nominative + ' · светофор ' +
        (lastFull ? lights.length + 1 : lights.length) + ' из ' + CALIB_LIGHTS +
        ' · ' + marksText(marks.length) + ' из ' + (CALIB_LIGHTS * 3);
    }
    nextEl.textContent = text;
  }

  // Пять светофоров: лампа — кнопка, в ней же время нажатия по МСК. Подсвечена та
  // лампа, которую страница ждёт следующей; когда пятёрка заполнена, подсвечен
  // красный пятого — он замыкает его зелёный.
  function renderCalibLights(marks) {
    var box = el('calibLights');
    if (!box) return;
    var lights = groupLights(marks);
    var target = -1;
    if (!lights.length) {
      target = 0;
    } else if (lights.length <= CALIB_LIGHTS) {
      var last = lights[lights.length - 1];
      target = last.red && last.yellow && last.green
        ? Math.min(lights.length, CALIB_LIGHTS - 1)
        : lights.length - 1;
    }
    var expect = expectedPhase();
    var html = '';
    for (var i = 0; i < CALIB_LIGHTS; i++) {
      var light = lights[i] || null;
      var full = !!(light && light.red && light.yellow && light.green);
      html += '<div class="calib-light' + (full ? ' is-full' : '') + '">' +
        '<span class="calib-light-no">' + (i + 1) + '</span>';
      for (var k = 0; k < S.PHASE_ORDER.length; k++) {
        var id = S.PHASE_ORDER[k];
        var mark = light ? light[id] : null;
        var cls = 'mini-lamp mini-' + id + (mark ? ' is-filled' : '') +
          (i === target && id === expect ? ' is-next' : '');
        html += '<button type="button" class="' + cls + '" data-calib="' + id + '" data-light="' + i + '"' +
          ' aria-label="' + S.LABELS[id].label + ', светофор ' + (i + 1) + '">' +
          '<span class="dot"></span><span class="time">' +
          (mark ? S.formatClock(mark.ts, true) : '—') + '</span></button>';
      }
      html += '</div>';
    }
    box.innerHTML = html;
  }

  // Длительности фаз по каждому светофору: красный и жёлтый считаются до
  // следующей лампы, зелёный — до красного следующего светофора.
  function renderCalibCycles(marks) {
    var box = el('calibLog');
    if (!box) return;
    var lights = groupLights(marks);
    var html = '';
    for (var i = 0; i < lights.length; i++) {
      var light = lights[i];
      var nextRed = lights[i + 1] ? lights[i + 1].red : null;
      var red = light.red && light.yellow ? (light.yellow.ts - light.red.ts) / 1000 : null;
      var yellow = light.yellow && light.green ? (light.green.ts - light.yellow.ts) / 1000 : null;
      var green = light.green && nextRed ? (nextRed.ts - light.green.ts) / 1000 : null;
      if (red == null && yellow == null && green == null) continue;
      html += '<div class="cycle-row"><span>цикл ' + (i + 1) + '</span><b>' +
        [red, yellow, green].map(function (value) {
          return value == null ? '—' : value.toFixed(1);
        }).join(' / ') + ' с</b></div>';
    }
    box.innerHTML = html
      ? '<div class="cycle-row cycle-head"><span>по циклам</span><b>красный / жёлтый / зелёный</b></div>' + html
      : '';
  }

  function renderCalibPreview(marks, derived) {
    var preview = el('calibPreview');
    if (!preview) return;
    preview.className = 'calib-preview' + (derived.cycles ? '' : ' empty');
    var html = derived.cycles
      ? '<strong>Получается:</strong> ' + derived.red + ' / ' + derived.yellow + ' / ' +
        derived.green + ' с (цикл ' + derived.totalSec + ' с), красный включается в <strong>' +
        derived.phaseStartText + '</strong> МСК.<br><small class="muted">' +
        cyclesText(derived.cycles) + ', ход между включениями красного ±' + derived.spreadSec +
        ' с. ' + (derived.ready
          ? 'Данных достаточно — жмите «Закончить и сохранить».'
          : 'Нужен хотя бы второй цикл: нажимайте дальше.') + '</small>'
      : 'Считаем по последовательности красный → жёлтый → зелёный → красный. ' +
        'Пока нет ни одного полного цикла.';

    var other = calib.target === 'night' ? 'day' : 'night';
    var otherMarks = calibMarks(other);
    if (otherMarks.length) {
      var otherDerived = S.derive(otherMarks);
      html += '<br><small class="muted">' + (other === 'night' ? 'Ночной' : 'Дневной') + ' цикл: ' +
        marksText(otherMarks.length) +
        (otherDerived.cycles ? ', ' + cyclesText(otherDerived.cycles) : '') +
        (otherDerived.ready ? ' — сохранится вместе с этим.' : ' — пока мало для сохранения.') +
        '</small>';
    }
    preview.innerHTML = html;
  }

  function renderCalib() {
    var marks = calibMarks();
    var derived = S.derive(marks);
    renderCalibTargets();
    renderCalibScope();
    renderCalibNext(marks);
    renderCalibLights(marks);
    renderCalibCycles(marks);
    renderCalibPreview(marks, derived);

    setEnabled('finishCalib', calibReady('day') || calibReady('night'));
    setEnabled('undoCalib', marks.length > 0);
    setEnabled('restartCalib', marks.length > 0);
    writeCalibChip();
  }

  function setEnabled(id, on) {
    var node = el(id);
    if (node) node.disabled = !on;
  }

  function finishCalibration() {
    if (!calib.active) return;
    if (!canEdit()) { openOwner('Доступ снова закрыт: введите пароль владельца.'); return; }

    var draft = scheduleDraft();
    var saved = [];
    ['day', 'night'].forEach(function (target) {
      var marks = calibMarks(target);
      var derived = S.derive(marks);
      if (!derived.ready) return;
      var profile = {
        red: derived.red, yellow: derived.yellow, green: derived.green,
        phaseStart: derived.phaseStartText
      };
      if (target === 'night') draft.nightCycle = profile;
      else draft.day = profile;
      saved.push({ target: target, derived: derived, count: marks.length });
    });
    if (!saved.length) return;

    saveToServer(draft, function () {
      stopCalibration();
      closePanels();
      statsNote = saved.map(function (item) {
        return (item.target === 'night' ? 'Ночной' : 'Дневной') + ' цикл по нажатиям (' +
          item.count + ' меток): ' + item.derived.red + ' / ' + item.derived.yellow + ' / ' +
          item.derived.green + ' с, красный включается в ' + item.derived.phaseStartText +
          ' МСК, ход ±' + item.derived.spreadSec + ' с';
      }).join('. ') + '. Сверки наблюдателей и дальше будут предлагать правки.';
    }, function (text) {
      closePanels();
      openOwner(text);
    });
  }

  // ---------- отметки ----------

  function handleAnswer(answerId) {
    var stamp = now();
    if (stamp < lockedUntil) return;
    lockedUntil = stamp + 400;
    interacted = true;

    var state = S.stateAt(stamp, schedule);
    var yellowMs = (state.profile === 'night' ? schedule.night : schedule.day).yellow * 1000;
    F.record(state, answerId, stamp, clockOffsetMs, yellowMs);

    var feedback = el('feedback');
    if (feedback) {
      if (state.mode === 'flashing') {
        feedback.className = 'feedback';
        feedback.textContent = 'ночью отметки не влияют на цикл — записано: ' + S.LABELS[answerId].nominative;
      } else if (state.id === answerId) {
        feedback.className = 'feedback match';
        feedback.textContent = 'совпало: ' + S.LABELS[answerId].nominative;
      } else {
        feedback.className = 'feedback mismatch';
        feedback.textContent = 'записано: вы видите ' + S.LABELS[answerId].nominative +
          ', на экране ' + S.LABELS[state.id].nominative;
      }
    }
    if (navigator.vibrate) { try { navigator.vibrate(15); } catch (err) { /* вне Android */ } }

    // меню закрывается само: отметка — одиночное действие, а не режим работы
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(closePanels, ANSWERS_CLOSE_MS);
  }

  // ---------- нижние меню ----------

  function openPanel(id, beforeOpen) {
    if (beforeOpen) beforeOpen();
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    for (var i = 0; i < PANELS.length; i++) {
      var node = el(PANELS[i]);
      if (node) node.hidden = PANELS[i] !== id;
    }
    var scrim = el('scrim');
    if (scrim) scrim.hidden = false;
  }

  function closePanels() {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    // Панель пароля закрыли, не введя его, — прежняя просьба «открыть калибровку» не должна ждать.
    pendingAfterUnlock = null;
    for (var i = 0; i < PANELS.length; i++) {
      var node = el(PANELS[i]);
      if (node) node.hidden = true;
    }
    var scrim = el('scrim');
    if (scrim) scrim.hidden = true;
  }

  function focusFirst(id, selector) {
    var node = el(id);
    if (!node) return;
    var target = node.querySelector(selector);
    if (!target) return;
    setTimeout(function () {
      try { target.focus({ preventScroll: true }); } catch (err) { /* старый Safari */ }
    }, 60);
  }

  function openAnswers() {
    var feedback = el('feedback');
    if (feedback) { feedback.className = 'feedback'; feedback.textContent = ''; }
    openPanel('answers');
    focusFirst('answers', '.answer');
  }

  // ---------- доступ владельца ----------

  function setOwnerState(text, kind) {
    var node = el('ownerState');
    if (node) {
      node.className = 'feedback' + (kind ? ' ' + kind : '');
      node.textContent = text || '';
    }
  }

  function openOwner(hint) {
    setOwnerState(hint || '', hint ? 'mismatch' : '');
    openPanel('owner');
    focusFirst('owner', '#ownerPasswordInput');
  }

  // Пароль спрашиваем один раз: он остаётся в этом браузере, и следующая правка
  // интервалов — это «⚙ → Сохранить», а не ввод ключа заново.
  function unlockOwner() {
    var input = el('ownerPasswordInput');
    var candidate = (input && input.value ? input.value : '').trim();
    if (!candidate) {
      setOwnerState('Введите пароль.', 'mismatch');
      return;
    }
    var button = el('unlockOwner');
    if (button) button.disabled = true;
    setOwnerState('Проверяю…', '');
    F.checkOwnerPassword(candidate).then(function (state) {
      if (button) button.disabled = false;
      if (state === 'ok') {
        F.setOwnerPassword(candidate);
        if (input) input.value = '';
        var next = pendingAfterUnlock;
        pendingAfterUnlock = null;
        updateAccessUi();
        if (next === 'calib') startCalibration();
        else openSettingsPanel();
        return;
      }
      if (state === 'charset') {
        setOwnerState('В пароле могут быть только латинские буквы, цифры и знаки ' +
          'препинания без пробелов — проверьте раскладку клавиатуры.', 'mismatch');
        return;
      }
      if (state === 'missing') {
        setOwnerState('На сервере не задан пароль владельца: браузером менять нельзя. ' +
          'Задайте его в server/config/admin.password — или правьте settings.json по FTP.', 'mismatch');
        return;
      }
      if (state === 'slow') {
        setOwnerState('Слишком много попыток — подождите минуту.', 'mismatch');
        return;
      }
      if (state === 'offline') {
        setOwnerState('Сервер не отвечает: проверить пароль сейчас нельзя. Если он только ' +
          'что остановлен — запустите node server/api.mjs и дождитесь, пока страница его дождётся.', 'mismatch');
        return;
      }
      if (state === 'noapi') {
        setOwnerState('На этом адресе нет серверного API — страница открыта без Node-сервера ' +
          '(статик-хостинг, file:// или другой порт). Пароль проверять негде: расписание ' +
          'правится файлом server/config/settings.json.', 'mismatch');
        return;
      }
      setOwnerState('Пароль не подошёл.', 'mismatch');
    });
  }

  function lockOwner() {
    F.setOwnerPassword('');
    updateAccessUi();
    closePanels();
    statsNote = 'Доступ владельца закрыт в этом браузере.';
    renderStats();
  }

  function openSettings() {
    if (configSource === 'unknown') {
      pullConfig().then(openSettings);
      return;
    }
    if (!canEdit()) {
      pendingAfterUnlock = 'settings';
      openOwner(configSource === 'server' ? '' : 'Сервер с API не найден: без него расписание не правится.');
      return;
    }
    openSettingsPanel();
  }

  function openSettingsPanel() {
    openPanel('settings', fillForm);
  }

  // Пока доступа нет, форму показываем для ознакомления — поля только на чтение.
  function updateAccessUi() {
    var owner = isOwner();
    var editable = canEdit();
    // Доступ могли отозвать на сервере — незавершённая настройка без него бессмысленна.
    if (!editable && calib.active) stopCalibration();
    toggleNode('exportServer', owner && configSource === 'server');
    toggleNode('lockOwner', owner && configSource === 'server');
    toggleNode('startCalib', editable);
    syncCalibUi();

    var apply = el('applySettings');
    var reset = el('resetSettings');
    var scope = el('configScope');

    if (scope) {
      scope.className = 'scope' + (editable ? '' : ' warn');
      if (configSource === 'unknown') {
        scope.textContent = 'Проверяю, где живёт расписание…';
      } else if (configSource === 'none') {
        scope.textContent = 'Сервер с API не найден: страница горит по расписанию из кода. ' +
          'Длительности правятся в server/config/settings.json на сервере, отдельной настройки ' +
          'для этого устройства больше нет.';
      } else if (owner) {
        scope.textContent = 'Пароль владельца введён: сохранение уходит в server/config/settings.json ' +
          'и меняет цикл сразу на всех устройствах.';
      } else {
        scope.textContent = 'Доступ закрыт паролем: расписание берётся с сервера из ' +
          'server/config/settings.json. Его правят по FTP или здесь — с паролем владельца.';
      }
    }

    if (apply) apply.hidden = !editable;
    if (reset) reset.hidden = !editable;
    setFormReadonly(!editable);
    if (editable && !el('settings').hidden) fillForm();
  }

  function setFormReadonly(readonly) {
    if (!form) return;
    var nodes = form.querySelectorAll('input, select');
    for (var i = 0; i < nodes.length; i++) nodes[i].disabled = readonly;
  }

  function toggleNode(id, visible) {
    var node = el(id);
    if (node) node.hidden = !visible;
  }

  // ---------- панель статистики ----------

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }

  function signed(value, digits) {
    return (value > 0 ? '+' : '') + value.toFixed(digits == null ? 1 : digits);
  }

  // Остаток по суточному кругу: сдвиг якоря не должен вылезать за полночь.
  function modSeconds(value, modulo) {
    var rest = value % modulo;
    return rest < 0 ? rest + modulo : rest;
  }

  function renderStats() {
    var body = el('statsBody');
    if (!body) return;

    var status = F.status();
    var analysis = F.analyze(schedule.day.red);
    var rows = F.all();
    var html = '';

    if (statsNote) {
      html += '<p class="scope warn">' + escapeHtml(statsNote) + '</p>';
      statsNote = '';
    }

    html += '<h3>Куда попадают отметки</h3>';
    html += '<p>Сервер: <strong>' + serverLabel(status.server) + '</strong>. В очереди на отправку: <strong>' +
      status.queued + '</strong>. Всего на этом устройстве: <strong>' + rows.length + '</strong>. ' +
      'Идентификатор устройства: <code>' + escapeHtml(status.deviceId) + '</code>. ' +
      (status.storageOk ? 'Локальная копия сохраняется между запусками.'
        : 'Локальное хранилище недоступно — копия живёт до перезагрузки.') + '</p>';

    html += '<h3>Доступ и источник расписания</h3>';
    html += '<p>Расписание: <strong>' + scheduleLabel() + '</strong>. Правка длительностей: <strong>' +
      (canEdit() ? 'открыта паролем владельца' : 'закрыта паролем владельца') +
      '</strong>. Выгрузка таблицы сервера: <strong>' +
      (configSource !== 'server' ? 'нет сервера' : ownerLabel()) + '</strong>.</p>';
    html += '<p>Настройки одного устройства отключены: цикл у всех один, время алгоритма — московское (GMT+3).</p>';
    html += '<p>Источник расчёта: ' + escapeHtml(analysis.source) + '.</p>';

    if (!rows.length) {
      html += '<p>Отметок пока нет. Нажмите «Отметить, какой цвет вы видите» и выберите цвет, ' +
        'который виден на настоящем светофоре.</p>';
      body.innerHTML = html;
      return;
    }

    html += '<h3>Смещение зелёного</h3><table><tr><th>Показатель</th><th>Значение</th></tr>' +
      '<tr><td>Зелёный раньше экрана</td><td>' + analysis.early + '</td></tr>' +
      '<tr><td>Красный позже экрана</td><td>' + analysis.late + '</td></tr>' +
      '<tr><td>Отметки совпали</td><td>' + analysis.confirms + '</td></tr>' +
      '<tr><td>Медиана смещения</td><td>' + (analysis.median == null ? '—' : signed(analysis.median) + ' с') + '</td></tr>' +
      '<tr><td>P90 смещения</td><td>' + (analysis.p90 == null ? '—' : signed(analysis.p90) + ' с') + '</td></tr>' +
      '</table>';
    html += '<p>Положительное смещение — в жизни зелёный включается раньше расписания, красный стоит укоротить. ' +
      'Отрицательное — позже, красный стоит удлинить.</p>';

    html += '<h3>Предложение</h3>';
    if (!analysis.suggestion) {
      html += '<p>Нужно минимум ' + F.MIN_SAMPLES + ' несовпавших отметок со смещением. Сейчас: ' +
        analysis.count + '. Длительности остаются ручными: красный ' + schedule.day.red +
        ' с, жёлтый ' + schedule.day.yellow + ' с, зелёный ' + schedule.day.green + ' с.</p>';
    } else {
      var s = analysis.suggestion;
      html += '<div class="suggestion"><span>Красный (день): ' + s.current + ' с → <strong>' + s.recommended +
        ' с</strong><br><small class="muted">' + s.samples + ' отметок, медиана ' + signed(s.median) +
        ' с</small></span>';
      html += canEdit()
        ? '<button type="button" class="apply" data-apply="red" data-value="' + s.recommended + '">Применить</button>'
        : '<span class="muted small">нужен пароль владельца</span>';
      html += '</div>';

      // То же медианное смещение можно объяснить не длиной красного, а фазой:
      // весь цикл идёт мимо расписания. Предложения альтернативные — что править,
      // выбирает владелец.
      var shiftSec = Math.round(s.median);
      if (Math.abs(shiftSec) >= 1) {
        var anchor = modSeconds(schedule.dayPhaseStart - shiftSec, 86400);
        html += '<div class="suggestion"><span>Старт красного (день): ' +
          S.formatClockSeconds(schedule.dayPhaseStart) + ' → <strong>' + S.formatClockSeconds(anchor) +
          '</strong> МСК<br><small class="muted">сдвиг ' + signed(-shiftSec, 0) +
          ' с: если длительности верны, а мимо стоит лишь момент включения красного</small></span>';
        html += canEdit()
          ? '<button type="button" class="apply" data-apply="anchor" data-value="' + anchor + '">Сдвинуть</button>'
          : '<span class="muted small">нужен пароль владельца</span>';
        html += '</div>';
      }

      html += '<p class="muted small">Оба предложения меняют только дневной цикл. Ночной и остальное правятся в ⚙.</p>';
    }

    html += '<h3>Последние отметки</h3><table><tr><th>Время (МСК)</th><th>Профиль</th><th>Экран</th><th>Ответ</th><th>Смещение</th><th>Правка часов</th></tr>';
    var recent = rows.slice(-12).reverse();
    for (var i = 0; i < recent.length; i++) {
      var o = recent[i];
      html += '<tr><td>' + S.formatClock(o.ts, true) + '</td><td>' + (o.profile === 'night' ? 'ночь' : 'день') +
        '</td><td>' + escapeHtml(labelOf(o.display)) + '</td><td>' + escapeHtml(labelOf(o.observed)) +
        '</td><td>' + (typeof o.shiftMs === 'number' ? signed(o.shiftMs / 1000) + ' с' : '—') +
        '</td><td>' + ((o.clockOffsetMs || 0) / 1000).toFixed(1) + ' с</td></tr>';
    }
    html += '</table>';

    body.innerHTML = html;
  }

  function ownerLabel() {
    return isOwner() ? 'открыта' : 'закрыта паролем';
  }

  function scheduleLabel() {
    if (configSource === 'server') return 'server/config/settings.json';
    return configSource === 'none' ? 'код страницы — серверного конфига нет' : 'не проверено';
  }

  function serverLabel(state) {
    return state === 'online' ? 'принимает' : state === 'offline' ? 'недоступен, данные в очереди' : 'не проверен';
  }

  function labelOf(id) {
    return S.LABELS[id] ? S.LABELS[id].nominative : 'жёлтый мигает';
  }

  function mskDate() {
    return new Date(now() + S.TZ_OFFSET_MS).toISOString().slice(0, 10);
  }

  function download(filename, text, type) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---------- форма длительностей ----------

  function fillForm() {
    if (!form) return;
    form.elements.dayRed.value = schedule.day.red;
    form.elements.dayYellow.value = schedule.day.yellow;
    form.elements.dayGreen.value = schedule.day.green;
    form.elements.dayPhaseStart.value = S.formatClockSeconds(schedule.dayPhaseStart);
    form.elements.nightEnabled.checked = schedule.nightEnabled;
    form.elements.nightStart.value = S.formatTime(schedule.nightStart);
    form.elements.nightEnd.value = S.formatTime(schedule.nightEnd);
    form.elements.nightMode.value = schedule.nightMode === 'cycle' ? 'cycle' : 'flashing';
    form.elements.nightRed.value = schedule.night.red;
    form.elements.nightYellow.value = schedule.night.yellow;
    form.elements.nightGreen.value = schedule.night.green;
    form.elements.nightPhaseStart.value = S.formatClockSeconds(schedule.nightPhaseStart);
    toggleNightCycle();
  }

  // Якорь ночного цикла имеет смысл только когда ночью идёт отдельный цикл.
  function toggleNightCycle() {
    if (!form) return;
    var cyclical = form.elements.nightEnabled.checked && form.elements.nightMode.value === 'cycle';
    toggleNode('nightCycleFields', cyclical);
    toggleNode('nightPhaseField', cyclical);
  }

  function draftFromForm() {
    var value = function (name, fallback, max) {
      var n = Number(form.elements[name].value);
      if (!isFinite(n) || n <= 0) return fallback;
      return Math.min(max || 3600, Math.round(n));
    };
    // Пустое или кривое поле якоря оставляем как было: серверный разбор всё равно
    // восстановил бы прежний цикл.
    var anchor = function (name, current) {
      return S.formatClockSeconds(S.parseClockSeconds(form.elements[name].value, current));
    };
    return {
      day: {
        red: value('dayRed', S.DAY_DEFAULT.red),
        yellow: value('dayYellow', S.DAY_DEFAULT.yellow, 60),
        green: value('dayGreen', S.DAY_DEFAULT.green),
        phaseStart: anchor('dayPhaseStart', schedule.dayPhaseStart)
      },
      nightCycle: {
        red: value('nightRed', S.NIGHT_DEFAULT.red),
        yellow: value('nightYellow', S.NIGHT_DEFAULT.yellow, 60),
        green: value('nightGreen', S.NIGHT_DEFAULT.green),
        phaseStart: anchor('nightPhaseStart', schedule.nightPhaseStart)
      },
      night: {
        enabled: form.elements.nightEnabled.checked,
        start: form.elements.nightStart.value || '23:00',
        end: form.elements.nightEnd.value || '06:00',
        mode: form.elements.nightMode.value === 'cycle' ? 'cycle' : 'flashing'
      }
    };
  }

  function defaultsDraft() {
    return {
      day: {
        red: S.DAY_DEFAULT.red, yellow: S.DAY_DEFAULT.yellow, green: S.DAY_DEFAULT.green,
        phaseStart: '00:00:00'
      },
      nightCycle: {
        red: S.NIGHT_DEFAULT.red, yellow: S.NIGHT_DEFAULT.yellow, green: S.NIGHT_DEFAULT.green,
        phaseStart: '23:00:00'
      },
      night: { enabled: false, start: '23:00', end: '06:00', mode: 'flashing' }
    };
  }

  // Любая правка уходит на сервер и меняет цикл у всех. Одиночная кнопка, без
  // «сохранить только здесь» — иначе телефоны разъезжаются по расписанию.
  function saveToServer(draft, onSuccess, onDeny) {
    var button = el('applySettings');
    var label = button ? button.textContent : '';
    if (button) { button.disabled = true; button.textContent = 'Сохраняю…'; }
    F.saveConfig(toServerConfig(draft)).then(function (cfg) {
      if (button) { button.disabled = false; button.textContent = label; }
      if (cfg) {
        serverStamp = JSON.stringify(cfg);
        adoptServerConfig(cfg);
      } else {
        pullConfig();
      }
      onSuccess();
    }).catch(function (err) {
      if (button) { button.disabled = false; button.textContent = label; }
      if (err.code === 'owner-password') {
        updateAccessUi();
        onDeny('Пароль больше не принимается сервером. Доступ к настройкам закрыт.');
        return;
      }
      if (err.code === 'missing') {
        updateAccessUi();
        onDeny('Сервер перестал принимать правки: пароля владельца на нём больше нет.');
        return;
      }
      onDeny('Сервер не сохранил (' + err.message + '). Цикл остался прежним.');
    });
  }

  function applySettings() {
    if (!canEdit()) { openOwner('Сначала пароль владельца.'); return; }
    var draft = draftFromForm();
    saveToServer(draft, function () {
      closePanels();
      statsNote = 'Цикл сохранён на сервере — у всех устройств он обновится в течение полминуты.';
    }, function (text) {
      closePanels();
      openOwner(text);
    });
  }

  function resetSettings() {
    saveToServer(defaultsDraft(), function () {
      closePanels();
      statsNote = 'Серверу вернули 120 / 3 / 25, ночной режим выключен.';
    }, function (text) {
      closePanels();
      openOwner(text);
    });
  }

  // ---------- связка ----------

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    var base = location.pathname.slice(0, location.pathname.lastIndexOf('/') + 1) || '/';
    navigator.serviceWorker.register('sw.js', { scope: base }).catch(function () {
      // хостинг без service worker — страница работает как обычно
    });
  }

  // Точечная правка из 📊: берём действующий серверный цикл и меняем в нём одно
  // поле — чтобы согласие на «сдвинуть красный» не трогало ночной цикл и окна.
  function applySuggestion(kind, value) {
    var draft = scheduleDraft();
    var note;
    if (kind === 'anchor') {
      draft.day.phaseStart = S.formatClockSeconds(value);
      note = 'Старт красного (день) перенесён на ' + draft.day.phaseStart + ' МСК и сохранён на сервере.';
    } else {
      draft.day.red = value;
      note = 'Красный (день) ' + value + ' с сохранён на сервере.';
    }
    saveToServer(draft, function () {
      statsNote = note;
      renderStats();
    }, function (text) {
      statsNote = text;
      renderStats();
    });
  }

  function bind() {
    // Отметки наблюдателя — только кнопки нижнего меню; кнопки настройки цикла
    // выглядят так же, но не должны попадать в статистику.
    Array.prototype.forEach.call(document.querySelectorAll('#answers .answer'), function (button) {
      button.addEventListener('click', function () { handleAnswer(button.dataset.answer); });
    });

    // Пять светофоров перерисовываются целиком, поэтому слушаем контейнер:
    // нажатие на лампу пишет своё время, на переключатель — меняет профиль.
    var grid = el('calibLights');
    if (grid) {
      grid.addEventListener('click', function (event) {
        var lamp = event.target;
        while (lamp && lamp !== grid && !lamp.dataset.calib) lamp = lamp.parentNode;
        if (lamp && lamp.dataset && lamp.dataset.calib) markPhase(lamp.dataset.calib);
      });
    }

    var targets = el('calibTargets');
    if (targets) {
      targets.addEventListener('click', function (event) {
        var button = event.target;
        while (button && button !== targets && !button.dataset.target) button = button.parentNode;
        if (button && button.dataset && button.dataset.target) switchCalibTarget(button.dataset.target);
      });
    }

    var light = el('light');
    if (light) {
      light.addEventListener('click', function () {
        if (calib.active) markPhase(expectedPhase());
      });
    }

    form = el('settingsForm');

    bindClick('openAnswers', openAnswers);
    bindClick('closeAnswers', closePanels);
    bindClick('openStats', function () { openPanel('stats', renderStats); });
    bindClick('closeStats', closePanels);
    bindClick('openSettings', openSettings);
    bindClick('openCalib', startCalibration);
    bindClick('closeSettings', closePanels);
    bindClick('closeOwner', closePanels);
    bindClick('unlockOwner', unlockOwner);
    bindClick('lockOwner', lockOwner);
    bindClick('applySettings', applySettings);
    bindClick('resetSettings', resetSettings);
    bindClick('startCalib', startCalibration);
    bindClick('finishCalib', finishCalibration);
    bindClick('closeCalib', closePanels);
    bindClick('cancelCalib', function () {
      stopCalibration();
      closePanels();
    });
    bindClick('undoCalib', function () {
      calibMarks().pop();
      renderCalib();
      render();
    });
    bindClick('restartCalib', function () {
      if (calibMarks().length && !confirm('Забыть все метки и начать заново?')) return;
      calib.marks = { day: [], night: [] };
      renderCalib();
      render();
    });

    var scrim = el('scrim');
    if (scrim) scrim.addEventListener('click', closePanels);

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closePanels();
    });

    var passwordInput = el('ownerPasswordInput');
    if (passwordInput) {
      passwordInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { event.preventDefault(); unlockOwner(); }
      });
    }

    if (form) {
      form.elements.nightEnabled.addEventListener('change', toggleNightCycle);
      form.elements.nightMode.addEventListener('change', toggleNightCycle);
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        applySettings();
      });
    }

    bindClick('exportCsv', function () {
      download('traffic-light-my-rows-' + mskDate() + '.csv',
        '﻿' + F.csv(), 'text/csv;charset=utf-8');
    });
    bindClick('exportServer', function () {
      var button = el('exportServer');
      var label = button ? button.textContent : '';
      if (button) { button.disabled = true; button.textContent = 'Готовлю…'; }
      F.serverExportCsv(90).then(function (text) {
        if (button) { button.disabled = false; button.textContent = label; }
        download('traffic-light-feedback-' + mskDate() + '.csv',
          text, 'text/csv;charset=utf-8');
        statsNote = 'Таблица сервера выгружена: ' + Math.max(0, text.split('\r\n').length - 1) + ' строк.';
        renderStats();
      }).catch(function (err) {
        if (button) { button.disabled = false; button.textContent = label; }
        statsNote = err.code === 'missing'
          ? 'На сервере не задан пароль владельца — выгрузка закрыта.'
          : 'Выгрузка не удалась: ' + err.message;
        if (err.code === 'owner-password') updateAccessUi();
        renderStats();
      });
    });
    bindClick('reloadSummary', function () {
      F.loadSummary().then(function () { renderStats(); });
    });
    bindClick('clearData', function () {
      if (!confirm('Удалить собранные отметки на этом устройстве? На сервере они останутся.')) return;
      F.clear();
      renderStats();
    });

    var body = el('statsBody');
    if (body) body.addEventListener('click', function (event) {
      var target = event.target;
      var kind = target.dataset ? target.dataset.apply : null;
      if (!kind) return;
      target.textContent = kind === 'anchor' ? 'Сдвинуто' : 'Принято';
      target.classList.add('applied');
      applySuggestion(kind, Number(target.dataset.value));
    });

    window.addEventListener('resize', render);
    window.addEventListener('online', function () { F.flush(); });
  }

  function bindClick(id, handler) {
    var node = el(id);
    if (node) node.addEventListener('click', handler);
  }

  function start() {
    var key = document.querySelector('meta[name="feedback-key"]');
    if (key && key.content) F.setKey(key.content);
    F.init();
    bind();
    registerServiceWorker();
    renderFootnote();
    render();
    updateAccessUi();
    setInterval(render, TICK_MS);
    syncClock();
    setInterval(syncClock, 10 * 60 * 1000);
    setInterval(function () { F.flush(); }, 5 * 60 * 1000);
    pullConfig();
    setInterval(pullConfig, CONFIG_POLL_MS);
    // сохранённый пароль могли отозвать на сервере — проверяем его молча
    F.verifyStoredPassword().then(function (state) {
      if (state === 'wrong') statsNote = 'Пароль владельца больше не принимается: настройки снова закрыты.';
      updateAccessUi();
    });
    F.loadSummary().then(function (summary) {
      if (summary) renderStats();
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { syncClock(); pullConfig(); render(); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
