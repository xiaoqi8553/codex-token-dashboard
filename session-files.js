// Transport/file selection only. Token parsing and source attribution remain unchanged.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CodexSessionFiles = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  const compressed = name => /\.jsonl\.zst$/i.test(name);
  const supported = name => /\.(jsonl|json|log|txt)$/i.test(name) || compressed(name);
  const archived = name => /(^|[\\/])archived_sessions([\\/]|$)/i.test(name);
  function select(entries, pathOf) {
    const selected = new Map();
    for (const entry of entries) {
      const path = String(pathOf(entry)).replace(/\\/g, "/");
      if (!supported(path)) continue;
      const basename = path.split("/").pop();
      // A rollout moved to archives or replaced with a compressed copy is one file.
      const key = /^rollout-.*\.jsonl(?:\.zst)?$/i.test(basename) ? basename.replace(/\.zst$/i, "") : path.replace(/\.zst$/i, "");
      const priority = (archived(path) ? 0 : 2) + (compressed(path) ? 0 : 1);
      if (!selected.has(key) || priority > selected.get(key).priority) selected.set(key, { entry, priority });
    }
    return [...selected.values()].map(item => item.entry);
  }
  function stats(entries, pathOf) {
    return { compressedFiles: entries.filter(entry => compressed(pathOf(entry))).length, archivedFiles: entries.filter(entry => archived(pathOf(entry))).length };
  }
  return { compressed, supported, archived, select, stats };
});
