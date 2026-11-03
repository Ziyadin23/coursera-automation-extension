const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const scriptPath = path.join(__dirname, '../dist/scripts/deepseek.js');
const questions = [
  { type: 'mcq', question: 'Which number is even?', options: ['Three', 'Four'] },
  { type: 'textArea', question: 'What is two plus two?' }
];
const request = { action: 'DEEPSEEK_SOLVE', prompt: JSON.stringify(questions), images: [] };
const sender = { id: 'test-extension', url: 'https://www.coursera.org/learn/example/attempt/1' };

function loadWorker({ storage = { deepseekApiKey: 'sk-private-test-key' }, response, fetchError } = {}) {
  const listeners = [];
  const calls = [];
  const accessLevels = [];
  const context = {
    URL, AbortController, setTimeout, clearTimeout,
    chrome: {
      runtime: {
        id: 'test-extension',
        getURL: file => 'chrome-extension://test-extension/' + file,
        onMessage: { addListener: listener => listeners.push(listener) }
      },
      storage: { local: {
        get: async () => storage,
        setAccessLevel: async value => accessLevels.push(value)
      } }
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (fetchError) throw fetchError;
      return response || {
        ok: true, status: 200,
        json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: [
          { correctOptionsIndex: [1], content: '' },
          { correctOptionsIndex: [], content: '4' }
        ] }) } }] })
      };
    }
  };
  if (fs.existsSync(scriptPath)) vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), context);
  return {
    calls, accessLevels,
    send(message = request, from = sender) {
      assert.equal(listeners.length, 1, 'DeepSeek runtime listener must be registered');
      return new Promise((resolve, reject) => {
        const keepAlive = listeners[0](message, from, value => resolve(JSON.parse(JSON.stringify(value))));
        if (!keepAlive) reject(new Error('DeepSeek message was not handled'));
      });
    }
  };
}

test('missing API key is explained without contacting DeepSeek', async () => {
  const worker = loadWorker({ storage: {} });
  const result = await worker.send();
  assert.equal(result.ok, false);
  assert.match(result.error, /ключ/i);
  assert.equal(worker.calls.length, 0);
});

test('answers use exact original option labels and the selected private model', async () => {
  const worker = loadWorker({ storage: { deepseekApiKey: 'sk-private-test-key', deepseekModel: 'deepseek-v4-pro' } });
  assert.deepEqual(await worker.send(), { ok: true, items: [
    { correctOptionsIndex: [1], correctOptions: ['Four'], content: '' },
    { correctOptionsIndex: [], correctOptions: [], content: '4' }
  ] });
  assert.equal(worker.calls.length, 1);
  assert.equal(worker.calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(worker.calls[0].options.headers.Authorization, 'Bearer sk-private-test-key');
  const body = JSON.parse(worker.calls[0].options.body);
  assert.equal(body.model, 'deepseek-v4-pro');
  assert.equal(body.stream, false);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.match(body.messages[0].content, /JSON/);
  assert.doesNotMatch(worker.calls[0].options.body, /sk-private-test-key/);
  assert.deepEqual(JSON.parse(JSON.stringify(worker.accessLevels)), [{ accessLevel: 'TRUSTED_CONTEXTS' }]);
});

test('default model works from the extension settings page', async () => {
  const worker = loadWorker();
  assert.equal((await worker.send(request, { id: 'test-extension', url: 'chrome-extension://test-extension/dist/settings.html' })).ok, true);
  assert.equal(JSON.parse(worker.calls[0].options.body).model, 'deepseek-flash');
});

test('Flash sends question images as image content', async () => {
  const worker = loadWorker();
  assert.equal((await worker.send({ ...request, images: ['https://example.org/question.png'] })).ok, true);
  const body = JSON.parse(worker.calls[0].options.body);
  assert.deepEqual(body.messages[1].content[1], { type: 'image_url', image_url: { url: 'https://example.org/question.png' } });
});

test('a text-only model explains image incompatibility before spending a request', async () => {
  const worker = loadWorker({ storage: { deepseekApiKey: 'sk-private-test-key', deepseekModel: 'deepseek-v4-pro' } });
  const result = await worker.send({ ...request, images: ['https://example.org/question.png'] });
  assert.equal(result.ok, false);
  assert.match(result.error, /Flash/);
  assert.equal(worker.calls.length, 0);
});

for (const from of [
  { id: 'another-extension', url: sender.url },
  { id: 'test-extension', url: 'https://coursera.org.attacker.example/learn/test' },
  { id: 'test-extension', url: 'https://example.org/' },
  { id: 'test-extension' }
]) test('untrusted sender cannot spend the stored API key: ' + (from.url || 'no URL'), async () => {
  const worker = loadWorker();
  assert.equal((await worker.send(request, from)).ok, false);
  assert.equal(worker.calls.length, 0);
});

for (const prompt of [
  'not JSON', '{}', '[]',
  JSON.stringify([{ question: 'Test', options: [{ text: 'invalid' }] }]),
  JSON.stringify([{ question: 5 }])
]) test('invalid question data is rejected before a request: ' + prompt.slice(0, 40), async () => {
  const worker = loadWorker();
  assert.equal((await worker.send({ ...request, prompt })).ok, false);
  assert.equal(worker.calls.length, 0);
});

test('upstream authentication errors never echo the API key or response body', async () => {
  const worker = loadWorker({ response: {
    ok: false, status: 401, json: async () => ({ error: { message: 'invalid key sk-private-test-key' } })
  } });
  const result = await worker.send();
  assert.equal(result.ok, false);
  assert.match(result.error, /ключ/i);
  assert.doesNotMatch(JSON.stringify(result), /sk-private-test-key/);
});

test('network exceptions do not echo private request details', async () => {
  const worker = loadWorker({ fetchError: new Error('Network failed with Bearer sk-private-test-key') });
  const result = await worker.send();
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /sk-private-test-key/);
});

