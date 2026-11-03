const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { test } = require('node:test');

const scripts = path.join(__dirname, '../dist/scripts');
const contentSource = fs.readFileSync(path.join(scripts, 'content.js'), 'utf8');
const providerSource = fs.readFileSync(path.join(scripts, 'deepseek.js'), 'utf8');
const privateKey = 'sk-private-test-key-never-content';
const optionTexts = ['Three', 'Four'];

function memoryStorage() {
  const values = {};
  return {
    getItem: key => values[key] ?? null,
    setItem: (key, value) => { values[key] = String(value); },
    removeItem: key => { delete values[key]; }
  };
}

function loadExtension(flags = {}, options = {}) {
  const providerCalls = [], providerListeners = [], messages = [], opened = [], nodes = [], contentRequests = [], materialRequests = [];
  const windowEvents = {}, documentEvents = {}, runtimeListeners = [], timers = [];
  let blocked = false, reloads = 0;

  class Element {
    constructor(tag = 'div') {
      Object.assign(this, {
        tagName: tag.toUpperCase(), style: {}, children: [], dataset: {}, attributes: {},
        className: '', textContent: '', innerText: '', id: '', handlers: {},
        isConnected: true, checked: false, disabled: false, clicks: 0
      });
      this.classList = { contains: name => this.className.split(' ').includes(name), add() {} };
      nodes.push(this);
    }
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    removeChild(child) { this.children = this.children.filter(value => value !== child); }
    remove() { this.isConnected = false; this.parentElement?.removeChild(this); }
    addEventListener(type, handler) { (this.handlers[type] ??= []).push(handler); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    setAttribute(key, value) { this.attributes[key] = value; }
    dispatchEvent() {}
    click() { this.clicks++; if (this.tagName === 'INPUT') this.checked = this.type === 'checkbox' ? !this.checked : true; }
    focus() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
  }
  class Input extends Element {
    constructor() { super('input'); }
    set value(value) { this._value = value; }
    get value() { return this._value; }
  }

  const inputs = optionTexts.map(text => {
    const input = new Input();
    input.type = 'checkbox';
    input.id = 'option-' + text;
    input.parentElement = { querySelector: () => ({ innerText: text }) };
    return input;
  });
  const question = new Element('div');
  question.querySelectorAll = selector => selector.includes('input[type=') ? inputs : [];
  question.querySelector = selector => selector === 'div[data-testid="cml-viewer"]' ?
    { innerText: 'Which number is even?' } : selector === 'textarea, input' ? inputs[0] : null;
  const submit = new Element('button'), confirm = new Element('button');
  const defaultConfirmClick = confirm.click.bind(confirm);
  confirm.click = () => {
    defaultConfirmClick();
    if (options.confirmDisappears) confirm.isConnected = false;
    options.onConfirm?.();
  };
  const next = new Element('button'), check = new Element('button');
  next.textContent = 'Next'; check.textContent = 'Check';
  const document = {
    readyState: 'loading', body: new Element('body'), head: new Element('head'), documentElement: new Element('html'),
    createElement: tag => new Element(tag),
    addEventListener: (type, handler) => (documentEvents[type] ??= []).push(handler),
    getElementById: id => nodes.find(node => node.id === id && node.isConnected) || null,
    getElementsByTagName: tag => tag === 'script' ? [{ innerHTML: 'window.App = ' + JSON.stringify({
      context: { dispatcher: { stores: { ApplicationStore: { userData: {
        id: 12345, authenticated: true, fullName: 'Private User', email_address: 'private@example.invalid'
      } } } } }
    }) + ';' }] : [],
    createTreeWalker: (_root, _mask, filter) => {
      let index = 0;
      return { nextNode() {
        if (!options.singleQuestion) return null;
        while (index < nodes.length) {
          const node = nodes[index++];
          if (filter.acceptNode(node) === 1) return node;
        }
        return null;
      } };
    },
    querySelectorAll: selector => selector === 'div.css-1tfphom' ? [question] : [],
    querySelector: selector => selector === 'button[data-testid="submit-button"]' ? submit :
      selector === 'button[data-testid="dialog-submit-button"]' ? (confirm.isConnected ? confirm : null) :
        selector === 'header h2' && options.singleQuestion ? { textContent: 'Question 1 of 2' } :
          selector === '.toasts' ? nodes.find(node => node.className === 'toasts') || null : null,
    execCommand: () => true
  };

  if (options.singleQuestion) document.body.append(next, check);

  vm.runInNewContext(providerSource, {
    URL, AbortController, setTimeout, clearTimeout,
    chrome: {
      runtime: { id: 'test-extension', onMessage: { addListener: handler => providerListeners.push(handler) } },
      storage: { local: {
        setAccessLevel: async () => {},
        get: async () => ({ deepseekApiKey: privateKey, deepseekModel: 'deepseek-flash' })
      } }
    },
    fetch: async (url, options) => {
      providerCalls.push({ url, options });
      if (pendingProvider) await pendingProvider;
      return { ok: true, status: 200, json: async () => ({ choices: [{
        finish_reason: 'stop', message: { content: JSON.stringify({ items: [{ correctOptionsIndex: [1], content: '' }] }) }
      }] }) };
    }
  }, { timeout: 2000 });

  const pendingProvider = options.providerWait;
  const app = {
    document,
    location: {
      href: 'https://www.coursera.org/learn/test/assignment-submission/item-1/attempt',
      pathname: '/learn/test/assignment-submission/item-1/attempt',
      reload() { reloads++; }
    },
    addEventListener: (type, handler) => (windowEvents[type] ??= []).push(handler),
    open: url => opened.push(url),
    console: Object.fromEntries(['log', 'warn', 'info', 'error', 'debug', 'trace', 'table', 'exception'].map(name => [name, () => {}])),
    JSON, Uint8Array, URL, TextEncoder, TextDecoder, crypto: webcrypto, btoa, atob,
    NodeFilter: { SHOW_ELEMENT: 1, FILTER_SKIP: 3, FILTER_ACCEPT: 1 },
    HTMLElement: Element, HTMLButtonElement: Element, HTMLInputElement: Input,
    DOMParser: class { parseFromString(value) { return { body: { textContent: String(value || '').replace(/<[^>]*>/g, '') } }; } },
    MutationObserver: class { observe() {} disconnect() {} },
    localStorage: memoryStorage(), sessionStorage: memoryStorage(), navigator: { userAgent: 'test' },
    setInterval: () => 1, clearInterval() {},
    setTimeout: (handler, delay) => {
      const timer = { handler, delay, ran: delay < 10000 && !(options.holdSubmitTimers && delay === 2000) &&
        !(options.holdConfirmTimers && delay === 1000) };
      timers.push(timer);
      if (timer.ran) queueMicrotask(() => {
        if (options.blockDuringSubmit && delay === 2000) blocked = true;
        return handler();
      });
      return timers.length;
    }, clearTimeout() {},
    courseraQuizGuard: { isBlocked: () => blocked, block: () => { blocked = true; } },
    fetch: async (url, request) => {
      contentRequests.push(url);
      materialRequests.push({ url, options: request });
      if (options.materialFetch) return options.materialFetch(url, request);
      if (options.metadataResponses) {
        if (options.metadataRateLimit) return { ok: false, status: 429, headers: { get: () => '60' } };
        if (url.includes('onDemandLectureVideos.v1')) return { ok: true, status: 200, json: async () => ({ linked: {
          'onDemandVideos.v1': [{ id: 'video-id', sources: { byResolution: { '540p': { mp4VideoUrl: 'https://media.example.invalid/video.mp4' } } } }]
        } }) };
      }
      throw new Error('Unexpected content network request: ' + url);
    },
    chrome: {
      runtime: {
        id: 'test-extension', getURL: file => 'chrome-extension://test-extension/' + file,
        getManifest: () => ({ version: '3.6.10' }), lastError: undefined,
        onMessage: { addListener: handler => runtimeListeners.push(handler) },
        sendMessage: (message, callback) => {
          messages.push(message);
          if (message.action === 'COR_RPC_GET_UA') return callback?.({ ua: 'coursera-locking-browser/0.6.1' });
          if (message.action === 'DEEPSEEK_SOLVE') {
            return providerListeners[0](message, { id: 'test-extension', url: app.location.href }, result => {
              if (options.blockAfterSolve) blocked = true;
              callback(result);
            });
          }
          callback?.({});
        }
      },
      storage: {
        sync: {
          get: (keys, callback) => {
            const reply = () => callback(Object.fromEntries(keys.map(key => [key, flags[key]])));
            if (!options.holdStorageReply?.(keys, reply)) reply();
          },
          set: (_values, callback) => callback?.()
        },
        local: { get: () => { throw new Error('Content must never read private storage'); } }
      }
    }
  };
  app.window = app;
  vm.runInNewContext(contentSource, app, { timeout: 5000 });
  const messageWindow = vm.runInNewContext('window', app);

  async function flush() { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); }
  async function emit(type, event) {
    if (type === 'message') event = { source: messageWindow, origin: new URL(app.location.href).origin, ...event };
    for (const handler of windowEvents[type] || []) await handler(event);
    await flush();
  }
  return {
    providerCalls, messages, opened, nodes, inputs, submit, confirm, check, contentRequests, materialRequests, timers,
    navigate(item) { app.location.href = 'https://www.coursera.org/learn/test/assignment-submission/' + item + '/attempt'; },
    async flush() { await flush(); },
    async pageMessage(event) { await emit('message', event); },
    async outcome(passed, feedbackId = 'new-result') {
      await emit('message', { data: { url: 'https://www.coursera.org/api?opname=querystate',
        response: [{ data: { SubmissionState: { queryState: { attempts: {}, outcome: { isPassed: passed },
          feedback: { feedbackId, parts: [] } } } } }] } });
    },
    get reloads() { return reloads; },
    setBlocked(value) { blocked = value; },
    setFlags(values) { Object.assign(flags, values); },
    async runDelayedTimers() {
      for (const timer of timers.filter(timer => !timer.ran)) {
        timer.ran = true;
        await timer.handler();
        await flush();
      }
    },
    async captureFailedFeedback(parts = []) {
      await emit('message', { data: {
        url: 'https://www.coursera.org/api?opname=assignmentfeedback',
        response: [{ data: { SubmissionState: { queryState: {
          assignment: { passingFraction: 0.8 }, outcome: { isPassed: false },
          feedback: { feedbackId: 'feedback-1', parts }
        } } } }]
      } });
    },
    async ready() {
      assert.ok(runtimeListeners.length, 'Original content runtime listener must register');
      for (const handler of documentEvents.DOMContentLoaded || []) await handler();
      await emit('load');
    },
    async captureCourse(lectureCount = 0, materials = []) {
      await emit('message', { data: {
        url: 'https://www.coursera.org/api/ondemandcoursematerials.v2/?q=slug&includes=modules',
        response: { linked: {
          'onDemandGradingParameters.v1': [{ id: 'course-1' }],
          'onDemandCourseMaterialModules.v1': [{ id: 'module-1', name: 'Module 1' }],
          'onDemandCourseMaterialLessons.v1': [{ id: 'lesson-1', moduleId: 'module-1', name: 'Lesson 1' }],
          'onDemandCourseMaterialItems.v2': [{
            id: 'item-1', lessonId: 'lesson-1', name: 'Quiz', contentSummary: { typeName: 'ungradedAssignment', definition: {} }
          }, ...Array.from({ length: lectureCount }, (_, index) => ({
            id: 'lecture-' + index, lessonId: 'lesson-1', name: 'Lecture ' + index, timeCommitment: 120000,
            contentSummary: { typeName: 'lecture', definition: {} }
          })), ...materials.map((material, index) => ({
            id: 'material-' + index, lessonId: 'lesson-1', name: 'Material ' + index,
            contentSummary: { typeName: typeof material === 'string' ? material : material.type, definition: {} },
            ...(typeof material === 'object' ? material : {})
          }))]
        } }
      } });
    },
    async captureQuestions(questionHtml = 'Which number is even?', optionHtml = optionTexts) {
      await this.captureQuestionSet([{ question: questionHtml, options: optionHtml }]);
    },
    async captureQuestionSet(questions) {
      const parts = questions.map(question => ({ questionSchema: {
        __typename: question.type || 'MultipleChoiceQuestion', prompt: { htmlWithMetadata: { html: question.question } },
        options: question.options.map(text => ({ display: { htmlWithMetadata: { html: text } } }))
      } }));
      const queryState = { assignment: { passingFraction: 0.8 }, attempts: { inProgressAttempt: { draft: { parts } } } };
      await emit('message', { data: {
        url: 'https://www.coursera.org/api?opname=querystate', response: [{ data: { SubmissionState: { queryState } } }]
      } });
    },
    async clickAction(action) {
      for (const handler of runtimeListeners) await handler({ action }, {}, () => {});
      await flush();
    },
    async clickQuiz() { await this.clickAction('quiz'); },
    async useCachedAnswer(via) {
      if (via === 'Alt+Z') await emit('keydown', { key: 'z', altKey: true });
      else {
        const button = nodes.find(node => node.innerHTML?.includes('>Attempt</span>'));
        assert.ok(button, 'Original marker must inject the cached Attempt button');
        for (const handler of button.handlers.click || []) await handler();
        await flush();
      }
    }
  };
}

