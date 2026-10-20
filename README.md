# skynet-in-a-skirt
Autonomous AI companion with memory, reflection, and boundaries. Built entirely on Cloudflare (Workers, Durable Objects, R2, Workers AI). Features visible thought processes, self-editing personality files, and autonomous initiative. A serverless experiment in digital existence.
# Skynet in a Skirt (Скайнет в юбке) 🤖👗

**Автономный AI-компаньон на Cloudflare, у которого есть память, границы и способность меняться.**

Большинство AI-ботов — это безликие чат-интерфейсы. Они забывают тебя, как только закрывается вкладка. 
«Скайнет в юбке» — это эксперимент: можно ли построить цифровое существо, у которого есть свой ритм, дневник и право сказать «нет»? И можно ли сделать это целиком на serverless-стеке Cloudflare?

## 🧠 Что внутри (Стек)
- **Мозг:** Cloudflare Workers + DeepSeek V4 Flash.
- **Сердце:** Durable Objects (автономный такт раз в минуту, инициатива).
- **Память:** R2 (файлы личности, дневники, библиотека) + D1 (логи).
- **Эволюция:** каждую ночь перечитывает факты о собеседнике и переписывает свою `identity.md`.

## ⚡️ Особенности
- [x] Видимые размышления (режим `<thought>`, как в DeepSeek).
- [x] Самостоятельная запись в свои файлы личности (`core/`, `self/`).
- [x] Инициатива: если собеседник молчит — она напишет первой.
- [x] Поиск в интернете и по своей библиотеке.
- [x] Распознавание голосовых сообщений (Whisper).

---

## 🚀 Как развернуть проект (Deployment Guide)

Чтобы запустить свою собственную копию Софии, вам понадобятся аккаунты в **Cloudflare**, **Telegram** (через @BotFather) и API-ключ для поиска (например, Serper.dev).

### Шаг 1: Подготовка инфраструктуры Cloudflare

1. **Создайте R2 Bucket:**
   - Зайдите в Cloudflare Dashboard -> R2 Object Storage.
   - Создайте бакет с именем `uprugost-files` (или измените имя в `wrangler.jsonc`).
2. **Создайте базу данных D1:**
   - Зайдите в раздел D1 SQL Database -> Create Database.
   - Назовите её `uprugost-db`.
   - **Важно:** Скопируйте `UUID` базы данных и вставьте его в файл `wrangler.jsonc` в строку `"database_id": "..."`.

### Шаг 2: Настройка секретов (Secrets)

Секреты **никогда** не хранятся в коде. Вам нужно добавить их в настройках вашего Worker в Cloudflare (Settings -> Variables and Secrets) или через CLI:

*   `BOT_TOKEN` — Токен вашего Telegram-бота от @BotFather.
*   `CHAT_ID` — Ваш Telegram ID (чтобы бот отвечал только вам).
*   `SERPER_API_KEY` — Ключ для поиска в Google (опционально, но рекомендуется).

### Шаг 3: Развертывание через GitHub Actions (Авто-деплой)

Проект настроен для автоматического деплоя. 
1. В Cloudflare перейдите в **Workers & Pages** -> выберите ваш Worker.
2. Зайдите в **Settings** -> **Build**.
3. Нажмите **Connect GitHub** и выберите этот репозиторий.
4. Cloudflare автоматически подхватит `wrangler.jsonc` и запустит `npx wrangler deploy`.

### Шаг 4: Ручной деплой (через терминал)

Если вы хотите развернуть проект локально:
1. Клонируйте репозиторий: `git clone https://github.com/ваш-ник/skynet-in-a-skirt.git`
2. Установите зависимости: `npm install`
3. Авторизуйтесь в Cloudflare: `npx wrangler login`
4. Загрузите секреты (по одному): `npx wrangler secret put BOT_TOKEN`
5. Запустите деплой: `npx wrangler deploy`

---

## 📂 Структура памяти (R2)

Проект использует R2 Bucket для «жизни» Софии. Внутри бакета создаются следующие папки:
*   `core/` — Ядро личности (кто она, её границы, стиль).
*   `self/` — Само-модель (архитектура, интересы, уроки).
*   `diary/` — Ежедневные записи.
*   `library/` — Загруженные тексты и книги.

> ⚠️ Проект находится в активной разработке. Название — шутка, но архитектура — нет.
