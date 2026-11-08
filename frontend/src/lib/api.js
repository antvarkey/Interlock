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
  state: (jobStart) => call(`state${jobStart ? `?job_start_s=${jobStart}` : ""}`),
  prewarning: (plan) => call("prewarning", plan),
  simulate: (plan) => call("simulate", plan),
  parity: (sequences, bug = null) => call("parity", { sequences, bug }),
  ask: (question) => call("ask", { question }),
};

/** Ask the backend for the root cause analysis document and save it. */
export async function downloadReport(body) {
  const res = await fetch("/api/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`report failed (${res.status})`);
  const blob = await res.blob();
  const name = (res.headers.get("content-disposition") || "").match(/filename="([^"]+)"/)?.[1] || `interlock-rca.${body.format}`;
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return name;
}
