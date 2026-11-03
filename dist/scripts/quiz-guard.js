(() => {
  'use strict';
  let blocked = false;
  let blockedRetrySeconds;

  function isCoursera(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && (parsed.hostname === 'coursera.org' || parsed.hostname.endsWith('.coursera.org'));
    } catch { return false; }
  }

  function retrySeconds(value) {
    if (!value) return undefined;
    const seconds = /^\d+$/.test(String(value).trim()) ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000);
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 86400) : undefined;
  }

  function showNotice(seconds = blockedRetrySeconds) {
    if (!document.body) return;
    let notice = document.getElementById('coursera-rate-limit-notice');
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'coursera-rate-limit-notice';
      notice.setAttribute('role', 'alert');
      Object.assign(notice.style, {
        position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
        zIndex: '2147483647', maxWidth: 'min(560px, 90vw)', padding: '14px 18px',
        color: '#fff', background: '#9b1c1c', borderRadius: '8px', font: '14px/1.5 sans-serif'
      });
      document.body.appendChild(notice);
    }
    notice.textContent = 'Coursera временно ограничила запросы. Автоматизация Quiz остановлена. ' +
      (seconds ? 'Сервер просит подождать не менее ' + seconds + ' сек. ' : '') +
      'Подожди перед повторным запуском; не обновляй страницу многократно.';
  }

  function block(seconds, notify = true) {
    if (blocked) return;
    blocked = true;
    blockedRetrySeconds = retrySeconds(seconds);
    showNotice();
    if (notify) chrome.runtime.sendMessage({
      action: 'QUIZ_RATE_LIMITED', payload: { retryAfterSeconds: blockedRetrySeconds }
    }, () => { chrome.runtime.lastError; });
  }

  globalThis.courseraQuizGuard = Object.freeze({ isBlocked: () => blocked, block });

  window.addEventListener('message', event => {
    if (event.source !== window || !isCoursera(event.data?.url)) return;
    const data = event.data;
    let response = data.response;
    if (typeof response === 'string' && response.length < 10000) {
      try { response = JSON.parse(response); } catch {}
    }
    if (Number(data.extra?.status) === 429 || response?.message === 'too-many-requests') {
      block(retrySeconds(data.extra?.retryAfter));
    }
  });

  chrome.runtime.onMessage.addListener(message => {
    if (message?.action === 'STOP_QUIZ_AUTOMATION' && message.payload?.reason === 'rate_limited') {
      block(message.payload.retryAfterSeconds, false);
    }
  });

  function checkPage() {
    if (!isCoursera(location.href)) return;
    const text = document.body?.innerText || document.body?.textContent || '';
    if (text.length < 10000) {
      try {
        if (JSON.parse(text).message === 'too-many-requests') block();
      } catch {}
    }
    if (blocked) showNotice();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', checkPage, { once: true });
  else checkPage();
})();
