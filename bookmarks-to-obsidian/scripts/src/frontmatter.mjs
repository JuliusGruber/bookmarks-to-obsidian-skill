// Build Web-Clipper-parity YAML frontmatter from extracted metadata.

/** Split an author string on commas, " and ", and ampersands. */
export function splitAuthors(str) {
  if (!str || typeof str !== 'string') return [];
  return str
    .split(/\s*,\s*|\s+and\s+|\s*&\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Normalize a date string to YYYY-MM-DD, or null if unparseable. */
export function normalizeDate(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

// A double-quoted YAML scalar. JSON string syntax is a valid subset of YAML's
// double-quoted style, so JSON.stringify gives correct escaping of quotes,
// backslashes, and control chars while leaving unicode (e.g. ö) intact.
function yamlDQ(str) {
  return JSON.stringify(String(str ?? ''));
}

/**
 * Build the frontmatter block (including the surrounding `---` lines and a
 * trailing newline). Authors are pre-split; published is pre-normalized.
 * Absent author/published/description keys are omitted entirely.
 */
export function buildFrontmatter({
  title,
  source,
  authors = [],
  published = null,
  description = '',
  created,
  tags = ['clippings', 'bookmark-import'],
}) {
  const lines = ['---'];
  lines.push(`title: ${yamlDQ(title)}`);
  lines.push(`source: ${yamlDQ(source)}`);
  if (authors && authors.length) {
    lines.push('author:');
    for (const a of authors) lines.push(`  - ${yamlDQ(`[[${a}]]`)}`);
  }
  if (published) lines.push(`published: ${published}`);
  lines.push(`created: ${created}`);
  lines.push('tags:');
  for (const t of tags) lines.push(`  - ${yamlDQ(t)}`);
  if (description) lines.push(`description: ${yamlDQ(description)}`);
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}