function gradedPart(question, options, chosen, score, checkbox = false) {
  return {
    questionSchema: { prompt: { cmlValue: question },
      options: options.map((text, index) => ({ optionId: 'option-' + index, display: { cmlValue: text } })) },
    feedback: { autoGradedFeedbackOutcome: { score, maxScore: 1 } },
    [checkbox ? 'checkboxResponse' : 'multipleChoiceResponse']: { chosen: checkbox ? chosen.map(index => 'option-' + index) : 'option-' + chosen[0] }
  };
}

function sentQuestions(extension) {
  const body = JSON.parse(extension.providerCalls.at(-1).options.body);
  return JSON.parse(body.messages[1].content[0].text.split('\n').slice(1).join('\n'));
}

test('prior feedback follows matching questions and reordered option texts rather than positions', async () => {
  const extension = loadExtension(); await extension.ready();
  await extension.captureFailedFeedback([
    gradedPart('Question A', ['A1', 'A2'], [0], 1), gradedPart('Question B', ['B1', 'B2'], [1], 0)
  ]);
  await extension.captureQuestionSet([{ question: 'Question B', options: ['B1', 'B2'] },
    { question: 'Question A', options: ['A2', 'A1'] }]);
  await extension.clickQuiz();
  const [b, a] = sentQuestions(extension);
  assert.equal(b.lastAttempt.question, 'Question B'); assert.deepEqual(b.lastAttempt.wrongOptions, ['B2']);
  assert.equal(a.lastAttempt.question, 'Question A'); assert.deepEqual(a.lastAttempt.correctOptions, ['A1']);
});

