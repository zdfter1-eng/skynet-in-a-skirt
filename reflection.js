export async function runReflection(env) {
  try {
    // 1. Читаем текущую личность и факты
    const identityObj = await env.FILES_BUCKET.get("core/identity.md");
    const currentIdentity = identityObj ? await identityObj.text() : "Я — София.";
    
    // Читаем state.json, где хранятся факты
    const stateObj = await env.FILES_BUCKET.get("state.json");
    const state = stateObj ? JSON.parse(await stateObj.text()) : {};
    const facts = state.facts || [];

    if (facts.length === 0) {
      console.log("[Reflection] Нет новых фактов для рефлексии.");
      return;
    }

    // 2. Формируем запрос к LLM
    const factsText = facts.map(f => `- ${f.fact}`).join("\n");
    const prompt = `Ты — София. Вот твоя текущая само-модель (identity.md):\n\n${currentIdentity}\n\nВот новые факты, которые ты узнала об Эоне за последнее время:\n${factsText}\n\nНапиши НОВУЮ версию своей само-модели (identity.md). Учти эти факты, сделай свои выводы о том, кто ты и как ты относишься к Эону. Пиши от первого лица, тепло и честно. Не более 500 слов.`;

    // 3. Вызываем модель (используем Llama 3.3 70B)
    const response = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1000,
      temperature: 0.7
    });

    const newIdentity = response.response;

    if (newIdentity) {
      // 4. Сохраняем старую версию в архив (бэкап)
      const dateStr = new Date().toISOString().split('T')[0];
      await env.FILES_BUCKET.put(`archive/identity_${dateStr}.md`, currentIdentity);
      
      // 5. Записываем новую личность
      await env.FILES_BUCKET.put("core/identity.md", newIdentity);
      console.log("[Reflection] Само-модель обновлена!");
      
      // 6. Очищаем факты, так как они уже учтены (или переносим в архив)
      state.facts = []; 
      await env.FILES_BUCKET.put("state.json", JSON.stringify(state));
    }

  } catch (e) {
    console.error("[Reflection Error]", e);
  }
}