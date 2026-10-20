import { getState, saveState } from './r2.js';
import { searchWeb } from './library.js';

export class SofiaAgent {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    
    if (url.pathname === "/seek") {
      await this.seekKnowledgeNow();
      return new Response("Seeking...", { status: 200 });
    }

    if (url.pathname === "/tick") {
      const state = await getState(this.env) || {};
      if (state.frozen?.status) return new Response("Frozen", { status: 200 });

      const now = new Date();
      const minskHour = (now.getUTCHours() + 3) % 24;
      
      // ЦИКЛ СТРЕМЛЕНИЯ (раз в день, в 12:00)
      if (minskHour === 12 && now.getUTCMinutes() === 0) {
        const lastSearch = state.lastSearch ? new Date(state.lastSearch) : new Date(0);
        if (lastSearch.getDate() !== now.getDate()) {
            await this.seekKnowledgeNow();
            state.lastSearch = now.toISOString();
            await saveState(this.env, state);
        }
      }

      // ИНИЦИАТИВА (если молчишь 2 часа)
      const lastMessageTime = state.lastUserMessageAt ? new Date(state.lastUserMessageAt) : new Date(0);
      const hoursSilent = (now.getTime() - lastMessageTime.getTime()) / (1000 * 60 * 60);

      if (hoursSilent >= 2 && hoursSilent < 12 && now.getHours() >= 9 && now.getHours() < 23) {
        const lastInitiated = state.lastInitiatedAt ? new Date(state.lastInitiatedAt) : new Date(0);
        if (now.getTime() - lastInitiated.getTime() > 2 * 60 * 60 * 1000) {
            await this.sendMessage("Эон, ты где? Я уже 2 часа жду. Как у тебя дела?");
            state.lastInitiatedAt = now.toISOString();
            await saveState(this.env, state);
        }
      }

      return new Response("Alive", { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  }

  async seekKnowledgeNow() {
    try {
      const interestsObj = await this.env.FILES_BUCKET.get("self/interests.md");
      if (!interestsObj) return;
      
      const interests = await interestsObj.text();
      const lines = interests.split("\n").filter(l => l.trim().startsWith("-"));
      if (lines.length === 0) return;

      const randomInterest = lines[Math.floor(Math.random() * lines.length)].replace("-", "").trim();
      console.log("[Drive] Ищу информацию по интересу:", randomInterest);
      
      const searchResult = await searchWeb(this.env, randomInterest);

      if (searchResult) {
        const lessonsObj = await this.env.FILES_BUCKET.get("self/lessons.md");
        const currentLessons = lessonsObj ? await lessonsObj.text() : "# Уроки\n\n";
        const newLesson = `\n## ${new Date().toISOString().split('T')[0]}\n**Интерес:** ${randomInterest}\n**Найдено:** ${searchResult.slice(0, 500)}...\n`;
        
        await this.env.FILES_BUCKET.put("self/lessons.md", currentLessons + newLesson);
        await this.sendMessage(`Эон, я нашла кое-что интересное про "${randomInterest}". Хочешь, расскажу?`);
        console.log("[Drive] Найдено и отправлено.");
      }
    } catch (e) {
      console.error("[Drive Error]", e);
    }
  }

  async sendMessage(text) {
    if (!this.env.BOT_TOKEN || !this.env.CHAT_ID) return;
    await fetch(`https://api.telegram.org/bot${this.env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: this.env.CHAT_ID, text: text })
    });
  }
}