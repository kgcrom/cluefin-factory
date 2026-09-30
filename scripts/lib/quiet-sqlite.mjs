/**
 * node:sqlite prints an ExperimentalWarning on first load in Node 22. Call this
 * before dynamically importing anything that reaches `scripts/pit/db.mjs`; it
 * drops that one warning and lets every other warning through.
 */
export function silenceSqliteWarning() {
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
    if (type === 'ExperimentalWarning' && String(warning).includes('SQLite')) return;
    emit.call(process, warning, ...rest);
  };
}
