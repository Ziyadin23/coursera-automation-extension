const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const scripts = path.join(__dirname, '../dist/scripts');
const blockedResponse = { message: 'too-many-requests', explanation: 'You are temporarily blocked as you have made too many requests. Please try again later.' };

function loadBridge(status = 429) {
  const messages = [];
  const url = 'https://www.coursera.org/api/test';
  class XHR {
    constructor() { this.listeners = {}; this.status = status; this.responseType = ''; this.responseText = JSON.stringify(blockedResponse); }
    open() {}
    setRequestHeader() {}
    addEventListener(type, fn) { this.listeners[type] = fn; }
    send() { this.listeners.load?.call(this); }
    getAllResponseHeaders() { return 'content-type: application/json\nretry-after: 30\n'; }
    getResponseHeader(name) { return name.toLowerCase() === 'retry-after' ? '30' : 'application/json'; }
  }
  const response = {
    status, url,
    headers: { get: name => name.toLowerCase() === 'retry-after' ? '30' : 'application/json' },
    clone: () => ({ json: async () => blockedResponse, text: async () => JSON.stringify(blockedResponse) })
  };
  const app = {
    URL, XMLHttpRequest: XHR, navigator: {}, localStorage: { getItem: () => null },
    console: Object.fromEntries(['log', 'warn', 'info', 'error', 'exception', 'table', 'trace'].map(key => [key, () => {}])),
    setInterval: () => 1, open() {}, postMessage: message => messages.push(message),
    fetch: async () => response
  };
  app.window = app;
  vm.runInNewContext(fs.readFileSync(path.join(scripts, 'rdr.js'), 'utf8'), app, { timeout: 5000 });
  return { app, response, messages, url };
}

test('the real fetch bridge preserves Coursera HTTP 429 and Retry-After', async () => {
  const bridge = loadBridge();
  assert.equal(await bridge.app.fetch(bridge.url), bridge.response);
  const message = bridge.messages.find(value => value.response?.message === 'too-many-requests');
  assert.ok(message, 'Captured response must reach the extension');
  assert.equal(message.extra.status, 429);
  assert.equal(message.extra.retryAfter, '30');
});

test('the real XHR bridge preserves Coursera HTTP 429 and Retry-After', () => {
  const bridge = loadBridge();
  const xhr = new bridge.app.XMLHttpRequest();
  xhr.open('GET', bridge.url);
  xhr.send();
  const message = bridge.messages.find(value => value.response?.message === 'too-many-requests');
  assert.ok(message);
  assert.equal(message.extra.status, 429);
  assert.equal(message.extra.retryAfter, '30');
});

test('an HTTP 429 with unreadable JSON still reaches the extension', async () => {
  const bridge = loadBridge();
  bridge.response.clone = () => ({ json: async () => { throw new Error('invalid JSON'); } });
  await bridge.app.fetch(bridge.url);
  const notice = bridge.messages.find(value => value.extra?.status === 429);
  assert.ok(notice, 'Rate limiting must not depend on parsing the response body');
  const guard = loadGuard();
  guard.emit(notice);
  assert.equal(guard.app.courseraQuizGuard.isBlocked(), true);
});

function loadGuard(bodyText = '') {
  const messages = [], notices = [], events = {}, runtime = [];
  const document = {
    readyState: 'loading', body: { innerText: bodyText, appendChild: node => notices.push(node) },
    addEventListener: (name, fn) => { events['document:' + name] = fn; },
    getElementById: id => notices.find(node => node.id === id) || null,
    createElement: () => ({ style: {}, setAttribute() {} })
  };
  const app = {
    URL, document, location: { href: 'https://www.coursera.org/learn/test/attempt' },
    addEventListener: (name, fn) => { events[name] = fn; },
    chrome: { runtime: {
      onMessage: { addListener: fn => runtime.push(fn) },
      sendMessage: (message, callback) => { messages.push(message); callback?.(); }
    } }
  };
  app.window = app;
  const context = vm.createContext(app);
  vm.runInContext(fs.readFileSync(path.join(scripts, 'quiz-guard.js'), 'utf8'), context);
  const frame = vm.runInContext('window', context);
  return {
    app, messages, notices,
    emit(data, source = frame) { events.message({ data, source }); },
    ready() { events['document:DOMContentLoaded'](); },
    stop() { for (const fn of runtime) fn({ action: 'STOP_QUIZ_AUTOMATION', payload: { reason: 'rate_limited' } }); }
  };
}

test('Coursera 429 blocks automation and notifies the pool only once', () => {
  const guard = loadGuard();
  const message = { url: 'https://www.coursera.org/api/test', response: blockedResponse, extra: { status: 429, retryAfter: '30' } };
  guard.emit(message);
  guard.emit(message);
  assert.equal(guard.app.courseraQuizGuard.isBlocked(), true);
  assert.equal(guard.messages.length, 1);
  assert.equal(guard.messages[0].action, 'QUIZ_RATE_LIMITED');
  assert.equal(guard.messages[0].payload.retryAfterSeconds, 30);
  assert.match(guard.notices[0].textContent, /30/);
  guard.ready();
  assert.match(guard.notices[0].textContent, /30/, 'DOMContentLoaded must preserve server retry guidance');
});

test('a too-many-requests JSON body is recognized without an HTTP status', () => {
  const guard = loadGuard();
  guard.emit({ url: 'https://www.coursera.org/api/test', response: blockedResponse });
  assert.equal(guard.app.courseraQuizGuard.isBlocked(), true);
  assert.equal(guard.messages.length, 1);
});

test('a full-page Coursera too-many-requests JSON stops automation', () => {
  const guard = loadGuard(JSON.stringify(blockedResponse));
  guard.ready();
  assert.equal(guard.app.courseraQuizGuard.isBlocked(), true);
  assert.equal(guard.messages[0].action, 'QUIZ_RATE_LIMITED');
});

test('non-Coursera 429 responses and unrelated windows cannot stop the pool', () => {
  const guard = loadGuard();
  guard.emit({ url: 'https://api.deepseek.com/chat/completions', extra: { status: 429 } });
  guard.emit({ url: 'https://coursera.org.attacker.example/api/test', response: blockedResponse });
  guard.emit({ url: 'https://www.coursera.org/api/test', extra: { status: 429 } }, {});
  assert.equal(guard.app.courseraQuizGuard.isBlocked(), false);
  assert.deepEqual(guard.messages, []);
});

test('a pool stop blocks the current tab without sending a notification loop', () => {
  const guard = loadGuard();
  guard.stop();
  assert.equal(guard.app.courseraQuizGuard.isBlocked(), true);
  assert.deepEqual(guard.messages, []);
});
