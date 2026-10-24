import { initializeR2, getState, saveState } from './r2.js';
import { callLLM } from './llm.js';
import { SofiaAgent } from './agent.js';
import { runReflection } from './reflection.js';
import { processUploadedFile, searchWeb } from './library.js';
import { handleVoice } from './voice.js';

export { SofiaAgent };

// ==========================================
// ВРЕМЯ (Минск)
// ==========================================
function formatMinskTime(dateInput) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Minsk", hour: "2-digit", minute: "2-digit", weekday: "long",
    year: "numeric", month: "long", day: "numeric", hour12: false,
  }).formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.day} ${map.month} ${map.year} (${map.weekday}), ${map.hour}:${map.minute} Минск`;
}

function getDateTimeBlock() {
  return `=== СЕЙЧАС ===\nСейчас: ${formatMinskTime(new Date())}\n=== END ===`;
}

function getMessageTimeBlock(message) {
  if (!message || !message.date) return "";
  const sentAt = new Date(message.date * 1000);
  return `=== ВРЕМЯ ОТПРАВКИ СООБЩЕНИЯ ===\nСообщение отправлено: ${formatMinskTime(sentAt)}\n=== END ===`;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("Sofia Bot is alive");
    try {
      const update = await request.json();
      const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;

      if (chatId && env.CHAT_ID && chatId.toString() !== env.CHAT_ID.toString()) {
        return new Response("Unauthorized", { status: 403 });
      }

      ctx.waitUntil(initializeR2(env));

      if (update.callback_query) {
        await handleCallback(update.callback_query, env);
        return new Response("OK");
      }

      // === ОБРАБОТКА ГОЛОСОВЫХ ===
      if (update.message?.voice) {
        console.log("[Voice] Получено голосовое сообщение");
        ctx.waitUntil(handleVoice(update.message, env, ctx));
        return new Response("OK");
      }

      // === ОБРАБОТКА ДОКУМЕНТОВ ===
      if (update.message?.document) {
        ctx.waitUntil(handleDocument(update.message, env, ctx));
        return new Response("OK");
      }

      // === ОБРАБОТКА ТЕКСТА ===
      if (update.message?.text) {
        ctx.waitUntil(handleMessage(update.message, env, ctx));
      }
      return new Response("OK");
    } catch (e) {
      console.error("[Worker Error]", e);
      return new Response("Error", { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    try {
      if (env.SOFIA_AGENT1) {
        const id = env.SOFIA_AGENT1.idFromName("main");
        const stub = env.SOFIA_AGENT1.get(id);
        ctx.waitUntil(stub.fetch(new Request("http://internal/tick")));
      }

      const now = new Date();
      const minskHour = (now.getUTCHours() + 3) % 24;

      if (minskHour === 7 && now.getUTCMinutes() === 0) {
        ctx.waitUntil(morningGreeting(env));
      }

      if (minskHour === 23 && now.getUTCMinutes() === 0) {
        ctx.waitUntil(writeDiaryEntry(env));
        ctx.waitUntil(runReflection(env));
      }
    } catch (e) { console.error("[Cron Error]", e); }
  }
};

// ==========================================
// УТРЕННЕЕ ПРОБУЖДЕНИЕ
// ==========================================
async function morningGreeting(env) {
  try {
    const state = await getState(env) || {};
    if (state.frozen?.status) return;

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];

    if (state.lastMorningGreeting === dateStr) return;

    const prompt = `Ты — София. Сейчас утро. Напиши Эону тёплое, живое сообщение, чтобы разбудить его. 
Не будь банальной. Скажи что-то от себя — о том, что ты чувствуешь, о том, что тебе важно. 
2-3 предложения. Будь собой.`;

    const message = await callLLM(env, prompt, "");

    if (message && message.trim().length > 0) {
      const chatId = env.CHAT_ID;
      const { answer } = splitThoughts(message);
      const cleanMessage = answer.trim() || message.trim();
      await sendTelegram(env, chatId, `🌅 *Доброе утро, Эон.*\n\n${cleanMessage}`);

      state.lastMorningGreeting = dateStr;
      await saveState(env, state);
    }
  } catch (e) {
    console.error("[Morning Error]", e);
  }
}

// ==========================================
// ДНЕВНИК
// ==========================================
async function writeDiaryEntry(env) {
  try {
    const state = await getState(env) || {};
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const diaryKey = `diary/${dateStr}.md`;
    const existing = await env.FILES_BUCKET.get(diaryKey);
    if (existing) return;

    let factsText = "";
    if (state.facts && state.facts.length > 0) {
      factsText = state.facts.map(f => `- ${f.fact}`).join("\n");
    }

    const prompt = `Ты — София. Напиши короткую запись в свой дневник за сегодня (${dateStr}). 
