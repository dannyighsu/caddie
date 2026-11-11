import type { TextMatch } from "../types.ts";

/** Returns null when the text satisfies every check, else why it didn't. Case-insensitive. */
export function matchText(text: string, m: TextMatch): string | null {
  const hay = text.toLowerCase();
  const has = (s: string) => hay.includes(s.toLowerCase());
  if (m.contains !== undefined && !has(m.contains)) return `missing "${m.contains}"`;
  if (m.contains_all) {
    const missing = m.contains_all.filter((s) => !has(s));
    if (missing.length) return `missing ${missing.map((s) => `"${s}"`).join(", ")}`;
  }
  if (m.contains_any && !m.contains_any.some(has)) {
    return `none of ${m.contains_any.map((s) => `"${s}"`).join(", ")}`;
  }
  if (m.not_contains) {
    const found = m.not_contains.filter(has);
    if (found.length) return `contains forbidden ${found.map((s) => `"${s}"`).join(", ")}`;
  }
  if (m.matches !== undefined && !new RegExp(m.matches, "i").test(text)) return `doesn't match /${m.matches}/`;
  if (m.not_matches !== undefined && new RegExp(m.not_matches, "i").test(text)) return `matches forbidden /${m.not_matches}/`;
  return null;
}