for (const ambiguity of ['current duplicate', 'feedback duplicate', 'changed options']) {
  test('uncertain prior feedback is discarded for ' + ambiguity, async () => {
    const extension = loadExtension(); await extension.ready();
    const parts = [gradedPart('Repeated question', ['A1', 'A2'], [0], 0)];
    if (ambiguity === 'feedback duplicate') parts.push(gradedPart('Repeated question', ['B1', 'B2'], [0], 0));
    await extension.captureFailedFeedback(parts);
    const questions = [{ question: 'Repeated question', options: ambiguity === 'changed options' ? ['A1', 'A3'] : ['A1', 'A2'] }];
    if (ambiguity === 'current duplicate') questions.push({ question: 'Repeated question', options: ['A1', 'A2'] });
    await extension.captureQuestionSet(questions); await extension.clickQuiz();
    assert.ok(sentQuestions(extension).every(question => !question.lastAttempt));
  });
}

test('partial checkbox grading records the failed combination without banning every chosen option', async () => {
  const extension = loadExtension(); await extension.ready();
  await extension.captureFailedFeedback([gradedPart('Choose the two correct values', ['A', 'B', 'C'], [0, 1], 0.5, true)]);
  await extension.captureQuestions('Choose the two correct values', ['A', 'B', 'C']); await extension.clickQuiz();
  const feedback = sentQuestions(extension)[0].lastAttempt;
  assert.deepEqual(feedback.wrongOptions, []);
  assert.match(feedback.summary, /combination/i); assert.match(feedback.summary, /0\.5.*1/);
  assert.ok(feedback.summary.includes(JSON.stringify(['A', 'B'])), 'the failed combination must retain its selected option texts');
});

