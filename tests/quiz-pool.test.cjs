const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../dist/scripts/background.js'), 'utf8');
const courseTabId = 10;
const minimumInterval = 15000;

const { loadWorker } = require('./background-harness.cjs');

test('original obfuscated background boots with DeepSeek import and no network calls', async () => {
  const worker = loadWorker();
  await worker.flush();
  assert.ok(worker.calls.imports.includes('deepseek.js'));
  assert.deepEqual(worker.calls.created, []);
  assert.deepEqual(worker.calls.fetch, []);
  assert.equal(await worker.status(), false);
});

test('many quizzes open only one managed tab even when caller asks for three', async () => {
  const worker = loadWorker();
  await worker.start();
  assert.equal(worker.calls.created.length, 1, 'parallel quiz page loads must not flood Coursera');
  assert.equal(worker.calls.created[0].active, false);
  assert.equal(await worker.status(), true);
  await worker.advance(minimumInterval * 2);
  assert.equal(worker.calls.created.length, 1, 'next quiz must wait for current tab completion');
});

test('completed quizzes wait at least 15 seconds between page creations', async () => {
  const worker = loadWorker();
  await worker.start();
  await worker.advance(1000);
  await worker.close(worker.calls.created[0].id);
  assert.equal(worker.calls.created.length, 1, 'completion must not immediately open the next quiz');
  await worker.advance(minimumInterval - 1001);
  assert.equal(worker.calls.created.length, 1);
  await worker.advance(1);
  assert.equal(worker.calls.created.length, 2);
  assert.equal(worker.calls.created[1].at - worker.calls.created[0].at, minimumInterval);
});

test('duplicate starts cannot abandon active tabs or open another pool', async () => {
  const worker = loadWorker();
  await worker.start();
  await worker.start();
  assert.equal(worker.calls.created.length, 1);
  await worker.close(worker.calls.created[0].id);
  await worker.advance(minimumInterval);
  assert.equal(worker.calls.created.length, 2);
  assert.match(worker.calls.created[1].url, /quiz-2/);
});

test('stop cancels an already scheduled next quiz', async () => {
  const worker = loadWorker();
  await worker.start();
  await worker.close(worker.calls.created[0].id);
  await worker.stop();
  await worker.advance(minimumInterval * 3);
  assert.equal(worker.calls.created.length, 1);
  assert.equal(await worker.status(), false);
});

test('stop during tab creation cleans up its late tab without continuing', async () => {
  const worker = loadWorker({ deferCreate: true });
  await worker.start();
  await worker.stop();
  worker.releaseCreate();
  await worker.flush();
  await worker.advance(minimumInterval * 3);
  assert.equal(worker.calls.created.length, 1);
  assert.deepEqual(worker.calls.removed, [worker.calls.created[0].id]);
  assert.equal(await worker.status(), false);
});

test('Coursera rate limit cancels queued work and explains the stop in original course tab', async () => {
  const worker = loadWorker();
  await worker.start();
  await worker.close(worker.calls.created[0].id);
  await worker.message({ action: 'QUIZ_RATE_LIMITED', payload: { retryAfterSeconds: 120 } });
  await worker.advance(minimumInterval * 3);
  assert.equal(worker.calls.created.length, 1);
  assert.equal(await worker.status(), false);
  const notice = worker.calls.messages.find(({ id, message }) => id === courseTabId && message.action === 'SHOW_TOAST' && message.payload.type === 'error');
  assert.ok(notice, 'course tab should explain why the quiz queue stopped');
  assert.match(notice.message.payload.message, /Coursera/);
  assert.match(notice.message.payload.message, /позже|запрос|огранич/i);
  assert.deepEqual(worker.calls.reloaded, [], 'rate limit must not trigger automatic page reloads');
});

test('rate limit from active quiz stops automation without closing the course or retrying', async () => {
  const worker = loadWorker();
  await worker.start();
  const quizId = worker.calls.created[0].id;
  await worker.message({ action: 'QUIZ_RATE_LIMITED' }, quizId);
  assert.equal(await worker.status(), false);
  assert.ok(worker.calls.messages.some(({ id, message }) => id === quizId && message.action === 'STOP_QUIZ_AUTOMATION'));
  assert.ok(!worker.calls.removed.includes(courseTabId));
  await worker.close(quizId);
  await worker.advance(minimumInterval * 3);
  assert.equal(worker.calls.created.length, 1);
});

