# Coursera Automation Extension — Personal

![Version](https://img.shields.io/badge/version-3.6.12-blue)
![Platform](https://img.shields.io/badge/platform-Chrome-blue)

Эта персональная версия работает без подписки автора и автоматического открытия его страниц. Skip Video+ доступен локально. Quiz обращается напрямую к DeepSeek с твоим API-ключом; запросы оплачиваются на твоём аккаунте DeepSeek.

## Настройка персональной версии

1. В `chrome://extensions/` загрузи эту папку через **Load unpacked** или нажми **Reload** у уже установленного расширения.
2. Обнови открытые страницы Coursera, чтобы они получили новые скрипты.
3. Открой меню расширения → шестерёнка → **DeepSeek для Quiz**.
4. Вставь свой API-ключ DeepSeek, выбери модель и нажми **Сохранить DeepSeek**. Ключ хранится локально в браузере и не синхронизируется.
5. Для одного Quiz открой попытку, дождись загрузки вопросов и нажми **Quiz** или `Alt+Z`.

**Auto Quiz Attempt** включает автоматические ответы; **Auto Submit Quiz** — автоматическую отправку. **Attempt All Quiz** включает оба режима для обработки курса. Чтобы включить выбранные режимы, нажми **Save** в разделе Additional. По умолчанию автоматические ответы и отправка выключены.

Обычная кнопка **Quiz** работает с текущим тестом. Весь курс обрабатывается только при включённом **Attempt All Quiz**: по одному тесту, с интервалом не менее 15 секунд между открытиями. Очередь восстанавливается после перезапуска фонового процесса расширения в текущем сеансе браузера. Повторные попытки также выдерживают паузу. Quiz не загружает заранее данные всех видео курса.

Ответы привязаны к текущим вопросам и попытке: после перехода к другому тесту старый ответ не применяется. Вопросы с изображениями и другими визуальными материалами требуют ручного ответа; расширение показывает сообщение и не отправляет неполный текст в AI. Автоматическая отправка нажимает подтверждение один раз и ожидает ответ Coursera до 30 секунд; если подтверждения нет, проверь результат на странице.

Если Coursera отвечает `too-many-requests` или HTTP 429, автоматизация останавливается без автоматического возобновления. Дождись снятия ограничения на стороне Coursera; если сервер указал `Retry-After`, расширение покажет эту подсказку. Выбранный интервал снижает интенсивность запросов, но не является опубликованным лимитом Coursera. После обновления с предыдущей версии закрой лишние вкладки Quiz, чтобы старые скрипты не продолжали работу.

Модели и формат запросов: [официальная документация DeepSeek](https://api-docs.deepseek.com/en/).

Локальные проверки без ключей и запросов к реальным курсам: `node --test tests/*.test.cjs`.

`Disclaimer:` Quiz Automation provides AI-generated answers, which may not always be accurate. Live compatibility with Coursera must be checked in your own browser.

## Table of Contents

- [Demo](#demo)
- [Features](#features-status)
- [Installation](#installation)
- [How to use](#how-to-use)
- [Shareable Link](#shareable-link)
- [Skip Video+](#skipvideoplus)
- [Quiz Automation](#quiz-automation)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Author](#author)
- [License](#license)

## Demo

<div align="center">
  <a href="https://youtu.be/jKkWUVLRLnE"><img src="https://i.ytimg.com/vi/jKkWUVLRLnE/hqdefault.jpg" alt="Coursera Automation Extension"></a>
</div>

## Features Status

The table below is inherited from the original project; current Coursera compatibility has not been verified by this personal adaptation.

| Feature                              | Status     | Notes                                                                           |
| ------------------------------------ | ---------- | ------------------------------------------------------------------------------- |
| Complete quizzes                     | 🟢 Working | [Watch Demo](https://youtu.be/TrJqspKdKlw)                                      |
| Complete lectures                    | 🟢 Working |                                                                                 |
| Complete reading materials           | 🟢 Working |                                                                                 |
| Complete ungraded plugins (dialogue) | 🟢 Working |                                                                                 |
| Complete discussions                 | 🟢 Working |                                                                                 |
| Shareable link                       | 🟢 Working |                                                                                 |
| Quiz automation                      | 🟢 Working | [Watch Demo](https://youtu.be/TrJqspKdKlw) Feedback-based accuracy improvement. |
| Skip Video+                          | 🟢 Working | [Watch Demo](https://youtu.be/3OZZ5n2eS8s)                                      |
| Locking browser                      | 🟢 Working | [Watch Demo](https://youtu.be/pd5HfVeC4AM)                                      |

## Installation

1. Clone or download the repository.
2. Open the Chrome browser.
3. Go to `chrome://extensions/`.
4. Enable `Developer mode`.
5. Click on `Load unpacked`.
6. Select the downloaded folder.
7. The extension will be added to the browser.

## How to use

1. Open your Coursera course.
2. Click on the Extension icon.
3. Choose the task you want to automate.
4. Sit back while the Extension completes the task.

## Shareable Link

To generate a **Shareable Link** for your assignment submission:

1. **Navigate to the Submission Page**: Ensure you're on the "My Submission" tab of your assignment.

2. **Use the Extension**: Click the "Shareable Link" button provided by the extension.

## Skip Video+

Automatically skip Coursera video lectures and mark them as completed.

- Available without an author subscription in this personal version. Reload the extension and the Coursera tab after updating the files.
- Videos are processed sequentially. HTTP 429 stops the operation; failed completions are reported rather than counted as successful.

## Quiz Automation

This personal version gets solutions directly from DeepSeek using the API key saved in extension settings, then marks the returned options.

`Note:` When you Reattempt the quiz, it's using the previous attempt feedback to improve the accuracy of the answers.

1. Configure your DeepSeek API key in extension settings.
2. Open the quiz attempt and wait for its questions to load.
3. Click **Quiz** or press **Alt + Z** for answers. Enable **Auto Quiz Attempt** for automatic answering.
4. Review and submit your answers, or enable **Auto Submit Quiz**.

## Keyboard Shortcuts

- `Alt + W` or `Alt + B`: Toggle the Extension
- `Alt + Z` or `Ctrl + Shift + Z`: Refresh the answers or Navigate to the next question(mark as correct)

## Support the Developer

If you find this extension helpful, consider supporting its development to keep it alive and growing! Every contribution makes a difference. ❤️

- Donate via UPI: devjs@jio
- [Sponsor me on GitHub](https://github.com/sponsors/sauravhathi)
- [Buy me a coffee](https://www.buymeacoffee.com/sauravhathi)
- [Donate via PayPal](https://paypal.me/sauravkumar680)

## Author

- [Saurav Hathi](https://github.com/sauravhathi)

## License

See [LICENSE](LICENSE) for the licensing terms.

---

> ⚠️ This extension is an independent tool designed for personal learning productivity and is not affiliated with or endorsed by Coursera.

---