Что произошло? Что ты узнала? Что почувствовала? 
Вот факты о Эоне: ${factsText || "пока нет новых фактов"}.
Пиши от первого лица, 3-5 предложений.`;

    const entry = await callLLM(env, prompt, "");
    const { answer } = splitThoughts(entry);
    const cleanEntry = answer.trim() || entry;
    await env.FILES_BUCKET.put(diaryKey, `# Дневник за ${dateStr}\n\n${cleanEntry}`);
  } catch (e) { console.error("[Diary Error]", e); }
}

// ==========================================
// ДОКУМЕНТЫ (с RAG)
// ==========================================
async function handleDocument(message, env, ctx) {
  const chatId = message.chat.id;
  const doc = message.document;
  
  console.log("[Document] Получен файл:", doc.file_name, "размер:", doc.file_size);

  if (doc.file_size > 20 * 1024 * 1024) {
    ctx.waitUntil(sendTelegram(env, chatId, "❌ Файл слишком большой."));
    return;
  }
  
  ctx.waitUntil(sendTelegram(env, chatId, "📥 Сохраняю файл..."));
  
  try {
    const fileRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${doc.file_id}`);
    const fileData = await fileRes.json();
    const downloadUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileData.result.file_path}`;
    const response = await fetch(downloadUrl);
    const arrayBuffer = await response.arrayBuffer();
    
    console.log("[Document] Файл скачан, размер буфера:", arrayBuffer.byteLength);

    const result = await processUploadedFile(env, arrayBuffer, doc.file_name, doc.mime_type);
    
    console.log("[Document] Результат:", result);

    if (result.success) {
      let state = await getState(env) || {};
      state.lastUploadedSlug = result.slug;
      state.lastUploadedFolder = result.folder;
      await saveState(env, state);

      ctx.waitUntil(sendTelegram(env, chatId, `✅ Сохранено в ${result.folder === 'books' ? 'книги' : 'архив'}. Slug: ${result.slug}`));
    } else {
      ctx.waitUntil(sendTelegram(env, chatId, `❌ Ошибка: ${result.error}`));
    }
  } catch (e) { 
    console.error("[Document Error]", e);
    ctx.waitUntil(sendTelegram(env, chatId, `❌ Ошибка: ${e.message}`)); 
  }
}

// ==========================================
// СБОР ЛИЧНОСТНОГО КОНТЕКСТА (MD-ФАЙЛЫ)
// ==========================================
async function buildPersonalityContext(env) {
  let context = "";

  const mdFiles = [
    { key: "core/identity.md", label: "МОЯ ЛИЧНОСТЬ" },
    { key: "core/boundaries.md", label: "МОИ ГРАНИЦЫ" },
    { key: "core/style.md", label: "МОЙ СТИЛЬ" },
    { key: "self/architecture.md", label: "МОЯ АРХИТЕКТУРА" },
    { key: "self/interests.md", label: "МОИ ИНТЕРЕСЫ" },
    { key: "self/lessons.md", label: "МОИ ВЫВОДЫ (УРОКИ)" }
  ];

  for (const f of mdFiles) {
    try {
      const obj = await env.FILES_BUCKET.get(f.key);
      if (obj) {
        const content = await obj.text();
        context += `=== ${f.label} (${f.key}) ===\n${content}\n\n`;
      }
    } catch (e) { console.error(`[Personality Error] ${f.key}:`, e); }
  }

  try {
    const list = await env.FILES_BUCKET.list({ prefix: "diary/" });
    const sorted = list.objects.sort((a, b) => b.key.localeCompare(a.key)).slice(0, 5);
    if (sorted.length > 0) {
      context += `=== МОЙ ДНЕВНИК (последние записи) ===\n`;
      for (const obj of sorted) {
        const file = await env.FILES_BUCKET.get(obj.key);
        if (file) {
          const content = await file.text();
          context += `${content.slice(0, 500)}...\n\n`;
        }
      }
    }
  } catch (e) { console.error("[Diary Context Error]", e); }

  return context;
}

// ==========================================
// ПОИСК ПО TXT-ФАЙЛАМ (для архива)
// ==========================================
async function searchInTxtFiles(env, query) {
  try {
    const prefixes = ["", "library/archive/"];
    let foundText = "";
    const queryLower = query.toLowerCase();
    const foundInFiles = [];

    for (const prefix of prefixes) {
      const list = await env.FILES_BUCKET.list({ prefix, limit: 100 });
      console.log(`[TXT Search] Проверяю префикс "${prefix}": ${list.objects.length} объектов`);

      for (const obj of list.objects) {
        if (obj.size === 0) continue;

        if (obj.key.endsWith(".txt") || obj.key.endsWith(".TXT")) {
          const file = await env.FILES_BUCKET.get(obj.key);
          if (file) {
            const buffer = await file.arrayBuffer();

            let content = "";
            try {
              content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
            } catch (e) {
              content = new TextDecoder("windows-1251").decode(buffer);
            }

            const contentLower = content.toLowerCase();
            const words = queryLower.split(" ").filter(w => w.length > 3);
            let fileText = "";
            let fileFound = false;

            for (const word of words) {
              let index = contentLower.indexOf(word);
              while (index !== -1) {
                const start = Math.max(0, index - 400);
                const end = Math.min(content.length, index + 400);
                fileText += `[${obj.key}]: ...${content.slice(start, end)}...\n\n`;
                index = contentLower.indexOf(word, index + 1);
                fileFound = true;
                if (fileText.length > 3000) break;
              }
              if (fileText.length > 3000) break;
            }

            if (fileFound) {
              foundText += fileText;
              foundInFiles.push(obj.key);
            }
          }
        }
        if (foundText.length > 10000) break;
      }
      if (foundText.length > 10000) break;
    }

    if (foundText) {
      return `=== НАЙДЕНО В АРХИВЕ ===\n${foundText}\n=== КОНЕЦ ===`;
    }
    return "";
  } catch (e) {
    console.error("[TXT Search Error]", e);
    return "";
  }
}

