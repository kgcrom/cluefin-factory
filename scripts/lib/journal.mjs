import { readFileSync } from 'node:fs';
import { JSON_SCHEMA, load } from 'js-yaml';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Split a journal entry into its YAML frontmatter and body.
 * Returns null when the file has no frontmatter block at all.
 */
export function splitEntry(text) {
  const match = text.match(FRONTMATTER);
  if (!match) return null;
  return { frontmatter: match[1], body: text.slice(match[0].length) };
}

/**
 * Parse frontmatter with the JSON schema so that `2026-06-19` stays a string
 * instead of becoming a Date — the decision schema types every date as a string,
 * and a silent Date here turns into a spurious validation error.
 */
export function parseFrontmatter(frontmatter) {
  return load(frontmatter, { schema: JSON_SCHEMA });
}

export function readEntry(path) {
  const text = readFileSync(path, 'utf8');
  const parts = splitEntry(text);
  if (!parts) return { path, error: 'frontmatter 블록이 없다' };
  try {
    return { path, text, ...parts, data: parseFrontmatter(parts.frontmatter) };
  } catch (cause) {
    return { path, text, ...parts, error: `frontmatter YAML 파싱 실패: ${cause.message}` };
  }
}
