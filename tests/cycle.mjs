/*
 * Тесты расписания: якорь фазы («красный включается в ЧЧ:ММ:СС по МСК»),
 * вывод цикла из нажатий и разбор phaseStart на сервере.
 *
 *   node tests/cycle.mjs
 *
 * Юнит-часть грузит public/js/schedule.js в песочницу и считает на фиксированных
 * эпохах — часового пояса машины тут нет. Интеграционная часть поднимает свой
 * инстанс сервера во временной папке: файл настроек проекта и таблица отметок не
 * трогаются, тестовый пароль живёт только в окружении этого процесса.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, execSync } from 'node:child_process';
import { createContext, runInContext } from 'node:vm';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SERVER = path.join(ROOT, 'server', 'api.mjs');
const SCHEDULE_FILE = path.join(ROOT, 'public', 'js', 'schedule.js');

const results = [];

function pass(name, condition, detail) {
  results.push({ name, status: condition ? 'ok' : 'FAIL', detail: detail === undefined ? '' : String(detail) });
  return !!condition;
}

function eq(name, actual, expected) {
  const ok = actual === expected;
  return pass(name, ok, ok ? '' : 'ожидалось ' + JSON.stringify(expected) +
    ', получилось ' + JSON.stringify(actual));
}

function loadScheduleModule() {
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  createContext(sandbox);
  runInContext(readFileSync(SCHEDULE_FILE, 'utf8'), sandbox, { filename: SCHEDULE_FILE });
  return sandbox.TrafficSchedule;
}

const S = loadScheduleModule();
const MSK_MIDNIGHT_EPOCH = Date.UTC(2026, 9, 29, 21, 0, 0); // 30 октября 2026, 00:00 МСК
const sec = (h, m, s) => ((h * 3600 + m * 60 + (s || 0)) * 1000);

// ---------- парсер якоря ----------

eq('U01 «14:32:07» → секунды', S.parseClockSeconds('14:32:07', 0), 14 * 3600 + 32 * 60 + 7);
eq('U02 «8:05» без секунд', S.parseClockSeconds('8:05', 0), 8 * 3600 + 5 * 60);
eq('U03 просто число секунд', S.parseClockSeconds('75', 0), 75);
eq('U04 пустая строка → фолбэк', S.parseClockSeconds('', 42), 42);
eq('U05 «25:99» → фолбэк', S.parseClockSeconds('25:99', 42), 42);
eq('U06 «abc» → фолбэк', S.parseClockSeconds('abc', 42), 42);
eq('U07 86400 — уже не сутки, берём фолбэк', S.parseClockSeconds('86400', 42), 42);
eq('U08 формат «ЧЧ:ММ:СС»', S.formatClockSeconds(52327), '14:32:07');
eq('U09 круглый год', S.formatClockSeconds(86399), '23:59:59');
eq('U10 якорь проходит круг ЧЧ:ММ:СС', S.parseClockSeconds(S.formatClockSeconds(37230), 0), 37230);

// ---------- normalize: якорь по умолчанию ----------

const bare = S.normalize({});
eq('U11 без конфига: дневной якорь в полночь', bare.dayPhaseStart, 0);
eq('U12 без ночи: ночной якорь = начало окна', bare.nightPhaseStart, 23 * 3600);

const nightOn = S.normalize({ night: { enabled: true, start: '22:30', end: '05:00', mode: 'cycle' } });
eq('U13 с ночью: дневной якорь = конец окна', nightOn.dayPhaseStart, 5 * 3600);
eq('U14 с ночью: ночной якорь = начало окна', nightOn.nightPhaseStart, 22 * 3600 + 30 * 60);

const explicit = S.normalize({
  day: { red: 10, yellow: 2, green: 5, phaseStart: '03:00:05' },
  nightCycle: { red: 20, yellow: 2, green: 8, phaseStart: '22:30:20' },
  night: { enabled: true, start: '22:30', end: '05:00', mode: 'cycle' }
});
eq('U15 якорь дня из явного значения', explicit.dayPhaseStart, sec(3, 0, 5) / 1000);
eq('U16 якорь ночи из формы кэша (nightCycle)', explicit.nightPhaseStart, sec(22, 30, 20) / 1000);

const serverShape = S.normalize({
  day: { red: 10, yellow: 2, green: 5, phaseStart: '03:00:05' },
  night: {
    enabled: true, start: '22:30', end: '05:00', mode: 'cycle',
    cycle: { red: 20, yellow: 2, green: 8, phaseStart: '22:30:20' }
  }
});
eq('U17 якорь ночи из серверной формы (night.cycle)', serverShape.nightPhaseStart, sec(22, 30, 20) / 1000);
eq('U18 длительности ночи из серверной формы', serverShape.night.red, 20);
eq('U19 битый якорь молча чинится', S.normalize({ day: { phaseStart: 'восемь' } }).dayPhaseStart, 0);

// ---------- stateAt: позиция относительно якоря ----------

const anchored = S.normalize({ day: { red: 10, yellow: 2, green: 5, phaseStart: '03:00:05' } });
const anchor = MSK_MIDNIGHT_EPOCH + sec(3, 0, 5);
eq('U20 profileStart даёт якорь текущего дня', S.profileStart(anchor + 60000, anchored), anchor);

const atAnchor = S.stateAt(anchor, anchored);
eq('U21 ровно в якорь — красный', atAnchor.id, 'red');
eq('U22 …с полной длительностью', atAnchor.remainingMs, 10000);
eq('U23 …и нулевым ходом', atAnchor.elapsedMs, 0);
eq('U24 за секунду до якоря — зелёный предыдущей реплики', S.stateAt(anchor - 1000, anchored).id, 'green');
eq('U25 через красный — жёлтый', S.stateAt(anchor + 10000, anchored).id, 'yellow');
eq('U26 через красный и жёлтый — зелёный', S.stateAt(anchor + 12000, anchored).id, 'green');
eq('U27 через весь цикл — снова красный', S.stateAt(anchor + 17000, anchored).id, 'red');
eq('U28 якорь цикла в отметке состояния', S.stateAt(anchor + 12000, anchored).cycleAnchor, anchor);
eq('U29 реплика якоря считается от якоря, а не от полуночи',
  S.stateAt(anchor + 17000, anchored).cycleAnchor, anchor + 17000);

const nightCycleSchedule = serverShape;
// ночной якорь 22:30:20, цикл 20/2/8; в 23:00:15 прошло 1795 с → 1795 mod 30 = 25 → зелёный, 3 с от старта
const nightAt = MSK_MIDNIGHT_EPOCH + sec(23, 0, 15);
const nightState = S.stateAt(nightAt, nightCycleSchedule);
eq('U30 ночью — ночной профиль', nightState.profile, 'night');
eq('U31 позиция от ночного якоря', nightState.id, 'green');
eq('U32 зелёный идёт 3 с от своего старта', nightState.elapsedMs, 3000);

const flashing = S.normalize({ night: { enabled: true, start: '22:30', end: '05:00', mode: 'flashing' } });
eq('U33 мигающий жёлтый якоря не имеет', S.stateAt(nightAt, flashing).mode, 'flashing');

// ---------- derive: цикл из нажатий ----------

function taps(startMs, durations, repeats, jitter) {
  const marks = [];
  const cycle = [durations.red, durations.yellow, durations.green];
  let t = startMs;
  for (let r = 0; r < repeats; r++) {
    for (let i = 0; i < 3; i++) {
      marks.push({ ts: t, id: S.PHASE_ORDER[i] });
      t += cycle[i] * 1000 + (jitter[r * 3 + i] || 0);
    }
  }
  marks.push({ ts: t, id: 'red' });
  return marks;
}

const clean = S.derive(taps(anchor, { red: 62, yellow: 3, green: 25 }, 3, []));
eq('U34 три цикла посчитаны', clean.cycles, 3);
eq('U35 красный', clean.red, 62);
eq('U36 жёлтый', clean.yellow, 3);
eq('U37 зелёный', clean.green, 25);
eq('U38 длина цикла', clean.totalSec, 90);
eq('U39 якорь = момент последнего нажатия красного', clean.phaseStartText, S.formatClockSeconds(sec(3, 0, 5) / 1000 + 2 * 90));
eq('U40 без джиттера хода нет', clean.spreadSec, 0);
eq('U41 трёх меток одного цикла мало', S.derive(taps(anchor, { red: 62, yellow: 3, green: 25 }, 1, [])).ready, false);
eq('U42 двух циклов достаточно', S.derive(taps(anchor, { red: 62, yellow: 3, green: 25 }, 2, [])).ready, true);

const jittered = S.derive(taps(anchor, { red: 62, yellow: 3, green: 25 }, 3,
  [-400, 250, -100, 300, -250, 150, -100, 400, -300]));
eq('U43 джиттер ±0.4 с не сбивает длительности',
  [jittered.red, jittered.yellow, jittered.green].join('/'), '62/3/25');
pass('U44 якорь остаётся в пределах суток',
  jittered.phaseStart >= 0 && jittered.phaseStart < 86400, 'phaseStart=' + jittered.phaseStart);
// истинный якорь 10805 с от полуночи при цикле 90 с даёт остаток 5 с
pass('U45 круговой якорь укладывается в секунду',
  Math.abs(jittered.moduloPhaseStart - 5) <= 1, 'modulo=' + jittered.moduloPhaseStart);
pass('U46 ход между циклами не разрастается', jittered.spreadSec <= 1, 'spread=' + jittered.spreadSec);

const skipped = taps(anchor, { red: 62, yellow: 3, green: 25 }, 3, []);
skipped.splice(4, 1); // пропущенная метка жёлтого во втором цикле
const fromSkipped = S.derive(skipped);
eq('U47 пропущенная метка не ломает красный', fromSkipped.red, 62);
eq('U48 …и зелёный', fromSkipped.green, 25);
eq('U49 цикл всё ещё готов', fromSkipped.ready, true);

const wrongOrder = [
  { ts: anchor, id: 'red' }, { ts: anchor + 62000, id: 'red' }, { ts: anchor + 120000, id: 'green' },
  { ts: anchor + 124000, id: 'yellow' }, { ts: anchor + 125000, id: 'red' }
];
eq('U50 мусор вместо последовательности даёт ноль циклов', S.derive(wrongOrder).cycles, 0);
eq('U51 пустой список меток безопасен', S.derive([]).ready, false);
eq('U52 метки без ts отбрасываются', S.derive([{ id: 'red' }, null, { ts: 1, id: 'purple' }]).marks, 0);
eq('U53 жёлтый длиннее минуты урезается', S.derive(taps(anchor, { red: 62, yellow: 90, green: 25 }, 2, [])).yellow, 60);

// ---------- сервер: phaseStart в конфиге ----------

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitUp(base) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) return;
    } catch (err) { /* инстанс ещё поднимается */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('сервер не поднялся: ' + base);
}

