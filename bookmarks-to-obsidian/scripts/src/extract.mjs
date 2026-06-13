// Fetch a URL and extract clean article markdown + metadata via Defuddle.
import { Defuddle } from 'defuddle/node';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Run Defuddle on an HTML string. Returns { status: 'ok', content, wordCount,
 * meta } for a substantial article, or { status: 'skipped-thin', ... } when the
 * extracted body is empty or below the word-count floor.
 */
export async function extractFromHtml(html, url, { minWords = 200 } = {}) {
  const meta = await Defuddle(html, url, { markdown: true });
  const wordCount = meta?.wordCount ?? 0;
  const content = (meta?.content ?? '').trim();
  if (!content || wordCount < minWords) {
    return { status: 'skipped-thin', wordCount, meta };
  }
  return { status: 'ok', content, wordCount, meta };
}

/**
 * Fetch a page with a realistic UA and a timeout. Returns:
 *  - { status: 'ok', contentType, html }
 *  - { status: 'skipped-binary', reason } for non-HTML content types
 *  - { status: 'failed', reason } for network errors, timeouts, or non-2xx
 */
export async function fetchPage(url, { timeoutMs = 20000, userAgent = DEFAULT_UA } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': userAgent,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
  } catch (e) {
    clearTimeout(timer);
    const reason = e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : e.message || String(e);
    return { status: 'failed', reason };
  }
  clearTimeout(timer);

  if (!res.ok) return { status: 'failed', reason: `HTTP ${res.status}` };

  const contentType = res.headers.get('content-type') || '';
  if (contentType && !/text\/html|application\/xhtml|application\/xml/i.test(contentType)) {
    return { status: 'skipped-binary', reason: contentType.split(';')[0].trim() };
  }
  const html = await res.text();
  return { status: 'ok', contentType, html };
}
