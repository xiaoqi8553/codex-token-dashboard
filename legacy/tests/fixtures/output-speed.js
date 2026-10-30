const event = (type, payload, timestamp = "2026-10-19T08:00:00Z") => ({ type, timestamp, payload });
const request = (turn, response, output) => event("token_usage_record", { session_id: "speed-session", turn_id: turn, response_id: response, usage: { input_tokens: 100, output_tokens: output, total_tokens: 100 + output } });
const events = [
  event("session_meta", { id: "speed-session", model_provider: "openai" }),
  event("turn_context", { turn_id: "one", model: "speed-model" }),
  request("one", "r1", 30), request("one", "r2", 70), request("one", "r2", 70),
  event("event_msg", { type: "task_complete", turn_id: "one", duration_ms: 10000, time_to_first_token_ms: 2000 }, "2026-10-19T08:00:10Z"),
  event("turn_context", { turn_id: "two", model: "speed-model" }),
  request("two", "r3", 20),
  event("event_msg", { type: "task_complete", turn_id: "two", duration_ms: 1000, time_to_first_token_ms: 0 }, "2026-10-19T08:01:01Z")
];
const speedFixture = { name: "completed turn speed metadata", events, text: events.map(item => JSON.stringify(item)).join("\n"), expected: 420 };
module.exports = { speedFixture };