test('rate limit from another Coursera tab stops the shared session queue', async () => {
  const worker = loadWorker();
  await worker.start();
  await worker.message({ action: 'QUIZ_RATE_LIMITED' }, 999);
  await worker.advance(minimumInterval * 3);
  assert.equal(await worker.status(), false);
  assert.equal(worker.calls.created.length, 1);
});

test('a fresh manual start still respects the previous quiz opening time', async () => {
  const worker = loadWorker();
  await worker.start();
  await worker.stop();
  await worker.start();
  assert.equal(worker.calls.created.length, 1);
  await worker.advance(minimumInterval);
  assert.equal(worker.calls.created.length, 2);
  assert.equal(worker.calls.created[1].at - worker.calls.created[0].at, minimumInterval);
});

test('rate limit cancels the final automatic course reload', async () => {
  const worker = loadWorker();
  await worker.message({ action: 'START_QUIZ_POOL', openCourseSlug: 'course', quizzes: [{ itemId: 'only-quiz', slug: 'quiz' }] });
  await worker.close(worker.calls.created[0].id);
  assert.equal(await worker.status(), false);
  await worker.message({ action: 'QUIZ_RATE_LIMITED' });
  await worker.advance(5000);
  assert.deepEqual(worker.calls.reloaded, []);
});

test('rate-limit messages from outside Coursera cannot cancel the quiz queue', async () => {
  const worker = loadWorker();
  await worker.start();
  const response = await worker.message({ action: 'QUIZ_RATE_LIMITED' }, 999, 'https://example.invalid/');
  assert.equal(response.success, false);
  assert.equal(await worker.status(), true);
  assert.equal(worker.calls.messages.filter(({ message }) => message.action === 'STOP_QUIZ_AUTOMATION').length, 0);
});

test('rate limit during creation preserves the blocked quiz tab and stops its automation after creation resolves', async () => {
  const worker = loadWorker({ deferCreate: true });
  await worker.start();
  const quizId = worker.calls.created[0].id;
  await worker.message({ action: 'QUIZ_RATE_LIMITED', payload: { retryAfterSeconds: 120 } }, quizId);
  worker.releaseCreate();
  await worker.flush();
  await worker.advance(minimumInterval * 3);
  assert.deepEqual(worker.calls.removed, [], 'the tab carrying the server block must remain visible');
  assert.equal(worker.calls.created.length, 1);
  assert.equal(await worker.status(), false);
  assert.ok(worker.calls.messages.some(({ id, message }) => id === quizId &&
    message.action === 'STOP_QUIZ_AUTOMATION' && message.payload.reason === 'rate_limited' && message.payload.retryAfterSeconds === 120));
});

test('rate-limit stop broadcasts only validated numeric Retry-After guidance', async () => {
  for (const [retryAfterSeconds, expected] of [[120, 120], [0, 0], ['120', undefined], [-1, undefined], [Infinity, undefined], [NaN, undefined]]) {
    const worker = loadWorker();
    await worker.start();
    const quizId = worker.calls.created[0].id;
    await worker.message({ action: 'QUIZ_RATE_LIMITED', payload: { retryAfterSeconds } }, quizId);
    for (const tabId of [courseTabId, quizId]) {
      const stop = worker.calls.messages.find(({ id, message }) => id === tabId && message.action === 'STOP_QUIZ_AUTOMATION');
      assert.ok(stop);
      assert.equal(stop.message.payload.retryAfterSeconds, expected);
    }
  }
});


test('worker restart retains active quiz ownership and remaining course queue', async () => {
  const first = loadWorker();
  await first.start();
  const quiz = first.calls.created[0];
  const second = loadWorker({ browser: first.browser });
  assert.equal(await second.status(), true);
  assert.equal(second.calls.created.length, 1, 'restoration must adopt the existing tab');
  await second.close(quiz.id);
  await second.advance(15000);
  assert.equal(second.calls.created.length, 2);
  assert.match(second.calls.created[1].url, /quiz-2/);
});

