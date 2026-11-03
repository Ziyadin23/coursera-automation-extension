const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadWorker } = require('./background-harness.cjs');
const items = [1, 2, 3].map(index => ({ item_id: 'lecture-' + index, item_name: 'Video ' + index,
  open_course_slug: 'course', course_id: 'course-id', videoId: 'video-' + index, timeCommitment: 120 }));
const response = (status, body = {}) => ({ ok: status >= 200 && status < 300, status,
  json: async () => body, headers: { get: () => '120' } });
const skip = worker => worker.message({ action: 'SKIP_VIDEO_PLUS', payload: { _0x347e4cd8be: 'dummy-user', items } });

test('Skip Video+ processes one network mutation at a time and counts verified completions', async () => {
  let active = 0, maximum = 0;
  const worker = loadWorker({ fetch: async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return response(200, { itemProgress: { progressState: 'Completed' } });
  } });
  const pending = skip(worker);
  await worker.advance(30000);
  const result = await pending;
  assert.equal(maximum, 1);
  assert.equal(result.success, true);
  assert.equal(result.completed, 3);
  assert.equal(result.failed, 0);
});

test('the first Skip Video+ 429 stops all later progress writes and lectures', async () => {
  const worker = loadWorker({ fetch: async () => response(429, { message: 'too-many-requests' }) });
  const pending = skip(worker);
  await worker.advance(30000);
  const result = await pending;
  assert.equal(worker.calls.fetch.length, 1);
  assert.equal(result.success, false);
  assert.equal(result.stopped, true);
  assert.equal(result.completed, 0);
  assert.ok(worker.calls.messages.some(({ message }) => message.action === 'STOP_QUIZ_AUTOMATION'));
  assert.ok(!worker.calls.messages.some(({ message }) => message.action === 'SHOW_TOAST' && message.payload.type === 'success'));
});

test('failed video requests never produce an all-success response', async () => {
  const worker = loadWorker({ fetch: async () => response(403) });
  const pending = skip(worker);
  await worker.advance(30000);
  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.completed, 0);
  assert.equal(result.failed, 3);
  assert.ok(!worker.calls.messages.some(({ message }) => message.action === 'SHOW_TOAST' && message.payload.type === 'success'));
});

test('mixed video outcomes report exactly the verified completion and failure counts', async () => {
  const worker = loadWorker({ fetch: async url => url.includes('lecture-2') ? response(403) :
    response(200, { itemProgress: { progressState: 'Completed' } }) });
  const pending = skip(worker);
  await worker.advance(30000);
  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.completed, 2);
  assert.equal(result.failed, 1);
});

test('invalid video durations fail before mutation while a valid later video still completes', async () => {
  const invalidDurations = [undefined, null, NaN, Infinity, -Infinity, 0, -1, '120'];
  const videos = invalidDurations.map((timeCommitment, index) => ({ ...items[0], item_id: 'invalid-' + index, timeCommitment }));
  videos.push(items[1]);
  const worker = loadWorker({ fetch: async () => response(200, { itemProgress: { progressState: 'Completed' } }) });
  const pending = worker.message({ action: 'SKIP_VIDEO_PLUS', payload: { _0x347e4cd8be: 'dummy-user', items: videos } });
  await worker.advance(30000);
  const result = await pending;
  assert.equal(worker.calls.fetch.length, 3);
  assert.equal(result.success, false);
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 8);
  assert.equal(result.skipped, 0);
  assert.ok(result.results.slice(0, 8).every(item => item.status === 'failed' && item.error));
  assert.equal(result.results.at(-1).status, 'completed');
});

test('video mutations include Coursera session credentials at every endpoint', async () => {
  const worker = loadWorker({ fetch: async () => response(200, { itemProgress: { progressState: 'Completed' } }) });
  const pending = skip(worker);
  await worker.advance(30000);
  await pending;
  assert.equal(worker.calls.fetch.length, 9);
  for (const request of worker.calls.fetch) assert.equal(request.options.credentials, 'include');
});

test('a rate limit from another Coursera tab cancels an in-flight Skip Video+ run', async () => {
  let release;
  const worker = loadWorker({ fetch: () => new Promise(resolve => { release = resolve; }) });
  const pending = skip(worker);
  await worker.flush();
  await worker.message({ action: 'QUIZ_RATE_LIMITED' }, 999);
  release(response(200));
  await worker.advance(30000);
  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.stopped, true);
  assert.equal(worker.calls.fetch.length, 1);
});

test('temporary ended-state HTTP400 retries serially before declaring completion', async () => {
  let ended = 0;
  const worker = loadWorker({ fetch: async url => {
    if (url.includes('/ended?') && ++ended === 1) return response(400);
    return response(200, { itemProgress: { progressState: 'Completed' } });
  } });
  const pending = skip(worker);
  await worker.advance(30000);
  const result = await pending;
  assert.equal(result.success, true);
  assert.equal(result.completed, 3);
  assert.equal(ended, 4);
});
