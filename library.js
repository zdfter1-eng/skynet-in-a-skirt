// ==========================================
// РАСПОЗНАВАНИЕ РЕЧИ (Whisper через REST API)
// ==========================================
export async function transcribeVoice(env, audioBuffer) {
  try {
    console.log("[WHISPER] buffer size:", audioBuffer.byteLength);

    if (!audioBuffer || audioBuffer.byteLength === 0) {
      console.error("[WHISPER] empty buffer");
      return "";
    }

    if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
      console.error("[WHISPER] CF_ACCOUNT_ID or CF_API_TOKEN missing!");
      return "";
    }

    const bytes = new Uint8Array(audioBuffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64Audio = btoa(binary);
    console.log("[WHISPER] base64 length:", base64Audio.length);

    const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/@cf/openai/whisper-large-v3-turbo`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        audio: base64Audio,
        task: "transcribe",
      }),
    });

    console.log("[WHISPER] REST status:", res.status);

    if (!res.ok) {
      const errText = await res.text();
      console.error("[WHISPER] REST error:", errText.slice(0, 300));
      return "";
    }

    const data = await res.json();
    return data.result?.text || data.text || "";
  } catch (e) {
    console.error("[WHISPER] ERROR:", e.message);
    return "";
  }
}

// ==========================================
// ПОИСК В ИНТЕРНЕТЕ (через workers-firecrawl)
// ==========================================
export async function searchWeb(env, query) {
  try {
    console.log("[WebSearch] Ищу:", query);
    
    if (env.FIRECRAWL) {
      console.log("[WebSearch] Использую Service Binding FIRECRAWL");
      const res = await env.FIRECRAWL.fetch("https://workers-firecrawl/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query })
      });

      if (!res.ok) {
        console.error("[WebSearch] Ошибка через Binding:", res.status);
        return "";
      }

      const data = await res.json();
      if (data.success && data.data && data.data.length > 0) {
        let text = "";
        for (let i = 0; i < Math.min(data.data.length, 3); i++) {
          const item = data.data[i];
          text += `${i + 1}. ${item.title}\n${item.description}\n${item.url}\n\n`;
        }
        console.log("[WebSearch] Найдено (Binding):", data.data.length);
        return text.trim();
      }
      return "";
    }

    console.log("[WebSearch] Binding нет, использую обычный fetch");
    const res = await fetch("https://workers-firecrawl.v7624875.workers.dev/search", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "User-Agent": "Sofia-Bot/1.0"
      },
      body: JSON.stringify({ query: query })
    });

    if (!res.ok) {
      console.error("[WebSearch] Ошибка HTTP:", res.status);
      return "";
    }

    const data = await res.json();
    if (data.success && data.data && data.data.length > 0) {
      let text = "";
      for (let i = 0; i < Math.min(data.data.length, 3); i++) {
        const item = data.data[i];
        text += `${i + 1}. ${item.title}\n${item.description}\n${item.url}\n\n`;
      }
      console.log("[WebSearch] Найдено (Fetch):", data.data.length);
      return text.trim();
    }
    return "";
  } catch (e) {
    console.error("[WebSearch Error]", e);
    return "";
  }
}

// ==========================================
// ОБРАБОТКА ЗАГРУЖЕННЫХ ФАЙЛОВ (с разделением на archive/books)
// ==========================================
export async function processUploadedFile(env, fileBuffer, fileName, mimeType) {
  try {
    // Определяем, куда сохранять
    const lowerName = fileName.toLowerCase();
    let folder = "books"; // по умолчанию — книги
    
    // Если в имени есть признаки архива — сохраняем в archive
    if (lowerName.includes("архив") || 
        lowerName.includes("воспоминания") || 
        lowerName.includes("диалог") || 
        lowerName.includes("вера") || 
        lowerName.includes("1_txt") ||
        lowerName.includes("история")) {
      folder = "archive";
    }
    
    const slug = "file_" + Date.now();
    const basePath = `library/${folder}/${slug}`;
    
    // Сохраняем оригинал
    await env.FILES_BUCKET.put(`${basePath}/original.txt`, fileBuffer);
    
    let textContent = "";
    if (mimeType === "text/plain" || fileName.endsWith(".txt") || fileName.endsWith(".md") || fileName.endsWith(".TXT")) {
        textContent = await new Response(fileBuffer).text();
    } else {
        textContent = "[Бинарный файл]";
    }

    // Создаем выжимку
    let extract = "Выжимка не создана.";
    if (textContent.length > 100) {
        const chunk = textContent.slice(0, 4000); 
        const prompt = folder === "books" 
          ? `Сделай подробную выжимку этой книги (главные идеи, персонажи, ключевые цитаты). Текст:\n\n${chunk}`
          : `Сделай краткую выжимку этого текста (темы, люди, ключевые мысли). Текст:\n\n${chunk}`;
        
        const { callLLM } = await import('./llm.js');
        extract = await callLLM(env, "athena", prompt);
    }

    // Сохраняем выжимку
    await env.FILES_BUCKET.put(`${basePath}/extract.md`, `# Выжимка: ${fileName}\n\n${extract}`);
    
    // Сохраняем метаданные
    await env.FILES_BUCKET.put(`${basePath}/meta.json`, JSON.stringify({ 
      originalName: fileName, 
      folder: folder,
      uploadedAt: new Date().toISOString()
    }));

    // Записываем в D1 (если нужно для статистики)
    try {
        await env.DB.prepare(
            "INSERT INTO files (key, updated_at, size) VALUES (?, ?, ?)"
        ).bind(basePath, new Date().toISOString(), fileBuffer.byteLength || 0).run();
    } catch (e) {
        console.error("[D1 Error]", e);
    }

    return { success: true, slug, folder, extract };
  } catch (e) {
    console.error("[Library Error]", e);
    return { success: false, error: e.message };
  }
}