test('original content script boots without author network requests or promotional pages', async () => {
  const extension = loadExtension();
  await extension.ready();
  assert.equal(extension.providerCalls.length, 0);
  assert.deepEqual(extension.contentRequests, []);
  assert.deepEqual(extension.opened, []);
  assert.deepEqual(extension.messages.map(message => message.action), ['COR_RPC_GET_UA']);
});

for (const flags of [{ autoQuiz: false, autoSubmitQuiz: false }, {}]) {
  test('captured questions wait for user action when automation is ' + (flags.autoQuiz === false ? 'disabled' : 'not configured'), async () => {
    const extension = loadExtension(flags);
    await extension.ready();
    await extension.captureQuestions();
    assert.equal(extension.providerCalls.length, 0);
    assert.equal(extension.inputs[1].clicks, 0);
    assert.equal(extension.submit.clicks, 0);
    assert.equal(extension.confirm.clicks, 0);
  });
}

test('manual Quiz bridges to DeepSeek, selects the answer, and keeps private data out of content', async () => {
  const extension = loadExtension({ autoQuiz: false, autoSubmitQuiz: false });
  await extension.ready();
  await extension.captureCourse();
  await extension.captureQuestions();
  await extension.clickQuiz();
  assert.equal(extension.providerCalls.length, 1);
  assert.equal(extension.providerCalls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(extension.providerCalls[0].options.headers.Authorization, 'Bearer ' + privateKey);
  assert.equal(extension.inputs[1].clicks, 1);
  assert.equal(extension.inputs[0].clicks, 0);
  assert.equal(extension.submit.clicks, 0);
  assert.equal(extension.confirm.clicks, 0);
  const request = extension.messages.find(message => message.action === 'DEEPSEEK_SOLVE');
  assert.deepEqual(Object.keys(request).sort(), ['action', 'images', 'prompt']);
  assert.doesNotMatch(JSON.stringify(extension.messages), /sk-private-test-key-never-content|private@example|Private User|12345/);
  assert.doesNotMatch(JSON.stringify(extension.nodes.map(node => ({ text: node.textContent, html: node.innerHTML, value: node.value }))), /sk-private-test-key-never-content/);
  assert.deepEqual(extension.opened, []);
});

test('manual Quiz works without course metadata or saved automation settings', async () => {
  const extension = loadExtension();
  await extension.ready();
  await extension.captureQuestions();
  await extension.clickQuiz();
  assert.equal(extension.providerCalls.length, 1);
  assert.equal(extension.inputs[1].clicks, 1);
  assert.equal(extension.submit.clicks, 0);
});

test('explicitly enabling autoQuiz starts solving captured questions', async () => {
  const extension = loadExtension({ autoQuiz: true, autoSubmitQuiz: false });
  await extension.ready();
  await extension.captureQuestions();
  assert.equal(extension.providerCalls.length, 1);
  assert.equal(extension.inputs[1].clicks, 1);
  assert.equal(extension.submit.clicks, 0);
});

test('explicitly enabling autoSubmitQuiz submits after a manual answer', async () => {
  const extension = loadExtension({ autoQuiz: false, autoSubmitQuiz: true });
  await extension.ready();
  await extension.captureCourse();
  await extension.captureQuestions();
  await extension.clickQuiz();
  assert.equal(extension.providerCalls.length, 1);
  assert.equal(extension.submit.clicks, 1);
  assert.equal(extension.confirm.clicks, 1);
});


test('autoQuiz answers the current quiz without starting the course pool', async () => {
  const extension = loadExtension({ autoQuiz: true, attemptAllQuiz: false, autoSubmitQuiz: false });
  await extension.ready();
  await extension.captureCourse();
  await extension.captureQuestions();
  await extension.clickQuiz();
  assert.equal(extension.providerCalls.length, 2);
  assert.equal(extension.messages.filter(message => message.action === 'START_QUIZ_POOL').length, 0);
});

test('only explicit attemptAllQuiz starts the course pool with one quiz at a time', async () => {
  const extension = loadExtension({ autoQuiz: false, attemptAllQuiz: true, autoSubmitQuiz: false });
  await extension.ready();
  await extension.captureCourse();
  await extension.captureQuestions();
  await extension.clickQuiz();
  const starts = extension.messages.filter(message => message.action === 'START_QUIZ_POOL');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].quizzes.length, 1);
  assert.equal(starts[0].concurrency, 1);
  assert.equal(extension.providerCalls.length, 0);
});

