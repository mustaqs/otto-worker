/**
 * The `otto-tasks` header and the KV summary it is composed from (SPEC.md
 * A82). PURE: no bindings, no fetch, no logging. ONE COMPOSER FOR EVERY
 * SENDER — the six task routes, /v1/tool and /v1/integrations (from D1) and
 * the question path (from the KV copy) all call tasksHeader(); two
 * compositions of one header would drift the day one gained a field.
 *
 * Grammar: fields `;`-separated, `key=value`, parts `:`-joined, sentences
 * percent-encoded and cut at 240 characters before encoding.
 *
 *   otto-tasks: v=1;running=1;awaiting=1;unseen=2;t=<id>:<state>:<type>;…;q=<id>:<sentence>;s=<id>:<sentence>
 *
 * ABSENT MEANS NO INFORMATION. PRESENT WITH ZEROS MEANS NONE. On tool, panel
 * and task replies it is always present; on the question reply only when the
 * KV key exists, and the app must not read absence as "no tasks".
 */
export const SUMMARY_VERSION = 1;
export const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired"]);
const MAX_LISTED = 8;
const MAX_SENTENCE = 240;

/** A fixed sentence for a task that did not end with a result. The reason word, never the request. */
export function endedSentence(type, state, reason) {
  const name = type === "research" ? "The research" : "The task";
  if (state === "cancelled" && reason === "declined") return `${name} stopped because you said no.`;
  if (state === "cancelled") return `${name} was cancelled.`;
  if (state === "expired") return `${name} waited too long for an answer and stopped.`;
  if (reason === "max_duration") return `${name} ran out of time.`;
  return `${name} failed partway.`;
}

/**
 * The KV summary, a PROJECTION of the account's rows — recomputed whole on
 * every transition, never incremented, so two writers cannot drift it.
 */
export function summaryFromRows(rows, now = Date.now()) {
  const sorted = (rows || []).slice().sort((a, b) => (Number(b.updated_at) || 0) - (Number(a.updated_at) || 0));
  const running = [], awaiting = [], unseen = [];
  for (const row of sorted) {
    if (row.state === "awaiting_approval") {
      const question = parse(row.question) || {};
      awaiting.push({ id: row.id, type: row.type, q: cut(question.spoken), until: Number(question.until) || 0 });
    } else if (TERMINAL.has(row.state)) {
      if (row.seen_at == null) {
        const result = parse(row.result) || {};
        const spoken = row.state === "succeeded" && result.spoken ? result.spoken : endedSentence(row.type, row.state, row.reason);
        unseen.push({ id: row.id, type: row.type, state: row.state, s: cut(spoken) });
      }
    } else {
      running.push({ id: row.id, type: row.type, state: row.state });
    }
  }
  return {
    v: SUMMARY_VERSION,
    at: now,
    running: running.slice(0, MAX_LISTED),
    awaiting: awaiting.slice(0, MAX_LISTED),
    unseen: unseen.slice(0, MAX_LISTED),
  };
}

/** The header from a summary. Always an object with the one header, so a caller can spread it. */
export function tasksHeader(summary) {
  const s = summary && typeof summary === "object" ? summary : { running: [], awaiting: [], unseen: [] };
  const running = Array.isArray(s.running) ? s.running : [];
  const awaiting = Array.isArray(s.awaiting) ? s.awaiting : [];
  const unseen = Array.isArray(s.unseen) ? s.unseen : [];
  const fields = [
    `v=${SUMMARY_VERSION}`,
    `running=${running.length}`,
    `awaiting=${awaiting.length}`,
    `unseen=${unseen.length}`,
  ];
  const listed = [
    ...awaiting.map((t) => ({ id: t.id, state: "awaiting_approval", type: t.type })),
    ...running.map((t) => ({ id: t.id, state: t.state || "running", type: t.type })),
    ...unseen.map((t) => ({ id: t.id, state: t.state, type: t.type })),
  ].slice(0, MAX_LISTED);
  for (const t of listed) fields.push(`t=${safe(t.id)}:${safe(t.state)}:${safe(t.type)}`);
  const question = awaiting[awaiting.length - 1]; // the oldest awaiting: the list is newest first
  if (question && question.q) fields.push(`q=${safe(question.id)}:${encode(question.q)}`);
  for (const t of unseen.slice(0, 2)) if (t.s) fields.push(`s=${safe(t.id)}:${encode(t.s)}`);
  return { "otto-tasks": fields.join(";") };
}

function parse(json) {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}
const cut = (text) => String(text || "").slice(0, MAX_SENTENCE);
const encode = (text) => encodeURIComponent(cut(text));
const safe = (part) => String(part || "").replace(/[^A-Za-z0-9_-]/g, "");