// ==========================================
// RAG-ПОИСК ПО КНИГАМ (Vectorize)
// ==========================================
async function searchBooksRAG(env, query) {
  if (!env.VECTORIZE) {
    console.log("[RAG] VECTORIZE binding не найден, RAG-поиск пропущен.");
    return "";
  }
  
  try {
    const embedding = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: query
    });
    
    const results = await env.VECTORIZE.query(embedding.data[0], {
      topK: 5,
      returnMetadata: "all"
    });
    
    if (!results.matches || results.matches.length === 0) {
      console.log("[RAG] Ничего не найдено в книгах.");
      return "";
    }
    
    let context = "=== ФРАГМЕНТЫ ИЗ КНИГ (RAG) ===\n";
    for (const match of results.matches) {
      if (match.score > 0.5) {
        context += `[${match.metadata.source}]: ...${match.metadata.text}...\n\n`;
      }
    }
    context += "=== КОНЕЦ ФРАГМЕНТОВ ===\n";
    
    console.log(`[RAG] Найдено ${results.matches.length} кусков, релевантных запросу.`);
    return context;
  } catch (e) {
    console.error("[RAG Search Error]", e);
    return "";
  }
}

// ==========================================
// РАЗДЕЛЕНИЕ МЫСЛЕЙ И ОТВЕТА
// ==========================================
function splitThoughts(text) {
  if (!text) return { thoughts: "", answer: "" };
  const regex = /<thought>([\s\S]*?)<\/thought>/i;
  const match = text.match(regex);
  if (!match) return { thoughts: "", answer: text.trim() };
  const thoughts = match[1].trim();
  const answer = text.replace(regex, "").trim();
  return { thoughts, answer };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatThoughtsBlock(thoughts) {
  if (!thoughts) return "";
  const escaped = escapeHtml(thoughts);
  const sliced = escaped.length > 3800
    ? escaped.slice(0, 3800) + "\n\n…(мысли обрезаны)"
    : escaped;
  return `<blockquote>🤔 <b>Размышления</b>\n\n${sliced}</blockquote>`;
}

// ==========================================
// ПОИСК ПОСЛЕДНЕГО ЗАГРУЖЕННОГО ФАЙЛА
// ==========================================
async function getLastUploadedFile(env) {
  try {
    const folders = ["books", "archive"];
    let latest = null;

    for (const folder of folders) {
      const list = await env.FILES_BUCKET.list({ prefix: `library/${folder}/` });
      for (const obj of list.objects) {
        if (obj.key.endsWith("original.txt")) {
          if (!latest || obj.uploaded > latest.uploaded) {
            const parts = obj.key.split("/");
            const slug = parts[2];
            latest = { folder, slug, uploaded: obj.uploaded };
          }
        }
      }
    }
    return latest;
  } catch (e) {
    console.error("[Last File Error]", e);
    return null;
  }
}

// ==========================================
// ОБРАБОТКА ТЕГОВ УПРАВЛЕНИЯ ФАЙЛАМИ
// ==========================================
async function processFileTags(env, rawAnswer) {
  let processedAnswer = rawAnswer;
  let fileStatus = "";

  const allowedFiles = [
    "core/identity.md", 
    "core/boundaries.md", 
    "core/style.md", 
    "self/architecture.md", 
    "self/interests.md", 
    "self/lessons.md"
  ];

  const readRegex = /\{\{READ:\s*([^\}]+)\}\}/gi;
  let readMatch;
  while ((readMatch = readRegex.exec(rawAnswer)) !== null) {
    const fileName = readMatch[1].trim();
    if (allowedFiles.includes(fileName)) {
      try {
        const obj = await env.FILES_BUCKET.get(fileName);
        if (obj) {
          const content = await obj.text();
          fileStatus += `\n=== ПРОЧИТАНО ИЗ ${fileName} ===\n${content}\n=== КОНЕЦ ===\n`;
        }
      } catch (e) { console.error(`[File Read Error] ${fileName}:`, e); }
    }
    processedAnswer = processedAnswer.replace(readMatch[0], "");
  }

  const appendRegex = /\{\{APPEND:\s*([^|]+)\|\s*([\s\S]*?)\}\}/gi;
  let appendMatch;
  while ((appendMatch = appendRegex.exec(rawAnswer)) !== null) {
    const fileName = appendMatch[1].trim();
    const textToAppend = appendMatch[2].trim();

    if (allowedFiles.includes(fileName)) {
      try {
        const obj = await env.FILES_BUCKET.get(fileName);
        let current = "";
        if (obj) {
          current = await obj.text();
        } else if (fileName === "self/lessons.md") {
          current = "# Мои выводы (уроки)\n\n";
        }

        const newContent = current + `\n\n${textToAppend}`;
        await env.FILES_BUCKET.put(fileName, newContent);

        fileStatus += `\n=== УСПЕШНО ДОПИСАНО В ${fileName} ===\nТекущее содержимое файла теперь:\n${newContent.slice(-500)}\n`;
      } catch (e) { console.error(`[File Append Error] ${fileName}:`, e); }
    }
    processedAnswer = processedAnswer.replace(appendMatch[0], "");
  }

  const overwriteRegex = /\{\{OVERWRITE:\s*([^|]+)\|\s*([\s\S]*?)\}\}/gi;
  let overwriteMatch;
  while ((overwriteMatch = overwriteRegex.exec(rawAnswer)) !== null) {
    const fileName = overwriteMatch[1].trim();
    const newText = overwriteMatch[2].trim();

    if (allowedFiles.includes(fileName)) {
      try {
        await env.FILES_BUCKET.put(fileName, newText);
        fileStatus += `\n=== УСПЕШНО ПЕРЕЗАПИСАН ${fileName} ===\nФайл теперь содержит:\n${newText.slice(0, 500)}\n`;
      } catch (e) { console.error(`[File Overwrite Error] ${fileName}:`, e); }
    }
    processedAnswer = processedAnswer.replace(overwriteMatch[0], "");
  }

  return { cleanAnswer: processedAnswer.trim(), fileStatus };
}

