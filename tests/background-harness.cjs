const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const scripts = path.join(__dirname, '../dist/scripts');

function loadWorker({ browser, deferCreate = false, slowPerformance = false, fetch: fetchFixture } = {}) {
  browser ||= {
    now: 100000, nextTabId: 100, tabs: new Map(), session: {}, alarms: new Map(),
    calls: { created: [], removed: [], messages: [], reloaded: [], imports: [], fetch: [], writes: [] }
  };
  const calls = browser.calls;
  const listeners = Object.fromEntries(['message', 'removed', 'updated', 'installed', 'commands', 'alarm'].map(name => [name, []]));
  const timers = new Map(), intervals = new Map();
  let timerId = 0, resolveCreate, performanceSample = 0;
  const clone = value => JSON.parse(JSON.stringify(value));
  const event = name => ({ addListener: handler => listeners[name].push(handler) });
  const clock = {
    setTimeout(handler, delay = 0) {
      const id = ++timerId;
      timers.set(id, { at: browser.now + delay, handler });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval(handler) { const id = ++timerId; intervals.set(id, handler); return id; },
    clearInterval(id) { intervals.delete(id); }
  };
  class FakeDate extends Date { static now() { return browser.now; } }
  let context;
  const app = {
    console: Object.fromEntries(['log', 'warn', 'info', 'error', 'debug', 'trace', 'table', 'exception'].map(name => [name, () => {}])),
    ...clock, Date: FakeDate, URL, AbortController,
    performance: { now: () => slowPerformance ? (performanceSample++ % 2 ? 101 : 0) : browser.now },
    navigator: { userAgent: 'test' },
    importScripts(file) {
      calls.imports.push(file);
      if (file !== 'deepseek.js') vm.runInContext(fs.readFileSync(path.join(scripts, file), 'utf8'), context, { timeout: 5000 });
    },
    fetch: async (url, options) => {
      calls.fetch.push({ url, options });
      if (!fetchFixture) throw new Error('Unexpected external request');
      return fetchFixture(url, options);
    },
    chrome: {
      storage: {
        local: { get: async () => ({}), set: async () => {} },
        sync: { get: async () => ({}) },
        session: {
          get: async key => ({ [key]: clone(browser.session[key] ?? null) }),
          set: async values => { Object.assign(browser.session, clone(values)); calls.writes.push(clone(values)); }
        }
      },
      alarms: {
        onAlarm: event('alarm'),
        create(name, options) { browser.alarms.set(name, options.when); },
        async clear(name) { return browser.alarms.delete(name); }
      },
      runtime: {
        id: 'test-extension', onMessage: event('message'), onInstalled: event('installed'),
        onStartup: { addListener() {} }, onUpdateAvailable: { addListener() {} },
        getManifest: () => ({ version: '3.6.11' }), lastError: undefined, reload() {}
      },
      tabs: {
        onRemoved: event('removed'), onUpdated: event('updated'),
        async create(options) {
          const tab = { id: browser.nextTabId++, ...options };
          browser.tabs.set(tab.id, tab);
          calls.created.push({ ...tab, at: browser.now,
            persistedPending: Object.values(browser.session).some(value => value?.pending?.url === options.url) });
          if (deferCreate) await new Promise(resolve => { resolveCreate = resolve; });
          return tab;
        },
        async get(id) { if (!browser.tabs.has(id)) throw new Error('No tab'); return browser.tabs.get(id); },
        async remove(id) {
          calls.removed.push(id); browser.tabs.delete(id);
          queueMicrotask(() => listeners.removed.forEach(handler => handler(id)));
        },
        async sendMessage(id, message) { calls.messages.push({ id, message: clone(message) }); },
        async reload(id) { calls.reloaded.push(id); },
        query(_filter, callback) {
          const values = [...browser.tabs.values()];
          if (callback) callback(values);
          return Promise.resolve(values);
        }
      },
      commands: { onCommand: event('commands') }, action: { openPopup: async () => {} }
    }
  };
  context = vm.createContext(app);
  vm.runInContext(fs.readFileSync(path.join(scripts, 'background.js'), 'utf8'), context, { timeout: 5000 });
  async function flush() { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); }
  async function message(value, id = 10, senderUrl = 'https://www.coursera.org/learn/course') {
    let respond;
    const response = new Promise(resolve => { respond = resolve; });
    for (const handler of listeners.message) handler(value, { tab: { id, url: senderUrl }, id: 'test-extension' }, respond);
    await flush();
    return response;
  }
  async function advance(milliseconds) {
    await flush();
    const end = browser.now + milliseconds;
    for (;;) {
      const dueTimers = [...timers].filter(([, timer]) => timer.at <= end).map(([id, timer]) => ({ id, ...timer }));
      const dueAlarms = [...browser.alarms].filter(([, at]) => at <= end).map(([name, at]) => ({ name, at }));
      const next = [...dueTimers, ...dueAlarms].sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      browser.now = Math.max(browser.now, next.at);
      if (next.name) {
        browser.alarms.delete(next.name);
        listeners.alarm.forEach(handler => handler({ name: next.name }));
      } else { timers.delete(next.id); next.handler(); }
      await flush();
    }
    browser.now = end;
    await flush();
  }
  return {
    browser, calls, message, advance, flush,
    discardTimers() { timers.clear(); },
    start: () => message({ action: 'START_QUIZ_POOL', concurrency: 3, openCourseSlug: 'course', quizzes: [1, 2, 3, 4].map(index => ({ itemId: 'quiz-' + index, slug: 'quiz', name: 'Quiz ' + index })) }),
    close: id => message({ action: 'CLOSE_TAB' }, id),
    stop: () => message({ action: 'STOP_QUIZ_POOL' }),
    async status() { return (await message({ action: 'GET_QUIZ_POOL_STATUS' })).active; },
    releaseCreate() { resolveCreate?.(); },
    async update(id, url) {
      for (const handler of listeners.updated) await handler(id, { url }, { id, url, status: 'complete' });
      await flush();
    },
    async tickIntervals() { for (const handler of intervals.values()) handler(); await flush(); }
  };
}
module.exports = { loadWorker };
