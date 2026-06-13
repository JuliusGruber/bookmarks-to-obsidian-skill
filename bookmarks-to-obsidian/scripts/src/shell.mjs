// Detect whether an extracted body is really a consent wall, paywall/subscribe
// interstitial, or a "please enable JavaScript" shell rather than an article.
// Pure and deliberately simple: curated EN+DE phrases + a length/density rule.
// Used by the pick-the-better step to disqualify a bad render or fetch.

const SHELL_PHRASES = [
  // English — consent / cookies
  'we value your privacy', 'this site uses cookies', 'we use cookies',
  'accept all cookies', 'accept cookies', 'cookie policy', 'manage your privacy',
  'manage cookies', 'privacy preferences',
  // English — paywall / auth
  'subscribe to continue', 'subscribe to read', 'create a free account',
  'sign in to continue', 'log in to continue', 'continue reading',
  'to read the full', 'register to continue',
  // English — JS shell
  'enable javascript', 'please enable javascript', 'javascript is required',
  'javascript is disabled',
  // German — consent / cookies
  'wir schätzen ihre privatsphäre', 'diese seite verwendet cookies',
  'wir verwenden cookies', 'alle akzeptieren', 'cookies akzeptieren',
  'datenschutzeinstellungen', 'privatsphäre-einstellungen', 'cookie-einstellungen',
  // German — paywall / auth
  'jetzt abonnieren', 'um weiterzulesen', 'anmelden um weiterzulesen',
  'registrieren um', 'um fortzufahren',
  // German — JS shell
  'bitte aktivieren sie javascript', 'javascript aktivieren',
];

/**
 * True when `text` looks like a consent/paywall/JS shell rather than an article.
 * Rules: short text with ANY marker is a shell; otherwise, only flag when markers
 * are dense relative to length (a long article that mentions "cookie" once passes).
 */
export function looksLikeShell(text, { minWords = 200 } = {}) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return false;
  const words = t.split(/\s+/).filter(Boolean).length;
  let hits = 0;
  for (const p of SHELL_PHRASES) if (t.includes(p)) hits += 1;
  if (hits === 0) return false;
  if (words < minWords) return true;            // short + any marker → shell
  return hits >= 3 && words < minWords * 3;     // marker-dense in not-much-text → shell
}
