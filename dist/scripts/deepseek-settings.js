document.addEventListener('DOMContentLoaded', async () => {
  'use strict';

  const form = document.getElementById('deepseekForm');
  const keyInput = document.getElementById('deepseekApiKey');
  const modelInput = document.getElementById('deepseekModel');
  const saveButton = document.getElementById('saveDeepseekBtn');
  const removeButton = document.getElementById('removeDeepseekKeyBtn');
  const status = document.getElementById('deepseekStatus');
  const keyStatus = document.getElementById('deepseekKeyStatus');
  const models = new Set(['deepseek-flash', 'deepseek-v4-pro']);
  let hasSavedKey = false;

  function showStatus(text, error = false) {
    status.textContent = text;
    status.dataset.state = error ? 'error' : 'success';
  }

  function updateKeyStatus() {
    keyStatus.textContent = hasSavedKey
      ? 'Ключ сохранён. Пустое поле сохранит текущий ключ; новый ключ заменит его.'
      : 'Ключ ещё не добавлен.';
    removeButton.disabled = !hasSavedKey;
  }

  function setBusy(busy) {
    saveButton.disabled = busy;
    removeButton.disabled = busy || !hasSavedKey;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const key = keyInput.value.trim();
    if (!key && !hasSavedKey) return showStatus('Вставь свой API-ключ DeepSeek.', true);
    if (key.length > 512 || /\s/.test(key)) return showStatus('Ключ не должен содержать пробелы и переносы строк.', true);
    if (!models.has(modelInput.value)) return showStatus('Выбери модель из списка.', true);
    setBusy(true);
    try {
      await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      const settings = { deepseekModel: modelInput.value };
      if (key) settings.deepseekApiKey = key;
      await chrome.storage.local.set(settings);
      hasSavedKey = true;
      keyInput.value = '';
      updateKeyStatus();
      showStatus('Настройки DeepSeek сохранены.');
    } catch {
      showStatus('Не удалось сохранить настройки DeepSeek.', true);
    } finally {
      setBusy(false);
    }
  });

  removeButton.addEventListener('click', async () => {
    setBusy(true);
    try {
      await chrome.storage.local.remove('deepseekApiKey');
      hasSavedKey = false;
      keyInput.value = '';
      updateKeyStatus();
      showStatus('API-ключ удалён из расширения.');
    } catch {
      showStatus('Не удалось удалить API-ключ.', true);
    } finally {
      setBusy(false);
    }
  });

  setBusy(true);
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const settings = await chrome.storage.local.get(['deepseekApiKey', 'deepseekModel']);
    hasSavedKey = typeof settings.deepseekApiKey === 'string' && !!settings.deepseekApiKey.trim();
    modelInput.value = models.has(settings.deepseekModel) ? settings.deepseekModel : 'deepseek-flash';
    updateKeyStatus();
  } catch {
    showStatus('Не удалось загрузить настройки DeepSeek.', true);
  } finally {
    setBusy(false);
  }
});