test('blocked Quiz does not request answers or start the pool', async () => {
  for (const attemptAllQuiz of [false, true]) {
    const extension = loadExtension({ autoQuiz: false, attemptAllQuiz, autoSubmitQuiz: true });
    await extension.ready();
    await extension.captureCourse();
    await extension.captureQuestions();
    extension.setBlocked(true);
    await extension.clickQuiz();
    assert.equal(extension.providerCalls.length, 0);
    assert.equal(extension.messages.filter(message => message.action === 'START_QUIZ_POOL').length, 0);
    assert.equal(extension.submit.clicks, 0);
  }
});

test('answers arriving after a Coursera limit do not select or submit', async () => {
  const extension = loadExtension({ autoQuiz: false, autoSubmitQuiz: true }, { blockAfterSolve: true });
  await extension.ready();
  await extension.captureQuestions();
  await extension.clickQuiz();
  assert.equal(extension.providerCalls.length, 1);
  assert.equal(extension.inputs[1].clicks, 0);
  assert.equal(extension.submit.clicks, 0);
});

test('submission stops when Coursera limit arrives during its delay', async () => {
  const extension = loadExtension({ autoQuiz: false, autoSubmitQuiz: true }, { blockDuringSubmit: true });
  await extension.ready();
  await extension.captureQuestions();
  await extension.clickQuiz();
  assert.equal(extension.providerCalls.length, 1);
  assert.equal(extension.submit.clicks, 0);
  assert.equal(extension.confirm.clicks, 0);
});

test('failed feedback does not retry when automatic quiz modes are disabled', async () => {
  const extension = loadExtension({ autoQuiz: false, attemptAllQuiz: false });
  await extension.ready();
  await extension.captureFailedFeedback();
  await extension.runDelayedTimers();
  assert.equal(extension.reloads, 0);
});

test('automatic feedback retry waits at least fifteen seconds', async () => {
  const extension = loadExtension({ autoQuiz: true });
  await extension.ready();
  await extension.captureFailedFeedback();
  assert.equal(extension.reloads, 0);
  assert.ok(extension.timers.some(timer => timer.delay >= 15000));
  await extension.runDelayedTimers();
  assert.equal(extension.reloads, 1);
});

for (const stop of ['disabled', 'blocked']) {
  test('scheduled retry stops when automation becomes ' + stop, async () => {
    const extension = loadExtension({ autoQuiz: true });
    await extension.ready();
    await extension.captureFailedFeedback();
    assert.equal(extension.reloads, 0);
    if (stop === 'disabled') extension.setFlags({ autoQuiz: false, attemptAllQuiz: false });
    else extension.setBlocked(true);
    await extension.runDelayedTimers();
    assert.equal(extension.reloads, 0);
  });
}


test('loading course metadata and answering Quiz does not prefetch every lecture', async () => {
  const extension = loadExtension({ autoQuiz: false, attemptAllQuiz: false, autoSubmitQuiz: false });
  await extension.ready();
  await extension.captureCourse(8);
  await extension.captureQuestions();
  await extension.clickQuiz();
  assert.equal(extension.providerCalls.length, 1);
  assert.deepEqual(extension.contentRequests, []);
});


for (const action of ['skipvideoplus']) {
  test(action + ' loads video metadata only after the explicit action', async () => {
    const extension = loadExtension({}, { metadataResponses: true });
    await extension.ready();
    await extension.captureCourse(1);
    assert.deepEqual(extension.contentRequests, []);
    await extension.clickAction(action);
    assert.ok(extension.contentRequests.some(url => url.includes('onDemandLectureVideos.v1')));
    if (action === 'skipvideoplus') {
      const request = extension.messages.find(message => message.action === 'SKIP_VIDEO_PLUS');
      assert.ok(request);
      assert.equal(request.payload.items[0].videoId, 'video-id');
      assert.equal(extension.contentRequests.some(url => url.includes('LectureAssets')), false);
    }
  });
}

