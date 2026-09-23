const usage = total => ({ input_tokens: total - 20, cached_input_tokens: 0, output_tokens: 20, total_tokens: total, reasoning_output_tokens: 0 });
const add = (...items) => Object.fromEntries(Object.keys(items[0]).map(key => [key, items.reduce((s, u) => s + u[key], 0)]));
const request = (u, id, options = {}) => ({ type: "token_usage_record", timestamp: "2026-09-09T08:00:00Z", payload: { session_id: "fixture", response_id: id, usage: u, ...options } });
const count = (total, last, options = {}) => ({ type: "event_msg", timestamp: "2026-09-09T08:00:02Z", payload: { type: "token_count", info: { ...(total ? { total_token_usage: total } : {}), ...(last ? { last_token_usage: last } : {}) }, ...options } });
const a = usage(100), b = usage(150), total = add(a, b);
const cases = [
  { name: "PR example: duplicate representations", expected: 13865, events: [request(usage(13865), "one"), count(usage(13865), usage(13865))] },
  { name: "independent increasing requests", expected: 250, events: [request(a, "one"), request(b, "two")] },
  { name: "legacy last usage", expected: 250, events: [count(a, a), count(total, b)] },
  { name: "legacy cumulative only", expected: 250, events: [count(a), count(total)] },
  { name: "legacy then modern in the same session", expected: 250, events: [count(a, a), request(b, "two"), count(total, b)] },
  { name: "modern then legacy in the same session", expected: 250, events: [request(a, "one"), count(a, a), count(total, b)] },
  { name: "equal usage from distinct requests", expected: 200, events: [request(a, "one"), count(a, a), request(a, "two"), count(add(a, a), a)] },
  { name: "equal requests without ids", expected: 200, events: [request(a, ""), request(a, "")] },
  { name: "replayed response id", expected: 100, events: [request(a, "one"), count(a, a), request(a, "one")] },
  { name: "identified mirror still advances the baseline", expected: 200, events: [request(a, "one"), count(a, a, { response_id: "one" }), count(add(a, a), a)] },
  { name: "repeated token_count status", expected: 250, events: [count(a, a), count(a, a), count(total, b), count(total, b)] },
  { name: "multiple requests before cumulative update", expected: 250, events: [request(a, "one"), request(b, "two"), count(total)] },
  { name: "partially covered cumulative interval", expected: 250, events: [request(a, "one"), count(total)] },
  { name: "reverse order with explicit response identity", expected: 100, events: [count(a, a, { response_id: "one" }), request(a, "one")] },
  { name: "same values in different sessions", expected: 200, events: [request(a, "one", { session_id: "other" }), count(a, a)] },
  { name: "same values in different turns", expected: 200, events: [request(a, "one", { turn_id: "first" }), count(a, a, { turn_id: "second" })] },
  { name: "different explicit request ids", expected: 200, events: [request(a, "one"), count(a, a, { response_id: "two" })] },
  { name: "cumulative reset", expected: 310, events: [count(total), count(usage(60), usage(60))] },
  { name: "request counters do not change legacy baseline", expected: 250, events: [count(a), request(b, "two"), count(total)] },
  { name: "generic usage remains supported", expected: 250, events: [{ usage: a }, { usage: b }] },
  { name: "last usage without cumulative", expected: 250, events: [count(null, a), count(null, b)] },
  { name: "cached and reasoning fields agree", expected: 100, events: [request({ ...a, cached_input_tokens: 50, reasoning_output_tokens: 10 }, "one"), count({ ...a, cached_input_tokens: 50, reasoning_output_tokens: 10 }, { ...a, cached_input_tokens: 50, reasoning_output_tokens: 10 })] }
];
const fixtures = cases.map(item => ({ ...item, text: [
  { type: "session_meta", timestamp: "2026-09-09T08:00:00Z", payload: { id: "fixture", model_provider: "openai", cwd: "C:/synthetic/project" } },
  ...item.events
].map(JSON.stringify).join("\n") }));
module.exports = { fixtures, usage, add, request, count };
