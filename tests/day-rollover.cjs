const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Exercise the actual page in a hidden Electron window with an isolated profile.
const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'our-home-rollover-'));
app.setPath('userData', path.join(testDirectory, 'profile'));
const source = fs.readFileSync(path.join(__dirname, '..', 'dist', 'index.html'), 'utf8');

function installClock(initialTime) {
  const NativeDate = Date;
  let time = new NativeDate(initialTime).getTime(), nextId = 0;
  const timers = new Map();
  window.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return time; }
  };
  const schedule = (callback, delay = 0, repeat = false) => {
    const id = ++nextId;
    timers.set(id, { callback, delay, repeat, at: time + delay });
    return id;
  };
  window.setTimeout = (callback, delay) => schedule(callback, delay);
  window.setInterval = (callback, delay) => schedule(callback, delay, true);
  window.clearTimeout = window.clearInterval = id => timers.delete(id);
  window.testClock = {
    jump(value) { time = new NativeDate(value).getTime(); },
    advance(value) {
      const target = new NativeDate(value).getTime();
      let count = 0;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        if (++count > 10000) throw new Error('Timer loop');
        const [id, timer] = next;
        time = Math.max(time, timer.at);
        if (timer.repeat) timer.at = time + timer.delay;
        else timers.delete(id);
        timer.callback();
      }
      time = target;
    }
  };
  window.testErrors = [];
  window.addEventListener('error', event => testErrors.push(event.message));
  window.addEventListener('unhandledrejection', event => testErrors.push(String(event.reason)));
  localStorage.clear();
  localStorage.setItem('our-home-recurring-v2', JSON.stringify(['daily', 'weekly', 'biweekly', 'monthly'].map(frequency => ({
    id: frequency, title: frequency, frequency, weekday: 3, startDate: '2026-11-18', person: '👥', who: 'Для всех'
  }))));
  localStorage.setItem('our-home-tasks', JSON.stringify([{ id: 'shared', title: 'Shared task', done: true, meta: 'Для всех', person: '👥' }]));
}

async function withPage(initialTime, check) {
  const file = path.join(testDirectory, 'test.html');
  const bootstrap = `<script>(${installClock.toString()})(${JSON.stringify(initialTime)});</script>`;
  fs.writeFileSync(file, source.replace('<script>', bootstrap + '<script>'));
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, sandbox: true } });
  const run = script => window.webContents.executeJavaScript(script);
  try {
    await window.loadFile(file);
    await run(`['daily', 'weekly', 'biweekly', 'monthly'].forEach(id => toggleTask('r', id))`);
    assert.deepEqual(await active(run), []);
    await check(run);
    assert.deepEqual(await run('testErrors'), []);
  } finally {
    window.destroy();
  }
}

function active(run) {
  return run(`Array.from(document.querySelectorAll('#todayList .task')).filter(task => !task.querySelector('input').checked).map(task => task.querySelector('.title').textContent)`);
}

async function main() {
  await app.whenReady();
  const boundaries = [
    ['daily and weekly', '2026-11-24T23:59:59.900', '2026-11-25T00:00:00.001', ['daily', 'weekly']],
    ['two-week cycle', '2026-12-01T23:59:59.900', '2026-12-02T00:00:00.001', ['daily', 'weekly', 'biweekly']],
    ['month', '2026-11-30T23:59:59.900', '2026-12-01T00:00:00.001', ['daily', 'monthly']],
    ['year', '2026-12-31T23:59:59.900', '2027-01-01T00:00:00.001', ['daily', 'monthly']]
  ];
  for (const [name, before, after, expected] of boundaries) {
    await withPage(before, async run => {
      const history = await run(`localStorage.getItem('our-home-period-completions')`);
      const shared = await run(`localStorage.getItem('our-home-tasks')`);
      await run(`testClock.advance(${JSON.stringify(after)})`);
      assert.deepEqual(await active(run), expected, name);
      assert.equal(await run(`document.querySelector('#today .sub').textContent`), new Date(after).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }));
      assert.equal(await run(`document.getElementById('progressText').textContent`), `${4 - expected.length} из 4`);
      assert.equal(await run(`localStorage.getItem('our-home-period-completions')`), history, 'History is preserved');
      assert.equal(await run(`localStorage.getItem('our-home-tasks')`), shared, 'Shared tasks are preserved');
    });
    console.log(`PASS: ${name} rollover in a hidden window`);
  }
  for (const event of ['focus', 'visibilitychange', 'timer']) {
    await withPage('2026-11-24T18:00:00', async run => {
      await run(`testClock.jump('2026-11-27T08:00:00')`);
      if (event === 'timer') await run(`testClock.advance('2026-11-27T08:00:00')`);
      else await run(`${event === 'focus' ? 'window' : 'document'}.dispatchEvent(new Event('${event}'))`);
      assert.deepEqual(await active(run), ['daily', 'weekly']);
    });
    console.log(`PASS: refresh after sleep via ${event}`);
  }
  await withPage('2026-11-24T23:59:59.900', async run => {
    await run(`openModal('recurring'); document.getElementById('newTitle').value = 'Unfinished draft'; testClock.advance('2026-11-25T00:00:00.001')`);
    assert.equal(await run(`document.getElementById('newTitle').value`), 'Unfinished draft');
    assert.equal(await run(`document.getElementById('modal').classList.contains('show')`), true);
    await run(`closeModal(); document.querySelector('[data-today-filter="active"]').click(); testClock.advance('2026-11-26T00:00:00.001')`);
    assert.equal(await run(`document.querySelector('[data-today-filter="active"]').classList.contains('on')`), true);
  });
  console.log('PASS: open draft and list filter survive rollover');
  await withPage('2026-11-24T23:59:59.900', async run => {
    await run(`testClock.jump('2026-11-25T00:00:00.001'); toggleTask('r', 'daily')`);
    const history = await run(`JSON.parse(localStorage.getItem('our-home-period-completions'))`);
    assert.equal(history['daily|d:2026-11-24'], true);
    assert.equal(history['daily|d:2026-11-25'], true);
  });
  console.log('PASS: completion uses the current date before a delayed timer runs');
  await withPage('2026-11-24T18:00:00', async run => {
    await run(`testClock.jump('2026-12-03T08:00:00'); openModal('recurring'); document.getElementById('newTitle').value = 'New cycle'; document.getElementById('newFrequency').value = 'biweekly'; document.getElementById('newWeekday').value = '3'; document.getElementById('taskForm').dispatchEvent(new Event('submit', { cancelable: true }))`);
    const task = await run(`JSON.parse(localStorage.getItem('our-home-recurring-v2')).find(task => task.title === 'New cycle')`);
    assert.equal(task.startDate, '2026-12-02');
  });
  console.log('PASS: new recurring tasks use the current cycle after sleep');
}

// Avoid quitting between test windows; everything uses a disposable profile.
app.on('window-all-closed', () => {});
main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