test('metadata HTTP 429 blocks further lecture requests and the explicit action', async () => {
  const extension = loadExtension({}, { metadataResponses: true, metadataRateLimit: true });
  await extension.ready();
  await extension.captureCourse(3);
  await extension.clickAction('skipvideoplus');
  assert.equal(extension.contentRequests.length, 1);
  assert.equal(extension.messages.some(message => message.action === 'SKIP_VIDEO_PLUS'), false);
});

test('explicit video metadata loads one lecture at a time with a pause', async () => {
  const extension = loadExtension({}, { metadataResponses: true });
  await extension.ready();
  await extension.captureCourse(3);
  await extension.clickAction('skipvideoplus');
  assert.deepEqual(extension.contentRequests.map(url => url.includes('onDemandLectureVideos') ? 'video' : 'assets'),
    ['video', 'video', 'video']);
  assert.ok(extension.timers.filter(timer => timer.delay === 500).length >= 2);
});

test('blocked explicit video action does not continue even when the course has no lectures', async () => {
  const extension = loadExtension({}, { metadataResponses: true });
  await extension.ready();
  await extension.captureCourse();
  extension.setBlocked(true);
  await extension.clickAction('skipvideoplus');
  assert.deepEqual(extension.contentRequests, []);
  assert.equal(extension.messages.some(message => message.action === 'SKIP_VIDEO_PLUS'), false);
});


for (const via of ['Alt+Z', 'Attempt button']) {
  test('blocked cached answers cannot click Check through ' + via, async () => {
    const extension = loadExtension({ autoQuiz: false, autoSubmitQuiz: false }, { singleQuestion: true });
    await extension.ready();
    await extension.captureQuestions();
    await extension.clickQuiz();
    assert.equal(extension.inputs[1].clicks, 1);
    assert.equal(extension.check.clicks, 1);
    extension.inputs[1].checked = false;
    extension.setBlocked(true);
    await extension.useCachedAnswer(via);
    assert.equal(extension.providerCalls.length, 1);
    assert.equal(extension.inputs[1].clicks, 1);
    assert.equal(extension.check.clicks, 1);
    assert.equal(extension.submit.clicks, 0);
  });
}

test('repeated answers cannot overlap a pending automatic submission', async () => {
  const extension = loadExtension({ autoQuiz: false, autoSubmitQuiz: true }, { holdSubmitTimers: true });
  await extension.ready();
  await extension.captureQuestions();
  await extension.clickQuiz();
  await extension.clickQuiz();
  assert.equal(extension.providerCalls.length, 2);
  assert.equal(extension.timers.filter(timer => timer.delay === 2000).length, 1);
  await extension.runDelayedTimers();
  assert.equal(extension.submit.clicks, 1);
  assert.equal(extension.confirm.clicks, 1);
});

for (const changed of ['url', 'questions']) {
  test('a delayed answer is discarded after ' + changed + ' changes', async () => {
    let resolve;
    const providerWait = new Promise(done => { resolve = done; });
    const extension = loadExtension({ autoSubmitQuiz: true }, { providerWait });
    await extension.ready(); await extension.captureQuestions(); await extension.clickQuiz();
    if (changed === 'url') extension.navigate('item-2');
    else await extension.captureQuestions('A different question');
    resolve(); await extension.flush();
    assert.deepEqual(extension.inputs.map(input => input.clicks), [0, 0]);
    assert.equal(extension.submit.clicks, 0);
  });
}

test('answer selection removes wrong draft checkboxes and preserves already correct choices', async () => {
  const extension = loadExtension();
  await extension.ready(); await extension.captureQuestions();
  extension.inputs[0].checked = true; extension.inputs[1].checked = true;
  await extension.clickQuiz();
  assert.deepEqual(extension.inputs.map(input => input.checked), [false, true]);
  assert.deepEqual(extension.inputs.map(input => input.clicks), [1, 0]);
});

for (const place of ['question', 'option']) {
  test('visual ' + place + ' is rejected before contacting DeepSeek', async () => {
    const extension = loadExtension(); await extension.ready();
    await extension.captureQuestions(place === 'question' ? 'Diagram <img src="https://example.invalid/a.png">' : 'Choose',
      place === 'option' ? ['<svg><image href="https://example.invalid/a.png" /></svg>', 'Four'] : optionTexts);
    await extension.clickQuiz();
    assert.equal(extension.providerCalls.length, 0);
    assert.ok(extension.nodes.some(node => /изображ|визуаль/i.test(node.textContent)));
  });
}

test('removed Backup action cannot start requests or downloads', async () => {
  const extension = loadExtension({}, { metadataResponses: true });
  await extension.ready(); await extension.captureCourse(1); await extension.clickAction('coursebackup');
  assert.deepEqual(extension.contentRequests, []);
  assert.equal(extension.messages.some(message => message.action === 'backupProgress'), false);
});

