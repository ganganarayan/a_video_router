// Pure routing logic — no DB/config imports so it is directly unit-testable.

function matches(rule, title) {
  const t = String(title || '');
  const p = String(rule.pattern || '');
  if (!p) return false;
  switch (rule.match_type) {
    case 'prefix':
      return t.toLowerCase().startsWith(p.toLowerCase());
    case 'regex':
      try {
        return new RegExp(p, 'i').test(t);
      } catch {
        return false;
      }
    case 'contains':
    default:
      return t.toLowerCase().includes(p.toLowerCase());
  }
}

// Picks the routing rule for a recording: enabled + source-compatible rules only,
// ordered by priority (lower number wins) then most-specific (longest pattern) first.
export function matchRule(rules, source, title) {
  const candidates = (rules || [])
    .filter((r) => r.enabled !== false)
    .filter((r) => !r.source || r.source === 'any' || r.source === source)
    .filter((r) => matches(r, title))
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || b.pattern.length - a.pattern.length);
  return candidates[0] || null;
}

// YouTube title: keep_prefix=true keeps the meeting title as-is; false strips the
// matched tag (and adjacent separators) so only the rest of the title remains.
export function buildVideoTitle(title, matchedPattern, keepPrefix) {
  const t = String(title || '').trim();
  if (keepPrefix || !matchedPattern) return t;
  const idx = t.toLowerCase().indexOf(String(matchedPattern).toLowerCase());
  if (idx === -1) return t;
  const before = t.slice(0, idx);
  const after = t.slice(idx + matchedPattern.length);
  const stripped = `${before} ${after}`
    .replace(/^[\s\-–|:]+/, '')
    .replace(/[\s\-–|:]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return stripped || t;
}