const TEST_PASSWORD = 'cycle-test-secret';

async function integration() {
  const dir = mkdtempSync(path.join(tmpdir(), 'tl-cycle-'));
  const configFile = path.join(dir, 'settings.json');
  let child = null;
  try {
    const port = await freePort();
    child = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(port),
        CONFIG_FILE: configFile,
        DATA_DIR: path.join(dir, 'data'),
        ADMIN_PASSWORD: TEST_PASSWORD
      }),
      stdio: 'ignore',
      windowsHide: true
    });
    const base = 'http://127.0.0.1:' + port;
    await waitUp(base);

    const getConfig = () => fetch(base + '/api/config').then((r) => r.json());
    const postConfig = (body) => fetch(base + '/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-password': TEST_PASSWORD },
      body: JSON.stringify(body)
    });

    const fresh = await getConfig();
    eq('I01 свежий файл: дневной якорь в полночь', fresh.config.day.phaseStart, '00:00:00');
    eq('I02 свежий файл: ночной якорь в начало окна', fresh.config.night.phaseStart, '23:00:00');

    const draft = (dayPhase, nightPhase, night) => ({
      day: { red: 51, yellow: 3, green: 25, phaseStart: dayPhase },
      night: Object.assign({ enabled: false, start: '23:00', end: '06:00', mode: 'flashing',
        cycle: { red: 60, yellow: 3, green: 25, phaseStart: nightPhase } }, night || {})
    });

    let saved = await (await postConfig(draft('08:15:30', '23:00:00'))).json();
    eq('I03 «08:15:30» сохранён как есть', saved.config.day.phaseStart, '08:15:30');
    eq('I04 якорь дошёл до файла', JSON.parse(readFileSync(configFile, 'utf8')).day.phaseStart, '08:15:30');
    eq('I05 GET после POST отдаёт то же', (await getConfig()).config.day.phaseStart, '08:15:30');

    saved = await (await postConfig(draft(37230, '23:00:00'))).json();
    eq('I06 число секунд → «10:20:30»', saved.config.day.phaseStart, '10:20:30');

    saved = await (await postConfig(draft('08:15', '23:00:00'))).json();
    eq('I07 «08:15» дополняется до секунд', saved.config.day.phaseStart, '08:15:00');

    saved = await (await postConfig(draft('banana', '23:00:00'))).json();
    eq('I08 мусор чинится в дефолт', saved.config.day.phaseStart, '00:00:00');

    saved = await (await postConfig({ day: { red: 51, yellow: 3, green: 25 } })).json();
    eq('I09 без якоря — дефолт', saved.config.day.phaseStart, '00:00:00');

    saved = await (await postConfig(draft(undefined, undefined,
      { enabled: true, start: '22:30', end: '05:00', mode: 'cycle' }))).json();
    eq('I10 ночь включена, якорь дня = конец окна', saved.config.day.phaseStart, '05:00:00');
    eq('I11 якорь ночи = начало окна', saved.config.night.phaseStart, '22:30:00');

    saved = await (await postConfig(draft('08:15:30', '23:07:15',
      { enabled: true, start: '22:30', end: '05:00', mode: 'cycle' }))).json();
    eq('I12 ночной якорь из night.cycle', saved.config.night.phaseStart, '23:07:15');

    const denied = await fetch(base + '/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft('09:00:00', '23:00:00'))
    });
    eq('I13 якорь без парола не пишется', denied.status, 403);

    // то, что записал сервер, страница должна разобрать в тот же якорь
    const roundTrip = S.normalize({ day: saved.config.day, nightCycle: saved.config.night,
      night: { enabled: true, start: '22:30', end: '05:00', mode: 'cycle' } });
    eq('I14 серверный ответ ↔ клиентский якорь', roundTrip.dayPhaseStart, 8 * 3600 + 15 * 60 + 30);
    eq('I15 …и ночной', roundTrip.nightPhaseStart, 23 * 3600 + 7 * 60 + 15);
  } finally {
    if (child) {
      try {
        if (process.platform === 'win32') execSync('taskkill /PID ' + child.pid + ' /F', { stdio: 'ignore' });
        else child.kill();
      } catch (err) { /* процесс уже завершился */ }
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  }
}

await integration();

const failed = results.filter((r) => r.status === 'FAIL');
for (const r of results) {
  console.log((r.status === 'ok' ? '  ok  ' : ' FAIL ') + r.name + (r.detail ? '   [' + r.detail + ']' : ''));
}
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' пройдено');
process.exit(failed.length ? 1 : 0);