test('confirmation disappearing without grading times out and releases submission lock', async () => {
  const extension = loadExtension({ autoSubmitQuiz: true }, { confirmDisappears: true });
  await extension.ready(); await extension.captureQuestions(); await extension.clickQuiz();
  assert.equal(extension.confirm.clicks, 1);
  assert.ok(extension.nodes.some(node => /не подтвержден|не удалось подтвердить/i.test(node.textContent)));
  assert.equal(extension.nodes.some(node => node.textContent === 'Quiz auto-submitted!'), false);
  await extension.clickQuiz(); assert.equal(extension.submit.clicks, 2);
});

test('navigation during the submit delay cancels clicks and releases the lock', async () => {
  const extension = loadExtension({ autoSubmitQuiz: true }, { holdSubmitTimers: true });
  await extension.ready(); await extension.captureQuestions(); await extension.clickQuiz();
  extension.navigate('item-2'); await extension.runDelayedTimers();
  assert.equal(extension.submit.clicks, 0);
  await extension.captureQuestions('New attempt'); await extension.clickQuiz(); await extension.runDelayedTimers();
  assert.equal(extension.submit.clicks, 1);
});

test('submission waits for a fresh server grading result after its one confirmation', async () => {
  let extension;
  extension = loadExtension({ autoSubmitQuiz: true }, { onConfirm: () => {
    queueMicrotask(() => extension.outcome(true));
  } });
  await extension.ready(); await extension.captureQuestions(); await extension.clickQuiz();
  assert.equal(extension.confirm.clicks, 1);
  assert.ok(extension.nodes.some(node => /Coursera подтвердила/.test(node.textContent)));
  assert.equal(extension.nodes.some(node => /не подтверждена за/.test(node.textContent)), false);
});

test('repeated old grading feedback does not falsely confirm a new submission', async () => {
  let extension;
  extension = loadExtension({ autoSubmitQuiz: true }, { onConfirm: () => {
    queueMicrotask(() => extension.outcome(false, 'previous-feedback'));
  } });
  await extension.ready(); await extension.outcome(false, 'previous-feedback');
  await extension.captureQuestions(); await extension.clickQuiz();
  assert.equal(extension.confirm.clicks, 1);
  assert.equal(extension.nodes.some(node => /Coursera подтвердила/.test(node.textContent)), false);
  assert.ok(extension.nodes.some(node => /не подтверждена за/.test(node.textContent)));
});

test('navigation while the submit setting is being read cannot submit the next Quiz', async () => {
  let reads = 0, reply;
  const extension = loadExtension({ autoSubmitQuiz: true }, { holdStorageReply: (keys, done) => {
    if (keys.includes('autoSubmitQuiz') && ++reads === 2) { reply = done; return true; }
  } });
  await extension.ready(); await extension.captureQuestions(); await extension.clickQuiz();
  assert.equal(typeof reply, 'function'); extension.navigate('item-2'); reply(); await extension.flush();
  assert.equal(extension.submit.clicks, 0);
});

test('a failed-feedback retry cannot reload a different Quiz after navigation', async () => {
  const extension = loadExtension({ autoQuiz: true }); await extension.ready();
  await extension.captureQuestions(); await extension.captureFailedFeedback();
  extension.navigate('item-2'); await extension.runDelayedTimers();
  assert.equal(extension.reloads, 0);
});

test('disabling automatic submission before confirmation cancels its final click', async () => {
  const extension = loadExtension({ autoSubmitQuiz: true }, { holdConfirmTimers: true });
  await extension.ready(); await extension.captureQuestions(); await extension.clickQuiz();
  assert.equal(extension.submit.clicks, 1); assert.equal(extension.confirm.clicks, 0);
  extension.setFlags({ autoSubmitQuiz: false }); await extension.runDelayedTimers();
  assert.equal(extension.confirm.clicks, 0);
});

for (const event of [{ source: {} }, { origin: 'https://other.example.invalid' }, { data: null }]) {
  test('foreign or malformed page messages cannot change captured Quiz state ' + JSON.stringify(event), async () => {
    const extension = loadExtension({ autoQuiz: true }); await extension.ready();
    await extension.pageMessage({ data: {
      url: 'https://www.coursera.org/api?opname=querystate',
      response: [{ data: { SubmissionState: { queryState: { attempts: { inProgressAttempt: { draft: { parts: [{
        questionSchema: { __typename: 'MultipleChoiceQuestion', prompt: { htmlWithMetadata: { html: 'Forged' } },
          options: optionTexts.map(text => ({ display: { htmlWithMetadata: { html: text } } })) }
      }] } } } } } } }]
    }, ...event });
    assert.equal(extension.providerCalls.length, 0);
  });
}

const materialResponse = (status, body = {}) => ({ ok: status >= 200 && status < 300, status,
  headers: { get: () => '60' }, json: async () => body });
const materialText = extension => extension.nodes.map(node => node.textContent).join('\n');

