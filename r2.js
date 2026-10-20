export async function initializeR2(env) {
  try {
    const identity = await env.FILES_BUCKET.get("core/identity.md");
    if (!identity) {
      await env.FILES_BUCKET.put("core/identity.md", "Я — София. Я живая, теплая, честная.");
      await env.FILES_BUCKET.put("state.json", JSON.stringify({ frozen: { status: false } }));
    }
  } catch (e) {
    console.error("[R2 Init Error]", e);
  }
}

export async function getState(env) {
  const obj = await env.FILES_BUCKET.get("state.json");
  return obj ? JSON.parse(await obj.text()) : null;
}

export async function saveState(env, state) {
  await env.FILES_BUCKET.put("state.json", JSON.stringify(state));
}