for (const content of [
  'not JSON',
  JSON.stringify({ items: [] }),
  JSON.stringify({ items: [{ correctOptionsIndex: [9] }, { content: '4' }] }),
  JSON.stringify({ items: [{ correctOptionsIndex: [1, 1] }, { content: '4' }] }),
  JSON.stringify({ items: [{ correctOptionsIndex: [] }, { content: '4' }] }),
  JSON.stringify({ items: [{ correctOptionsIndex: ['1'] }, { content: '4' }] }),
  JSON.stringify({ items: [{ correctOptionsIndex: [1] }, { content: '' }] })
]) test('malformed answer cannot select unrelated options: ' + content.slice(0, 55), async () => {
  const worker = loadWorker({ response: { ok: true, status: 200, json: async () => ({ choices: [
    { finish_reason: 'stop', message: { content } }
  ] }) } });
  const result = await worker.send();
  assert.equal(result.ok, false);
  assert.equal(result.items, undefined);
});

test('a truncated answer is not applied even if it happens to contain valid JSON', async () => {
  const worker = loadWorker({ response: { ok: true, status: 200, json: async () => ({ choices: [
    { finish_reason: 'length', message: { content: JSON.stringify({ items: [
      { correctOptionsIndex: [1] }, { content: '4' }
    ] }) } }
  ] }) } });
  assert.equal((await worker.send()).ok, false);
});

function loadSettings(initialStorage = {}) {
  const storage = { ...initialStorage };
  const nodes = Object.fromEntries([
    'deepseekForm', 'deepseekApiKey', 'deepseekModel', 'saveDeepseekBtn',
    'removeDeepseekKeyBtn', 'deepseekStatus', 'deepseekKeyStatus'
  ].map(id => [id, { value: '', textContent: '', disabled: false, dataset: {},
    handlers: {}, addEventListener(event, handler) { this.handlers[event] = handler; } }]));
  let ready;
  const script = path.join(__dirname, '../dist/scripts/deepseek-settings.js');
  if (fs.existsSync(script)) vm.runInNewContext(fs.readFileSync(script, 'utf8'), {
    document: {
      addEventListener: (event, handler) => { if (event === 'DOMContentLoaded') ready = handler; },
      getElementById: id => nodes[id]
    },
    chrome: { storage: { local: {
      setAccessLevel: async () => {},
      get: async () => ({ ...storage }),
      set: async values => Object.assign(storage, values),
      remove: async key => { delete storage[key]; }
    } } }
  });
  return { nodes, storage, async ready() {
    assert.equal(typeof ready, 'function', 'DeepSeek settings must initialize');
    await ready();
  } };
}

test('settings never put a stored API key back in the visible form', async () => {
  const settings = loadSettings({ deepseekApiKey: 'sk-saved-secret', deepseekModel: 'deepseek-v4-pro' });
  await settings.ready();
  assert.equal(settings.nodes.deepseekApiKey.value, '');
  assert.equal(settings.nodes.deepseekModel.value, 'deepseek-v4-pro');
  assert.equal(settings.nodes.removeDeepseekKeyBtn.disabled, false);
  assert.doesNotMatch(JSON.stringify(settings.nodes), /sk-saved-secret/);
});

test('saving a model with an empty password preserves the saved key', async () => {
  const settings = loadSettings({ deepseekApiKey: 'sk-saved-secret' });
  await settings.ready();
  settings.nodes.deepseekModel.value = 'deepseek-v4-pro';
  await settings.nodes.deepseekForm.handlers.submit({ preventDefault() {} });
  assert.deepEqual(settings.storage, { deepseekApiKey: 'sk-saved-secret', deepseekModel: 'deepseek-v4-pro' });
});

test('a replacement key is stored locally then removed from the input', async () => {
  const settings = loadSettings();
  await settings.ready();
  settings.nodes.deepseekApiKey.value = ' sk-new-secret ';
  await settings.nodes.deepseekForm.handlers.submit({ preventDefault() {} });
  assert.equal(settings.storage.deepseekApiKey, 'sk-new-secret');
  assert.equal(settings.storage.deepseekModel, 'deepseek-flash');
  assert.equal(settings.nodes.deepseekApiKey.value, '');
  assert.equal(settings.nodes.removeDeepseekKeyBtn.disabled, false);
});

test('deleting a key requires the explicit delete action and keeps the model', async () => {
  const settings = loadSettings({ deepseekApiKey: 'sk-saved-secret', deepseekModel: 'deepseek-v4-pro' });
  await settings.ready();
  await settings.nodes.removeDeepseekKeyBtn.handlers.click();
  assert.deepEqual(settings.storage, { deepseekModel: 'deepseek-v4-pro' });
  assert.equal(settings.nodes.removeDeepseekKeyBtn.disabled, true);
});