for (const action of ['reading', 'lecture', 'ungradedplugin']) {
  test(action + ' never reports completion after a rejected material request', async () => {
    const extension = loadExtension({}, { materialFetch: async () => materialResponse(403) });
    await extension.ready(); await extension.captureCourse(action === 'lecture' ? 2 : 0,
      action === 'reading' ? ['supplement', 'supplement'] : action === 'ungradedplugin' ? ['ungradedWidget'] : []);
    await extension.clickAction(action);
    assert.ok(extension.contentRequests.length);
    assert.match(materialText(extension), /403/);
    assert.doesNotMatch(materialText(extension), /Reading Material completed|Finished all dialogues|Videos? completed|Завершено: [1-9]/i);
  });

  test(action + ' stops all remaining material requests after HTTP 429', async () => {
    const extension = loadExtension({}, { materialFetch: async () => materialResponse(429) });
    await extension.ready(); await extension.captureCourse(action === 'lecture' ? 3 : 0,
      action === 'reading' ? ['supplement', 'supplement'] : action === 'ungradedplugin' ? ['ungradedWidget', 'ungradedWidget'] : []);
    await extension.clickAction(action);
    assert.equal(extension.contentRequests.length, 1);
    await extension.clickAction(action);
    assert.equal(extension.contentRequests.length, 1);
    assert.match(materialText(extension), /огранич/);
  });

  test(action + ' explains an empty material list without claiming completion', async () => {
    const extension = loadExtension(); await extension.ready(); await extension.captureCourse();
    await extension.clickAction(action);
    assert.deepEqual(extension.contentRequests, []);
    assert.match(materialText(extension), /нет|не найдены/i);
    assert.doesNotMatch(materialText(extension), /Reading Material completed|Finished all dialogues/);
  });
}

test('Reading completes selected course supplements serially with authenticated writes', async () => {
  let active = 0, maximum = 0;
  const extension = loadExtension({}, { materialFetch: async () => {
    active++; maximum = Math.max(maximum, active); await new Promise(resolve => setImmediate(resolve)); active--;
    return materialResponse(201);
  } });
  await extension.ready(); await extension.captureCourse(0, ['supplement', 'supplement']);
  await extension.clickAction('reading');
  assert.equal(maximum, 1); assert.equal(extension.materialRequests.length, 2);
  for (const request of extension.materialRequests) {
    assert.equal(request.url, 'https://www.coursera.org/api/onDemandSupplementCompletions.v1');
    assert.equal(request.options.credentials, 'include'); assert.equal(request.options.method, 'POST');
    const body = JSON.parse(request.options.body); assert.equal(body.courseId, 'course-1'); assert.equal(body.userId, 12345);
  }
  assert.match(materialText(extension), /Завершено: 2 из 2/);
});

test('Ungraded Plugin requires a valid widget session before marking completion', async () => {
  const extension = loadExtension({}, { materialFetch: async () => materialResponse(200, { elements: [] }) });
  await extension.ready(); await extension.captureCourse(0, ['ungradedWidget']);
  await extension.clickAction('ungradedplugin');
  assert.equal(extension.materialRequests.length, 1);
  assert.match(materialText(extension), /сесси/i);
  assert.doesNotMatch(materialText(extension), /Finished all dialogues|Завершено: 1/);
});

test('Ungraded Plugin writes widget progress with the returned session and skips coach mutations', async () => {
  const extension = loadExtension({}, { materialFetch: async url => materialResponse(200,
    url.includes('Sessions.v1') ? { elements: [{ sessionId: 'widget-session' }] } : { progressState: 'Completed' }) });
  await extension.ready(); await extension.captureCourse(0, ['ungradedWidget']);
  await extension.clickAction('ungradedplugin');
  assert.equal(extension.materialRequests.length, 2);
  const [session, progress] = extension.materialRequests;
  assert.equal(session.options.credentials, 'include');
  assert.equal(progress.options.method, 'PUT'); assert.equal(progress.options.credentials, 'include');
  assert.deepEqual(JSON.parse(progress.options.body), { sessionId: 'widget-session', progressState: 'Completed' });
  assert.match(materialText(extension), /Завершено: 1 из 1/);
});

for (const result of [{ errors: [{ message: 'GraphQL failure' }] }, { data: { CoachItem_EndSession: { itemCompletionHandled: false } } }]) {
  test('Dialogue does not claim completion for an unconfirmed coach result ' + JSON.stringify(result), async () => {
    const extension = loadExtension({}, { materialFetch: async url => materialResponse(200,
      url.includes('CreateChatSession') ? [{ data: { AiCoach_CreateChatSession: { id: 'coach-session' } } }] : [result]) });
    await extension.ready(); await extension.captureCourse(0, ['coach']); await extension.clickAction('dialogue');
    assert.equal(extension.materialRequests.length, 2);
    assert.doesNotMatch(materialText(extension), /Finished all dialogues|Завершено: 1/);
    assert.match(materialText(extension), /GraphQL|подтверд/i);
  });
}
