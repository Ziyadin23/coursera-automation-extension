(() => {
  'use strict';

  const storageKey = 'courseraQuizPoolV1';
  const alarmName = 'coursera-quiz-pool';
  const minimumInterval = 15000;
  const actions = new Set(['START_QUIZ_POOL', 'STOP_QUIZ_POOL', 'GET_QUIZ_POOL_STATUS', 'QUIZ_RATE_LIMITED', 'CLOSE_TAB', 'SKIP_VIDEO_PLUS']);
  let state = {
    version: 1, active: false, queue: [], managed: [], pending: null, closing: [],
    sourceTab: null, sourceUrl: null, nextOpenAt: 0, reloadAt: null, stop: null
  };
  let timer = null;
  let chain = Promise.resolve();
  let videoRun = null;
  let videoEpoch = 0;

  const persist = () => chrome.storage.session.set({ [storageKey]: state });
  const send = (tabId, message) => {
    if (tabId != null) return chrome.tabs.sendMessage(tabId, message).catch(() => {});
  };
  const toast = (tabId, message, type = 'info', keep = false) => send(tabId, {
    action: 'SHOW_TOAST', payload: { message, type, keep }
  });
  const isCoursera = value => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && (url.hostname === 'coursera.org' || url.hostname.endsWith('.coursera.org'));
    } catch { return false; }
  };
  const ownsQuiz = (tab, quiz) => {
    if (!tab || !isCoursera(tab.pendingUrl || tab.url)) return false;
    const url = new URL(tab.pendingUrl || tab.url);
    return url.pathname.startsWith('/learn/' + quiz.openCourseSlug + '/assignment-submission/' + quiz.itemId + '/');
  };

  function schedule(at) {
    clearTimeout(timer);
    timer = null;
    if (at == null) {
      chrome.alarms.clear(alarmName).catch(() => {});
      return;
    }
    // The timer gives prompt foreground progress; the alarm survives MV3 suspension.
    chrome.alarms.create(alarmName, { when: Math.max(Date.now() + 1, at) });
    timer = setTimeout(() => { timer = null; enqueue(pump).catch(() => {}); }, Math.max(0, at - Date.now()));
  }

  async function removeClosingTabs() {
    for (const quiz of state.closing) {
      const tab = await chrome.tabs.get(quiz.tabId).catch(() => null);
      if (ownsQuiz(tab, quiz)) await chrome.tabs.remove(quiz.tabId).catch(() => {});
    }
    if (state.closing.length) {
      state.closing = [];
      await persist();
    }
  }

  const ready = (async () => {
    const saved = (await chrome.storage.session.get(storageKey))[storageKey];
    if (saved?.version === 1) state = { ...state, ...saved };
    const tabs = await chrome.tabs.query({});
    state.managed = state.managed.filter(quiz => ownsQuiz(tabs.find(tab => tab.id === quiz.tabId), quiz));
    if (state.pending) {
      const pending = state.pending;
      const tab = tabs.find(tab => (tab.pendingUrl || tab.url) === pending.url);
      state.pending = null;
      if (tab) {
        if (state.active && !pending.cancelled) state.managed.push({ ...pending.quiz, tabId: tab.id });
        else if (state.stop?.reason === 'rate_limited') send(tab.id, { action: 'STOP_QUIZ_AUTOMATION', payload: state.stop });
        else state.closing.push({ ...pending.quiz, tabId: tab.id });
      } else if (state.active && !pending.cancelled) state.queue.unshift(pending.quiz);
    }
    await persist();
    await removeClosingTabs();
  })();

  function enqueue(operation) {
    const result = chain.then(() => ready).then(operation);
    chain = result.catch(() => {});
    return result;
  }

  async function stopPool(reason, closeTabs = false, retryAfterSeconds) {
    videoEpoch++;
    state.stop = { reason };
    if (typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
      state.stop.retryAfterSeconds = retryAfterSeconds;
    }
    state.active = false;
    state.queue = [];
    state.reloadAt = null;
    if (state.pending) state.pending.cancelled = true;
    const managed = state.managed;
    const ids = managed.map(quiz => quiz.tabId);
    state.managed = [];
    if (closeTabs) state.closing.push(...managed);
    await persist();
    schedule(null);
    for (const id of new Set([state.sourceTab, ...ids, videoRun?.tabId])) {
      send(id, { action: 'STOP_QUIZ_AUTOMATION', payload: state.stop });
    }
    await removeClosingTabs();
  }

  async function rateLimited(tabId, retryAfterSeconds) {
    await stopPool('rate_limited', false, retryAfterSeconds);
    send(tabId, { action: 'STOP_QUIZ_AUTOMATION', payload: state.stop });
    for (const id of new Set([state.sourceTab, tabId])) {
      toast(id, 'Coursera временно ограничила запросы. Автоматизация остановлена. Попробуйте позже; автоматических повторов не будет.', 'error', true);
    }
  }

  async function created(pending, tab) {
    if (state.pending?.url !== pending.url) return;
    state.pending = null;
    if (state.active && !pending.cancelled && !state.stop) {
      const current = await chrome.tabs.get(tab.id).catch(() => null);
      if (ownsQuiz(current, pending.quiz)) state.managed.push({ ...pending.quiz, tabId: tab.id });
    } else if (state.stop?.reason === 'rate_limited') {
      await persist();
      send(tab.id, { action: 'STOP_QUIZ_AUTOMATION', payload: state.stop });
      return;
    } else state.closing.push({ ...pending.quiz, tabId: tab.id });
    await persist();
    await removeClosingTabs();
    await pump();
  }

  async function pump() {
    if (state.reloadAt != null) {
      if (Date.now() < state.reloadAt) return schedule(state.reloadAt);
      const sourceTab = state.sourceTab;
      state.reloadAt = null;
      await persist();
      schedule(null);
      const tab = await chrome.tabs.get(sourceTab).catch(() => null);
      if (tab && (tab.pendingUrl || tab.url) === state.sourceUrl) await chrome.tabs.reload(sourceTab).catch(() => {});
    }
    if (!state.active || state.managed.length || state.pending) return;
    if (!state.queue.length) {
      state.active = false;
      state.reloadAt = state.sourceTab == null ? null : Date.now() + 1500;
      await persist();
      toast(state.sourceTab, 'Finished all quizzes', 'success');
      return schedule(state.reloadAt);
    }
    if (Date.now() < state.nextOpenAt) return schedule(state.nextOpenAt);
    const quiz = state.queue.shift();
    const url = new URL(quiz.url);
    // A reserved URL identifies a tab even if Chrome stops the worker before create resolves.
    url.hash = 'coursera-automation-quiz=' + Date.now() + '-' + Math.random().toString(36).slice(2);
    const pending = { quiz, url: url.href, cancelled: false };
    state.pending = pending;
    state.nextOpenAt = Date.now() + minimumInterval;
    await persist();
    schedule(state.nextOpenAt);
    chrome.tabs.create({ url: pending.url, active: false }).then(
      tab => enqueue(() => created(pending, tab)),
      () => enqueue(async () => {
        if (state.pending?.url !== pending.url) return;
        state.pending = null;
        await stopPool('tab_error');
        toast(state.sourceTab, 'Не удалось открыть Quiz. Очередь остановлена.', 'error');
      })
    ).catch(() => {});
  }

  async function handle(message, sender) {
    if (message.action === 'QUIZ_RATE_LIMITED') {
      if (!isCoursera(sender.tab?.url || sender.url)) return { success: false };
      await rateLimited(sender.tab?.id, message.payload?.retryAfterSeconds);
      return { success: true };
    }
    if (message.action === 'STOP_QUIZ_POOL') {
      await stopPool('user_stop', true);
      return { success: true };
    }
    if (message.action === 'GET_QUIZ_POOL_STATUS') return { active: state.active };
    if (message.action === 'CLOSE_TAB') {
      const quiz = state.managed.find(value => value.tabId === sender.tab?.id);
      if (quiz) {
        state.managed = state.managed.filter(value => value !== quiz);
        state.closing.push(quiz);
        await persist();
        await removeClosingTabs();
        await pump();
      }
      return { success: true };
    }
    if (state.active || state.pending) return { success: false, active: state.active, error: 'Quiz is already running or stopping.' };
    if (!isCoursera(sender.tab?.url || sender.url) || !/^[a-zA-Z0-9_-]+$/.test(message.openCourseSlug || '') || !Array.isArray(message.quizzes)) {
      return { success: false, error: 'Неверный список Quiz.' };
    }
    state.sourceTab = sender.tab?.id ?? null;
    state.sourceUrl = sender.tab?.url || null;
    state.reloadAt = null;
    state.stop = null;
    state.queue = message.quizzes.filter(quiz => /^[a-zA-Z0-9_-]+$/.test(quiz?.itemId || '') && /^[a-zA-Z0-9_-]+$/.test(quiz?.slug || '')).map(quiz => ({
      itemId: quiz.itemId, name: quiz.name || quiz.itemId, slug: quiz.slug,
      openCourseSlug: message.openCourseSlug,
      url: 'https://www.coursera.org/learn/' + message.openCourseSlug + '/assignment-submission/' + quiz.itemId + '/' + quiz.slug + '/attempt'
    }));
    state.active = true;
    const count = state.queue.length;
    await persist();
    await pump();
    return { success: true, count };
  }

  async function skipVideos(message, sender) {
    await ready;
    if (videoRun) return { success: false, error: 'Skip Video+ уже работает.' };
    const items = message.payload?.items;
    const userId = message.payload?._0x347e4cd8be;
    if (!isCoursera(sender.tab?.url || sender.url) || !Array.isArray(items) || !items.length || !userId) {
      return { success: false, error: 'Нет видео для обработки.' };
    }
    const run = { epoch: videoEpoch, tabId: sender.tab?.id };
    videoRun = run;
    const results = [];
    let stopped = false;
    const check = () => {
      if (run.epoch !== videoEpoch) throw new Error('Автоматизация остановлена.');
    };
    const request = async (url, options, allowTemporaryEndState = false) => {
      check();
      const response = await fetch(url, { ...options, credentials: 'include' });
      if (response.status === 429) {
        const value = response.headers?.get('Retry-After');
        const seconds = /^\d+$/.test(value || '') ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000);
        await enqueue(() => rateLimited(run.tabId, Number.isFinite(seconds) && seconds > 0 ? seconds : undefined));
      }
      check();
      if (!response.ok && !(allowTemporaryEndState && response.status === 400)) throw new Error('HTTP ' + response.status);
      return response;
    };
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    try {
      for (const item of items) {
        try {
          check();
          if (!Number.isFinite(item.timeCommitment) || item.timeCommitment < 1) {
            throw new Error('Coursera не вернула корректную длительность видео. Обнови страницу курса и повтори.');
          }
          const eventUrl = 'https://www.coursera.org/api/opencourse.v1/user/' + encodeURIComponent(userId) + '/course/' + encodeURIComponent(item.open_course_slug) + '/item/' + encodeURIComponent(item.item_id) + '/lecture/videoEvents/';
          const eventOptions = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contentRequestBody: {} }) };
          await request(eventUrl + 'play?autoEnroll=false', eventOptions);
          const progressId = userId + '~' + item.course_id + '~' + item.videoId;
          await request('https://www.coursera.org/api/onDemandVideoProgresses.v1/' + encodeURIComponent(progressId), {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ viewedUpTo: Math.floor(item.timeCommitment), videoProgressId: progressId })
          });
          await wait(2000);
          let completed = false;
          for (let attempt = 0; attempt < 5; attempt++) {
            const response = await request(eventUrl + 'ended?autoEnroll=false', eventOptions, true);
            const body = await response.json().catch(() => ({}));
            if (response.ok && body?.itemProgress?.progressState === 'Completed') { completed = true; break; }
            if ((response.status !== 400 && body?.itemProgress?.progressState !== 'Started') || attempt === 4) break;
            await wait(8000);
          }
          if (!completed) throw new Error('Coursera не подтвердила завершение видео.');
          results.push({ item_id: item.item_id, status: 'completed' });
        } catch (error) {
          results.push({ item_id: item.item_id, status: 'failed', error: error.message });
          if (run.epoch !== videoEpoch) { stopped = true; break; }
        }
      }
      const completed = results.filter(result => result.status === 'completed').length;
      const failed = results.length - completed;
      const summary = { success: completed === items.length, completed, failed, skipped: items.length - results.length, total: items.length, stopped, results };
      await toast(run.tabId, summary.success ? 'Все видео завершены: ' + completed + '.' :
        'Завершено видео: ' + completed + ' из ' + items.length + '. Ошибок: ' + failed + (stopped ? '. Автоматизация остановлена.' : '.'), summary.success ? 'success' : 'error', !summary.success);
      return summary;
    } finally { videoRun = null; }
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!actions.has(message?.action)) return;
    const result = message.action === 'SKIP_VIDEO_PLUS' ? skipVideos(message, sender) : enqueue(() => handle(message, sender));
    result.then(respond, error => respond({ success: false, error: error.message || 'Не удалось сохранить состояние автоматизации.' }));
    return true;
  });
  chrome.tabs.onRemoved.addListener(tabId => {
    enqueue(async () => {
      if (!state.managed.some(quiz => quiz.tabId === tabId)) return;
      state.managed = state.managed.filter(quiz => quiz.tabId !== tabId);
      await persist();
      await pump();
    }).catch(() => {});
  });
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === alarmName) enqueue(pump).catch(() => {});
  });
  // Recreate a lost alarm after startup; message handlers enter the same queue first.
  ready.then(() => { timer = setTimeout(() => enqueue(pump).catch(() => {}), 0); }).catch(() => {});
})();
