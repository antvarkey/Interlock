/* Thin client for the FastAPI backend (see backend/interlock/server.py). */
async function call(path, body) {
  const res = await fetch("/api/" + path, body === undefined ? undefined : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).detail || ""; } catch { /* not JSON */ }
    throw new Error(`${path} failed (${res.status}) ${detail}`.trim());
  }
  return res.json();
}

export const api = {
  state: () => call("state"),
  prewarning: (plan) => call("prewarning", plan),
  simulate: (plan) => call("simulate", plan),
  parity: (sequences, bug = null) => call("parity", { sequences, bug }),
  ask: (question) => call("ask", { question }),
  llmStatus: () => call("llm/status"),
  llmTranslate: () => call("llm/translate", {}),
};