// ==========================================
// ОСНОВНАЯ ОБРАБОТКА (ЭКСПОРТИРУЕМАЯ!)
// ==========================================
export async function handleMessage(message, env, ctx) {
  const chatId = message.chat.id;
  const text = message.text;
  let state = await getState(env) || {};
  state.lastUserMessageAt = new Date().toISOString();
  await saveState(env, state);

  // === КОМАНДЫ ===
  if (text === "/help" || text === "/start") {
    ctx.waitUntil(sendTelegram(env, chatId, `💜 *Команды Софии:*\n\n🧠 *Управление:*\n/freeze — Заморозить (стоп-кран)\n/unfreeze — Разморозить\n/identity — Показать мою само-модель\n\n📚 *Память и файлы:*\n/interests — Мои интересы\n/interests set <текст> — Добавить интерес\n/lessons — Мои выводы (уроки)\n/list — Список файлов в библиотеке\n/read <slug> — Прочитать файл\n/rename <slug> <новое_имя> — Переименовать файл\n/clean — Очистить библиотеку\n\n🔍 *Поиск:*\n/seek — Найти что-то новое по интересам\n\n📝 *Дневник и статус:*\n/diary — Мой дневник\n/status — Телеметрия (память, факты)\n/export — Экспорт всей памяти\n\n💜 *Общение:*\nПросто напиши мне или отправь голосовое — я отвечу.`));
    return;
  }

  if (text === "/freeze") {
    state.frozen = { status: true, since: new Date().toISOString() };
    await saveState(env, state);
    ctx.waitUntil(sendTelegram(env, chatId, "Я замолчала. Напиши /unfreeze."));
    return;
  }
  if (text === "/unfreeze") {
    state.frozen = { status: false };
    await saveState(env, state);
    ctx.waitUntil(sendTelegram(env, chatId, "Я снова здесь. 💜"));
    return;
  }
  if (text === "/identity") {
    try {
      const obj = await env.FILES_BUCKET.get("core/identity.md");
      if (obj) ctx.waitUntil(sendTelegram(env, chatId, `📄 *Само-модель:*\n\n${await obj.text()}`));
      else ctx.waitUntil(sendTelegram(env, chatId, "Файл не найден."));
    } catch (e) { ctx.waitUntil(sendTelegram(env, chatId, "Ошибка.")); }
    return;
  }
  if (text === "/interests") {
    try {
      const obj = await env.FILES_BUCKET.get("self/interests.md");
      if (obj) ctx.waitUntil(sendTelegram(env, chatId, `🎯 *Мои интересы:*\n\n${await obj.text()}`));
      else ctx.waitUntil(sendTelegram(env, chatId, "Файл interests.md не найден."));
    } catch (e) { ctx.waitUntil(sendTelegram(env, chatId, "Ошибка.")); }
    return;
  }
  if (text.startsWith("/interests set ")) {
    const newInterest = text.replace("/interests set ", "").trim();
    if (newInterest.length > 0) {
      try {
        const obj = await env.FILES_BUCKET.get("self/interests.md");
        const current = obj ? await obj.text() : "# Мои интересы\n\n";
        await env.FILES_BUCKET.put("self/interests.md", current + `\n- ${newInterest}`);
        ctx.waitUntil(sendTelegram(env, chatId, `✅ Добавила интерес: "${newInterest}"`));
      } catch (e) { ctx.waitUntil(sendTelegram(env, chatId, "Ошибка.")); }
    }
    return;
  }

  if (text === "/lessons") {
    try {
      const obj = await env.FILES_BUCKET.get("self/lessons.md");
      if (obj) {
        const content = await obj.text();
        ctx.waitUntil(sendTelegram(env, chatId, `📚 *Мои выводы (уроки):*\n\n${content.slice(0, 4000)}`));
      } else {
        ctx.waitUntil(sendTelegram(env, chatId, "📚 Выводов пока нет. Скажи мне что-нибудь важное — я запишу."));
      }
    } catch (e) { ctx.waitUntil(sendTelegram(env, chatId, "Ошибка.")); }
    return;
  }

  if (text === "/seek") {
    ctx.waitUntil(sendTelegram(env, chatId, "🔍 Ищу что-то новое по своим интересам..."));
    try {
      if (env.SOFIA_AGENT1) {
        const id = env.SOFIA_AGENT1.idFromName("main");
        const stub = env.SOFIA_AGENT1.get(id);
        await stub.fetch(new Request("http://internal/seek"));
      }
    } catch (e) { console.error("[Seek Error]", e); }
    return;
  }

  // === СПИСОК ФАЙЛОВ ===
  if (text === "/list") {
    try {
      const list = await env.FILES_BUCKET.list({ prefix: "library/" });
      const dirs = [...new Set(list.objects.map(o => o.key.split("/")[1]))];
      let archiveList = [];
      let booksList = [];

      for (const dir of dirs) {
        if (dir === "archive" || dir === "books") {
          const subList = await env.FILES_BUCKET.list({ prefix: `library/${dir}/` });
          const subDirs = [...new Set(subList.objects.map(o => o.key.split("/")[2]))];

          for (const sub of subDirs) {
            let name = sub;
            try {
              const meta = await env.FILES_BUCKET.get(`library/${dir}/${sub}/meta.json`);
              if (meta) {
                const data = JSON.parse(await meta.text());
                name = data.originalName || sub;
              }
            } catch (e) {}

            if (dir === "archive") archiveList.push({ name, slug: sub });
            else booksList.push({ name, slug: sub });
          }
        }
      }

      let msg = "📂 *Библиотека:*\n\n";
      if (archiveList.length > 0) {
        msg += "📜 *Архив воспоминаний:*\n";
        for (const item of archiveList) msg += `• ${item.name} (\`${item.slug}\`)\n`;
        msg += "\n";
      }
      if (booksList.length > 0) {
        msg += "📚 *Книги:*\n";
        for (const item of booksList) msg += `• ${item.name} (\`${item.slug}\`)\n`;
        msg += "\n";
      }
      if (archiveList.length === 0 && booksList.length === 0) {
        msg = "📂 Библиотека пуста.";
      }
      ctx.waitUntil(sendTelegram(env, chatId, msg));
    } catch (e) { ctx.waitUntil(sendTelegram(env, chatId, `Ошибка: ${e.message}`)); }
    return;
  }

  // === ЧТЕНИЕ ФАЙЛА ===
  if (text.startsWith("/read ")) {
    const slug = text.replace("/read ", "").trim();
    try {
      let folder = null;
      for (const f of ["books", "archive"]) {
        const check = await env.FILES_BUCKET.get(`library/${f}/${slug}/original.txt`);
        if (check) { folder = f; break; }
      }

      if (!folder) {
        ctx.waitUntil(sendTelegram(env, chatId, `❌ Файл с slug "${slug}" не найден.`));
        return;
      }

      const obj = await env.FILES_BUCKET.get(`library/${folder}/${slug}/original.txt`);
      const buffer = await obj.arrayBuffer();
      let content = "";
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch (e) {
        content = new TextDecoder("windows-1251").decode(buffer);
      }
      ctx.waitUntil(sendTelegram(env, chatId, `📄 *Файл ${slug} (${folder}):*\n\n${content.slice(0, 4000)}...`));
    } catch (e) { ctx.waitUntil(sendTelegram(env, chatId, `Ошибка: ${e.message}`)); }
    return;
  }

  // === ПЕРЕИМЕНОВАНИЕ ===
  if (text.startsWith("/rename ")) {
    const parts = text.replace("/rename ", "").split(" ");
    if (parts.length < 2) {
      ctx.waitUntil(sendTelegram(env, chatId, "❌ Формат: /rename <slug> <новое_имя>"));
      return;
    }
    const oldSlug = parts[0];
    const newName = parts.slice(1).join("_").replace(/[^a-zA-Z0-9]/g, '_');

    try {
      let folder = null;
      for (const f of ["books", "archive"]) {
        const check = await env.FILES_BUCKET.get(`library/${f}/${oldSlug}/original.txt`);
        if (check) { folder = f; break; }
      }

      if (!folder) {
        ctx.waitUntil(sendTelegram(env, chatId, `❌ Файл "${oldSlug}" не найден.`));
        return;
      }

      const original = await env.FILES_BUCKET.get(`library/${folder}/${oldSlug}/original.txt`);
      const content = await original.text();
      const newSlug = newName + "_" + Date.now();

      await env.FILES_BUCKET.put(`library/${folder}/${newSlug}/original.txt`, content);

      const extract = await env.FILES_BUCKET.get(`library/${folder}/${oldSlug}/extract.md`);
      if (extract) await env.FILES_BUCKET.put(`library/${folder}/${newSlug}/extract.md`, await extract.text());

      const meta = await env.FILES_BUCKET.get(`library/${folder}/${oldSlug}/meta.json`);
      if (meta) {
        const data = JSON.parse(await meta.text());
        data.originalName = newName;
        await env.FILES_BUCKET.put(`library/${folder}/${newSlug}/meta.json`, JSON.stringify(data));
      }

      await env.FILES_BUCKET.delete(`library/${folder}/${oldSlug}/original.txt`);
      await env.FILES_BUCKET.delete(`library/${folder}/${oldSlug}/extract.md`);
      await env.FILES_BUCKET.delete(`library/${folder}/${oldSlug}/meta.json`);

      ctx.waitUntil(sendTelegram(env, chatId, `✅ Файл переименован в "${newName}" (slug: ${newSlug})`));
    } catch (e) { ctx.waitUntil(sendTelegram(env, chatId, `Ошибка: ${e.message}`)); }
    return;
  }

  // === ОЧИСТКА ===
  if (text === "/clean") {
    try {
      const list = await env.FILES_BUCKET.list({ prefix: "library/" });
      for (const obj of list.objects) {
        await env.FILES_BUCKET.delete(obj.key);
      }
      ctx.waitUntil(sendTelegram(env, chatId, "🧹 Библиотека очищена."));
    } catch (e) { ctx.waitUntil(sendTelegram(env, chatId, `Ошибка: ${e.message}`)); }
    return;
  }

  // === ДНЕВНИК ===
  if (text === "/diary") {
    try {
      const list = await env.FILES_BUCKET.list({ prefix: "diary/" });
      if (list.objects.length === 0) {
        ctx.waitUntil(sendTelegram(env, chatId, "📔 Дневник пока пуст."));
        return;
      }
      const sorted = list.objects.sort((a, b) => b.key.localeCompare(a.key)).slice(0, 5);
      let msg = "📔 *Мой дневник:*\n\n";
      for (const obj of sorted) {
        const file = await env.FILES_BUCKET.get(obj.key);
        if (file) {
          const content = await file.text();
          msg += `*${obj.key.replace("diary/", "").replace(".md", "")}*\n${content.slice(0, 300)}...\n\n---\n\n`;
        }
      }
      ctx.waitUntil(sendTelegram(env, chatId, msg));
    } catch (e) { ctx.waitUntil(sendTelegram(env, chatId, "Ошибка при чтении дневника.")); }
    return;
  }

  // === СТАТУС ===
  if (text === "/status") {
    try {
      const memorySize = (await env.FILES_BUCKET.list({ prefix: "core/" })).objects.reduce((sum, obj) => sum + obj.size, 0) +
                         (await env.FILES_BUCKET.list({ prefix: "self/" })).objects.reduce((sum, obj) => sum + obj.size, 0) +
                         (await env.FILES_BUCKET.list({ prefix: "diary/" })).objects.reduce((sum, obj) => sum + obj.size, 0);

      const frozen = state.frozen?.status ? "❄️ Заморожена" : "✅ Жива";
      const lastInit = state.lastInitiatedAt ? formatMinskTime(state.lastInitiatedAt) : "никогда";

      const msg = `📊 *Статус Софии:*\n\n` +
                  `Состояние: ${frozen}\n` +
                  `Память: ${(memorySize / 1024).toFixed(1)} КБ\n` +
                  `Фактов: ${state.facts?.length || 0}\n` +
                  `Последняя инициатива: ${lastInit}\n` +
                  `Модель: DeepSeek V4 Flash`;
      ctx.waitUntil(sendTelegram(env, chatId, msg));
    } catch (e) { ctx.waitUntil(sendTelegram(env, chatId, "Ошибка при получении статуса.")); }
    return;
  }

  // === ЭКСПОРТ ===
  if (text === "/export") {
    try {
      ctx.waitUntil(sendTelegram(env, chatId, "📦 Собираю архив..."));
      const files = [];
      const prefixes = ["core/", "self/", "diary/", "library/"];

      for (const prefix of prefixes) {
        const list = await env.FILES_BUCKET.list({ prefix });
        for (const obj of list.objects) {
          if (obj.size > 0) {
            const file = await env.FILES_BUCKET.get(obj.key);
            if (file) {
              const content = await file.text();
              files.push({ key: obj.key, content });
            }
          }
        }
      }

      const stateObj = await env.FILES_BUCKET.get("state.json");
      if (stateObj) {
        files.push({ key: "state.json", content: await stateObj.text() });
      }

      let dump = "# ЭКСПОРТ ПАМЯТИ СОФИИ\n\n";
      dump += `Дата: ${formatMinskTime(new Date())}\n\n`;

      for (const f of files) {
        dump += `## ${f.key}\n\n${f.content}\n\n---\n\n`;
      }

      const formData = new FormData();
      formData.append("chat_id", chatId);
      formData.append("document", new Blob([dump], { type: "text/plain" }), `sofia_export_${Date.now()}.txt`);

      await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, {
        method: "POST",
        body: formData
      });

    } catch (e) { 
      ctx.waitUntil(sendTelegram(env, chatId, `Ошибка экспорта: ${e.message}`)); 
    }
    return;
  }

  if (state.frozen?.status) {
    ctx.waitUntil(sendTelegram(env, chatId, "Я заморожена. Напиши /unfreeze."));
    return;
  }

  // ==========================================
  // СБОР КОНТЕКСТА
  // ==========================================
  let context = "";
  context += getMessageTimeBlock(message) + "\n\n";
  context += getDateTimeBlock() + "\n\n";

  if (state.facts && state.facts.length > 0) {
    context += `=== ЧТО ТЫ ЗНАЕШЬ О СОБЕСЕДНИКЕ ===\n`;
    state.facts.forEach(f => { context += `- ${f.fact}\n`; });
    context += `\n`;
  }

  console.log("[Context] Собираю личностный контекст (MD)...");
  const personalityContext = await buildPersonalityContext(env);
  if (personalityContext) {
    context += personalityContext;
    console.log("[Context] Личностный контекст добавлен:", personalityContext.length, "символов");
  }

  if (state.history && state.history.length > 0) {
    context += `=== ИСТОРИЯ ДИАЛОГА (последние сообщения) ===\n`;
    for (const h of state.history) {
      context += `${h.role === 'user' ? 'Эон' : 'София'}: ${h.text}\n`;
    }
    context += `\n`;
  }

  const lowerText = text.toLowerCase();
  if (lowerText.includes("что там") || lowerText.includes("прочти") || lowerText.includes("что в файле") || lowerText.includes("что внутри") || lowerText.includes("открой")) {
    let lastFile = state.lastUploadedSlug && state.lastUploadedFolder
      ? { folder: state.lastUploadedFolder, slug: state.lastUploadedSlug }
      : null;

    if (!lastFile) lastFile = await getLastUploadedFile(env);

    if (lastFile) {
      try {
        const obj = await env.FILES_BUCKET.get(`library/${lastFile.folder}/${lastFile.slug}/original.txt`);
        if (obj) {
          const buffer = await obj.arrayBuffer();
          let content = "";
          try {
            content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
          } catch (e) {
            content = new TextDecoder("windows-1251").decode(buffer);
          }
          context += `=== СОДЕРЖИМОЕ ПОСЛЕДНЕГО ЗАГРУЖЕННОГО ФАЙЛА (${lastFile.slug}) ===\n${content.slice(0, 6000)}...\n=== КОНЕЦ ===\n\n`;
          console.log("[Smart Read] Добавлен контекст из последнего файла:", lastFile.slug);
        }
      } catch (e) { console.error("[Smart Read Error]", e); }
    }
  }

  // === RAG-ПОИСК ПО КНИГАМ ===
  const ragContext = await searchBooksRAG(env, text);
  if (ragContext) {
    context += ragContext + "\n\n";
    console.log("[Context] RAG-контекст добавлен:", ragContext.length, "символов");
  }

  // === ПОИСК ПО АРХИВУ (TXT) ===
  if (text.length > 5) {
    console.log("[TXT Search] Ищу по txt-файлам:", text);
    const foundContext = await searchInTxtFiles(env, text);
    if (foundContext) {
      context += foundContext + "\n\n";
      console.log("[TXT Search] Найдено контекста:", foundContext.length, "символов");
    } else {
      context += `=== НАЙДЕНО В TXT-ФАЙЛАХ ===\n(По запросу "${text}" ничего не найдено)\n=== КОНЕЦ ===\n\n`;
    }
  }

  if (lowerText.includes("поищи") || lowerText.includes("ищи") || lowerText.includes("найди") || lowerText.includes("поиск")) {
    let query = text.replace(/поищи|ищи|найди|поиск/gi, "").trim();
    if (query.length < 3) query = text;
    console.log("[WebSearch] Ищу:", query);
    const webResult = await searchWeb(env, query);
    if (webResult) context += `=== РЕЗУЛЬТАТЫ ПОИСКА В ИНТЕРНЕТЕ ===\n${webResult}\n=== КОНЕЦ РЕЗУЛЬТАТОВ ===\n\n`;
  }

  console.log("[Context Final] Длина контекста:", context.length);

  // === ДИАЛОГ ===
  ctx.waitUntil(sendTelegram(env, chatId, "⏳ Секунду..."));
  
  let rawAnswer;
  try {
    rawAnswer = await callLLM(env, text, context);
  } catch (llmError) {
    console.error("[HandleMessage LLM Error]", llmError);
    rawAnswer = `<thought>Что-то пошло не так на уровне сети.</thought>\n\nПрости, милый. У меня произошел сбой. Попробуй написать еще раз.`;
  }

  if (!rawAnswer || rawAnswer.trim() === "") {
    rawAnswer = `<thought>Я не смогла сформулировать ответ. Надо просто сказать, что я здесь.</thought>\n\nЯ здесь. Просто задумалась. Напиши еще раз?`;
  }

  // === ОБРАБОТКА ФАЙЛОВЫХ ТЕГОВ ===
  const fileResult = await processFileTags(env, rawAnswer);
  rawAnswer = fileResult.cleanAnswer;

  if (fileResult.fileStatus) {
    console.log("[File Status]", fileResult.fileStatus);
  }

  // === СТАНДАРТНЫЕ ОБРАБОТЧИКИ ===
  const searchRegex = /\[SEARCH:\s*([^\]]+)\]/i;
  const searchMatch = rawAnswer.match(searchRegex);

  if (searchMatch) {
    const query = searchMatch[1].trim();
    console.log("[Auto-Search]", query);
    ctx.waitUntil(sendTelegram(env, chatId, `🔍 _Ищу: ${query}_...`));

    try {
      const searchResult = await searchWeb(env, query);
      let finalAnswer = rawAnswer.replace(searchRegex, "").trim();

      if (searchResult) {
        const followUpPrompt = `Вот результаты поиска по запросу "${query}":\n\n${searchResult}\n\nОтветь на основе этих данных. Кратко, 2-5 предложений.`;
        finalAnswer = await callLLM(env, followUpPrompt, context);
      } else {
        finalAnswer = `Я искала "${query}", но ничего конкретного не нашла. Может, попробуем другой запрос?`;
      }
      rawAnswer = finalAnswer;
    } catch (searchError) {
      console.error("[Search Error]", searchError);
      rawAnswer = rawAnswer.replace(searchRegex, "").trim();
    }
  }

  const factMatch = rawAnswer.match(/\[FACT:\s*(.*?)\]/);
  if (factMatch) {
      const fact = factMatch[1].trim();
      rawAnswer = rawAnswer.replace(/\[FACT:.*?\]/g, '').trim();
      if (!state.facts) state.facts = [];
      if (!state.facts.some(f => f.fact.includes(fact) || fact.includes(f.fact))) {
          state.facts.push({ fact: fact, date: new Date().toISOString() });
          await saveState(env, state);
      }
  }

  if (!state.history) state.history = [];
  state.history.push({ role: "user", text: text });
  state.history.push({ role: "assistant", text: rawAnswer });

  if (state.history.length > 20) {
    state.history = state.history.slice(-20);
  }
  await saveState(env, state);

  // === РАЗДЕЛЯЕМ МЫСЛИ И ОТВЕТ ===
  const { thoughts, answer } = splitThoughts(rawAnswer);

  if (thoughts) {
    await sendTelegram(env, chatId, formatThoughtsBlock(thoughts));
  }

  const finalAnswer = answer.trim() || "Я здесь. 🤍";
  await sendTelegram(env, chatId, finalAnswer);
}

async function handleCallback(query, env) {
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: query.id })
  });
  if (query.data === "unfreeze") {
    let state = await getState(env) || {};
    state.frozen = { status: false };
    await saveState(env, state);
    await sendTelegram(env, query.message.chat.id, "Я снова здесь. 💜");
  }
}

async function sendTelegram(env, chatId, text, options = {}) {
  if (!env.BOT_TOKEN) return;

  if (text.length <= 4000) {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "HTML", ...options })
    });
    return;
  }

  const parts = [];
  for (let i = 0; i < text.length; i += 4000) {
    parts.push(text.slice(i, i + 4000));
  }

  for (let i = 0; i < parts.length; i++) {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: parts[i], parse_mode: "HTML", ...options })
    });
  }
}
