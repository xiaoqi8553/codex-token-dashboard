// One accounting policy for Node scans and browser imports. No I/O or source attribution.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CodexUsageAccounting = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";
  const version = 19;
  const fields = ["inputTokens", "cachedInputTokens", "outputTokens", "totalTokens", "reasoningOutputTokens"];
  const number = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const scalar = value => typeof value === "string" || typeof value === "number" ? String(value) : "";
  const equal = (a, b) => fields.every(key => a[key] === b[key]);
  const nonzero = tokens => fields.some(key => tokens[key] > 0);
  const difference = (a, b) => Object.fromEntries(fields.map(key => [key, Math.max(0, a[key] - b[key])]));
  const sum = items => Object.fromEntries(fields.map(key => [key, items.reduce((total, item) => total + item.tokens[key], 0)]));

  function tokens(raw) {
    const inputTokens = number(raw.input_tokens ?? raw.prompt_tokens ?? raw.input);
    const outputTokens = number(raw.output_tokens ?? raw.completion_tokens ?? raw.output);
    return {
      inputTokens,
      cachedInputTokens: number(raw.cached_input_tokens ?? raw.cached_tokens ?? raw.cache_read_input_tokens),
      outputTokens,
      totalTokens: number(raw.total_tokens ?? raw.tokens ?? (inputTokens + outputTokens)),
      reasoningOutputTokens: number(raw.reasoning_output_tokens ?? raw.reasoning_tokens)
    };
  }

  function extract(item) {
    if (!item || typeof item !== "object") return null;
    const payload = item.payload && typeof item.payload === "object" ? item.payload : item;
    const info = payload.info || payload;
    const request = item.type === "token_usage_record";
    const raw = request ? payload.usage : (info.total_token_usage || info.usage || info.token_usage || info);
    if (!raw || typeof raw !== "object") return null;
    const last = !request && (info.last_token_usage || payload.last_token_usage);
    const cumulative = !request && info.total_token_usage ? tokens(info.total_token_usage) : null;
    const value = tokens(raw);
    const lastTokens = last && typeof last === "object" ? tokens(last) : null;
    if (!nonzero(value) && !nonzero(lastTokens || value)) return null;
    return {
      kind: request ? "request" : cumulative || lastTokens ? "count" : "generic",
      tokens: value, cumulative, lastTokens,
      requestId: scalar(payload.response_id || payload.request_id || payload.requestId),
      sessionId: scalar(payload.session_id || payload.thread_id),
      turnId: scalar(payload.turn_id || payload.turnId)
    };
  }

  function createTracker() {
    const sessions = new Map();
    function select(usage, context = {}) {
      if (!usage) return null;
      if (usage.kind === "generic") return usage.tokens;
      const sessionId = usage.sessionId || scalar(context.sessionId);
      if (!sessions.has(sessionId)) sessions.set(sessionId, { previous: null, pending: [], ids: new Set() });
      const session = sessions.get(sessionId);
      const turnId = usage.turnId || scalar(context.turnId);
      const requestId = usage.requestId;
      const duplicateId = requestId && session.ids.has(requestId);
      if (requestId) session.ids.add(requestId);
      if (usage.kind === "request") {
        if (duplicateId) return null;
        session.pending.push({ tokens: usage.tokens, turnId, requestId });
        return usage.tokens; // A request is an increment, never a cumulative counter.
      }

      const previous = session.previous;
      const cumulative = usage.cumulative;
      // Status events can repeat last_token_usage without any new consumption.
      if (cumulative && previous && equal(cumulative, previous)) return null;
      const reset = cumulative && previous && cumulative.totalTokens < previous.totalTokens;
      const delta = cumulative && previous && !reset ? difference(cumulative, previous) : cumulative;
      if (cumulative) session.previous = cumulative;
      const selected = usage.lastTokens && nonzero(usage.lastTokens) ? usage.lastTokens : (delta || usage.tokens);
      const pending = session.pending;
      session.pending = [];
      if (duplicateId) return null; // Still advance the cumulative baseline above.
      const compatible = pending.filter(entry => (!turnId || !entry.turnId || entry.turnId === turnId) &&
        (!requestId || !entry.requestId || entry.requestId === requestId));
      // Only reconcile the current cumulative interval in this session. Do not discard
      // all token_count events just because another part of the file uses new records.
      if (compatible.some(entry => equal(entry.tokens, selected))) return null;
      if (!usage.lastTokens && compatible.length) {
        const covered = sum(compatible);
        if (fields.every(key => covered[key] <= selected[key])) {
          const remaining = difference(selected, covered);
          return nonzero(remaining) ? remaining : null;
        }
      }
      return nonzero(selected) ? selected : null;
    }
    return { select };
  }

  return { version, extract, createTracker };
});