test('pending opening survives a restart without losing the fifteen second interval', async () => {
  const first = loadWorker();
  await first.start();
  await first.advance(1000);
  await first.close(first.calls.created[0].id);
  const second = loadWorker({ browser: first.browser });
  await second.advance(13999);
  assert.equal(second.calls.created.length, 1);
  await second.advance(1);
  assert.equal(second.calls.created.length, 2);
  assert.equal(second.calls.created[1].at - second.calls.created[0].at, 15000);
});

test('restart between tab creation and completion adopts that tab without duplication', async () => {
  const first = loadWorker({ deferCreate: true });
  await first.start();
  const second = loadWorker({ browser: first.browser });
  assert.equal(await second.status(), true);
  await second.advance(30000);
  assert.equal(second.calls.created.length, 1);
  await second.close(second.calls.created[0].id);
  assert.equal(second.calls.created.length, 2);
});

test('a stopped pending creation remains stopped across a worker restart', async () => {
  const first = loadWorker({ deferCreate: true });
  await first.start();
  await first.stop();
  const second = loadWorker({ browser: first.browser });
  await second.advance(30000);
  assert.equal(await second.status(), false);
  assert.equal(second.calls.created.length, 1);
  assert.ok(second.calls.removed.includes(second.calls.created[0].id));
});

test('restoration reconciles closed managed tabs and missing durable wakeups', async () => {
  const first = loadWorker();
  await first.start();
  first.browser.tabs.delete(first.calls.created[0].id);
  first.browser.alarms.clear();
  const second = loadWorker({ browser: first.browser });
  await second.advance(15000);
  assert.equal(second.calls.created.length, 2);
  assert.match(second.calls.created[1].url, /quiz-2/);
});

test('quiz creation is preceded by a durable pending reservation', async () => {
  const worker = loadWorker();
  await worker.start();
  assert.ok(worker.calls.created[0].persistedPending, 'a crash after create must leave recoverable ownership');
});

test('unrelated submission-complete URLs never close user tabs', async () => {
  const worker = loadWorker();
  await worker.update(77, 'https://example.invalid/submission-complete');
  await worker.update(78, 'https://www.coursera.org/anything/submission-start');
  assert.deepEqual(worker.calls.removed, []);
});

test('a slow timing sample never closes all browser tabs', async () => {
  const worker = loadWorker({ slowPerformance: true });
  worker.browser.tabs.set(77, { id: 77, url: 'https://example.invalid/' });
  await worker.tickIntervals();
  assert.deepEqual(worker.calls.removed, []);
});

test('stopping never closes a tracked quiz tab after the user navigates it elsewhere', async () => {
  const worker = loadWorker();
  await worker.start();
  const id = worker.calls.created[0].id;
  worker.browser.tabs.set(id, { id, url: 'https://example.invalid/work' });
  await worker.stop();
  assert.ok(!worker.calls.removed.includes(id));
});

test('a durable alarm advances the queue when its in-memory timer is lost', async () => {
  const worker = loadWorker();
  await worker.start();
  await worker.close(worker.calls.created[0].id);
  worker.discardTimers();
  await worker.advance(15000);
  assert.equal(worker.calls.created.length, 2);
  assert.match(worker.calls.created[1].url, /quiz-2/);
});

test('stopping preserves a quiz tab whose pending navigation leaves Coursera', async () => {
  const worker = loadWorker();
  await worker.start();
  const tab = worker.calls.created[0];
  worker.browser.tabs.set(tab.id, { ...tab, pendingUrl: 'https://example.invalid/work' });
  await worker.stop();
  assert.ok(!worker.calls.removed.includes(tab.id));
});

test('restoration does not adopt a pending-created tab navigating somewhere else', async () => {
  const first = loadWorker({ deferCreate: true });
  await first.start();
  const tab = first.calls.created[0];
  first.browser.tabs.set(tab.id, { ...tab, pendingUrl: 'https://example.invalid/work' });
  const second = loadWorker({ browser: first.browser });
  await second.advance(15000);
  assert.equal(second.calls.created.length, 2, 'the abandoned quiz must be retried in a new tab');
  assert.ok(!second.calls.removed.includes(tab.id));
});
