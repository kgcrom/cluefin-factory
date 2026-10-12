/** `<command> --flag value …` → `{ command, flags }`, or `{ command, error }` for a bare or unpaired flag. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || rest[i + 1] === undefined) {
      return { command, error: `알 수 없는 인자 ${rest[i]}` };
    }
    flags[rest[i].slice(2)] = rest[i + 1];
  }
  return { command, flags };
}
