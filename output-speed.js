// Completed-turn throughput. This never changes token accounting or infers streaming speed.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CodexOutputSpeed = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";
  const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
  const scalar = value => typeof value === "string" || typeof value === "number" ? String(value) : "";
  const key = (session, turn) => JSON.stringify([session || "", turn || ""]);

  function timingFields(raw) {
    const duration = positive(raw.turnDurationMs);
    const output = positive(raw.turnOutputTokens);
    const completed = Date.parse(raw.turnCompletedAt || "");
    if (!duration || !output || !Number.isFinite(completed) || !Number.isFinite(output * 1000 / duration)) return {};
    const first = raw.timeToFirstTokenMs;
    return {
      turnDurationMs: duration,
      turnOutputTokens: output,
      turnCompletedAt: new Date(completed).toISOString(),
      timeToFirstTokenMs: first !== null && first !== undefined && Number.isFinite(Number(first)) && Number(first) >= 0 && Number(first) <= duration ? Number(first) : null,
      turnModel: typeof raw.turnModel === "string" ? raw.turnModel : "unknown"
    };
  }

  function createCollector() {
    const completed = new Map();
    return {
      observe(item, context) {
        const payload = item?.payload;
        if (item?.type !== "event_msg" || payload?.type !== "task_complete") return;
        const turn = scalar(payload.turn_id) || scalar(context.turnId);
        const duration = positive(payload.duration_ms);
        const time = Date.parse(item.timestamp || "");
        if (!turn || !duration || !Number.isFinite(time)) return;
        completed.set(key(context.sessionId, turn), { turnDurationMs: duration, turnCompletedAt: new Date(time).toISOString(), timeToFirstTokenMs: payload.time_to_first_token_ms });
      },
      apply(records) {
        const groups = new Map();
        for (const record of records) {
          if (!record.turnId || record.estimated) continue;
          const id = key(record.sessionId, record.turnId);
          if (!groups.has(id)) groups.set(id, []);
          groups.get(id).push(record);
        }
        for (const [id, rows] of groups) {
          const timing = completed.get(id);
          if (!timing) continue;
          const models = [...new Set(rows.map(row => row.model || "unknown"))];
          const fields = timingFields({ ...timing, turnOutputTokens: rows.reduce((sum, row) => sum + positive(row.outputTokens), 0), turnModel: models.length === 1 ? models[0] : "混合模型" });
          for (const row of rows) Object.assign(row, fields);
        }
      }
    };
  }

  function summarize(records) {
    const turns = new Map();
    let missingRecords = 0;
    for (const row of records) {
      if (!positive(row.outputTokens)) continue;
      const fields = timingFields(row);
      if (row.estimated || !row.turnId || !fields.turnDurationMs) { missingRecords += 1; continue; }
      const id = key(row.sessionId, row.turnId);
      if (!turns.has(id)) turns.set(id, { ...fields, sessionId: row.sessionId, turnId: row.turnId, tps: fields.turnOutputTokens * 1000 / fields.turnDurationMs });
    }
    const samples = [...turns.values()].sort((a, b) => a.turnCompletedAt.localeCompare(b.turnCompletedAt));
    const duration = samples.reduce((sum, row) => sum + row.turnDurationMs, 0);
    const output = samples.reduce((sum, row) => sum + row.turnOutputTokens, 0);
    const waits = samples.map(row => row.timeToFirstTokenMs).filter(value => value !== null).sort((a, b) => a - b);
    const middle = Math.floor(waits.length / 2);
    return { samples, latest: samples.at(-1) || null, weightedTps: duration ? output * 1000 / duration : null, medianFirstTokenMs: waits.length ? (waits[middle] + waits[Math.floor((waits.length - 1) / 2)]) / 2 : null, missingRecords };
  }
  return { createCollector, timingFields, summarize };
});
