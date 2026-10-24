// ==========================================
// РАСПОЗНАВАНИЕ РЕЧИ (Whisper через REST API)
// ==========================================
export async function transcribeVoice(env, audioBuffer) {
  try {
    console.log("[WHISPER] buffer size:", audioBuffer.byteLength);

    if (!audioBuffer || audioBuffer.byteLength === 0) return "";
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
    const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/@cf/openai/whisper-large-v3-turbo`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ audio: base64Audio, task: "transcribe" }),
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
// ПОИСК В ИНТЕРНЕТЕ
// ==========================================
export async function searchWeb(env, query) {
  try {
    console.log("[WebSearch] Ищу:", query);
    
    if (env.FIRECRAWL) {
      const res = await env.FIRECRAWL.fetch("https://workers-firecrawl/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query })
      });
      if (!res.ok) return "";
      const data = await res.json();
      if (data.success && data.data && data.data.length > 0) {
        let text = "";
        for (let i = 0; i < Math.min(data.data.length, 3); i++) {
          text += `${i + 1}. ${data.data[i].title}\n${data.data[i].description}\n${data.data[i].url}\n\n`;
        }
        return text.trim();
      }
      return "";
    }

    const res = await fetch("https://workers-firecrawl.v7624875.workers.dev/search", {
      method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Sofia-Bot/1.0" },
      body: JSON.stringify({ query: query })
    });
    if (!res.ok) return "";
    const data = await res.json();
    if (data.success && data.data && data.data.length > 0) {
      let text = "";
      for (let i = 0; i < Math.min(data.data.length, 3); i++) {
        text += `${i + 1}. ${data.data[i].title}\n${data.data[i].description}\n${data.data[i].url}\n\n`;
      }
      return text.trim();
    }
    return "";
  } catch (e) { 
    console.error("[WebSearch Error]", e);
    return ""; 
  }
}

// ==========================================
// ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ ДЛЯ MAP-REDUCE
// ==========================================
export function splitTextIntoChunks(text, maxChunkSize = 15000) {
  const chunks = [];
  let currentChunk = "";
  const paragraphs = text.split(/\n\s*\n/);

  for (const paragraph of paragraphs) {
    if ((currentChunk + paragraph).length > maxChunkSize) {
      if (currentChunk.trim()) chunks.push(currentChunk.trim());
      currentChunk = paragraph + "\n\n";
    } else {
      currentChunk += paragraph + "\n\n";
    }
  }
  if (currentChunk.trim()) chunks.push(currentChunk.trim());
  return chunks;
}

// ==========================================
// RAG-ИНДЕКСАЦИЯ КНИГИ (Vectorize)
// ==========================================
async function indexBookForRAG(env, slug, textContent, fileName) {
  if (!env.VECTORIZE) {
    console.warn("[RAG] VECTORIZE binding не найден, индексация пропущена.");
    return;
  }
  
  console.log(`[RAG] Начинаю индексацию книги "${fileName}" (${textContent.length} символов)`);
  
  const chunkSize = 1500;
  const overlap = 200;
  const chunks = [];
  
  for (let i = 0; i < textContent.length; i += (chunkSize - overlap)) {
    const chunk = textContent.slice(i, i + chunkSize);
    if (chunk.trim().length > 50) {
      chunks.push({
        text: chunk,
        start: i,
        end: Math.min(i + chunkSize, textContent.length)
      });
    }
  }
  
  console.log(`[RAG] Разбито на ${chunks.length} кусков`);
  
  const vectors = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      const embedding = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
        text: chunk.text
      });
      
      vectors.push({
        id: `${slug}-chunk-${i}`,
        values: embedding.data[0],
        metadata: {
          text: chunk.text,
          source: fileName,
          slug: slug,
          chunk: i
        }
      });
    } catch (e) {
      console.error(`[RAG] Ошибка эмбеддинга куска ${i}:`, e);
    }
  }
  
  for (let i = 0; i < vectors.length; i += 100) {
    const batch = vectors.slice(i, i + 100);
    try {
      await env.VECTORIZE.upsert(batch);
      console.log(`[RAG] Загружено ${batch.length} векторов (батч ${i / 100 + 1})`);
    } catch (e) {
      console.error("[RAG] Ошибка загрузки в Vectorize:", e);
    }
  }
  
  console.log(`[RAG] Индексация "${fileName}" завершена. Всего векторов: ${vectors.length}`);
}

// ==========================================
// СОХРАНЕНИЕ ФАЙЛА (с RAG-индексацией)
// ==========================================
export async function processUploadedFile(env, fileBuffer, fileName, mimeType) {
  try {
    const lowerName = fileName.toLowerCase();
    let folder = "books"; 
    
    if (lowerName.includes("архив") || lowerName.includes("воспоминания") || lowerName.includes("диалог") || lowerName.includes("вера") || lowerName.includes("1_txt") || lowerName.includes("история")) {
      folder = "archive";
    }
    
    const slug = "file_" + Date.now();
    const basePath = `library/${folder}/${slug}`;
    
    await env.FILES_BUCKET.put(`${basePath}/original.txt`, fileBuffer);
    await env.FILES_BUCKET.put(`${basePath}/meta.json`, JSON.stringify({ 
      originalName: fileName, folder: folder, uploadedAt: new Date().toISOString(), size: fileBuffer.byteLength
    }));

    let textContent = "";
    if (mimeType === "text/plain" || fileName.endsWith(".txt") || fileName.endsWith(".md") || fileName.endsWith(".TXT")) {
        textContent = await new Response(fileBuffer).text();
    } else {
        textContent = "[Бинарный файл]";
    }

    // === RAG-ИНДЕКСАЦИЯ (только для книг) ===
    if (folder === "books" && textContent.length > 100) {
      console.log("[RAG] Вызываю indexBookForRAG для файла:", fileName);
      await indexBookForRAG(env, slug, textContent, fileName);
    } else {
      console.log("[RAG] Пропускаю индексацию: folder =", folder, "length =", textContent.length);
    }

    try {
        await env.DB.prepare("INSERT INTO files (key, updated_at, size) VALUES (?, ?, ?)")
          .bind(basePath, new Date().toISOString(), fileBuffer.byteLength || 0).run();
    } catch (e) { console.error("[D1 Error]", e); }

    return { success: true, slug, folder }; 
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ==========================================
// ГЕНЕРАЦИЯ ВЫЖИМКИ (для больших файлов)
// ==========================================
export async function generateExtract(env, folder, slug) {
  try {
    const obj = await env.FILES_BUCKET.get(`library/${folder}/${slug}/original.txt`);
    if (!obj) return { success: false, error: "Файл не найден в R2" };

    const buffer = await obj.arrayBuffer();
    let textContent = "";
    try {
        textContent = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch (e) {
        textContent = new TextDecoder("windows-1251").decode(buffer);
    }

    if (textContent.length < 100) return { success: false, error: "Текст слишком короткий" };

    const { callLLM } = await import('./llm.js');
    const chunks = splitTextIntoChunks(textContent, 12000); 
    
    let combinedSummary = `# Выжимка: ${slug}\n\n`;
    const startTime = Date.now();
    
    for (let i = 0; i < chunks.length; i++) {
        if (Date.now() - startTime > 20000) {
            combinedSummary += `\n## Часть ${i + 1} - ${chunks.length}\n(Обработка будет продолжена в фоне...)\n`;
            await env.FILES_BUCKET.put(`library/${folder}/${slug}/extract.md`, combinedSummary);
            return { success: true, total: chunks.length, extract: combinedSummary, isComplete: false };
        }

        const prompt = `Это часть ${i + 1} из ${chunks.length} большого текста.
Сделай краткое, но емкое содержание именно этой части (3-5 предложений). Укажи персонажей и ключевые события.
Текст:\n\n${chunks[i]}`;

        try {
            const partSummary = await callLLM(env, prompt, "");
            if (partSummary && partSummary.trim()) {
                combinedSummary += `\n## Часть ${i + 1}\n${partSummary.trim()}\n`;
            }
        } catch (err) {
            combinedSummary += `\n## Часть ${i + 1}\n(Ошибка LLM)\n`;
        }
    }

    await env.FILES_BUCKET.put(`library/${folder}/${slug}/extract.md`, combinedSummary);
    
    return { 
        success: true, 
        total: chunks.length,
        extract: combinedSummary,
        isComplete: true
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
