import { describe, it, expect } from 'vitest';
import { looksLikeShell } from '../scripts/src/shell.mjs';

describe('looksLikeShell', () => {
  it('passes a normal long article with an incidental cookie mention', () => {
    const body = 'This article explains transformers in depth. '.repeat(60) +
      'We briefly note the site uses a cookie for preferences.';
    expect(looksLikeShell(body, { minWords: 200 })).toBe(false);
  });

  it('flags a short English consent wall', () => {
    const md = 'We value your privacy. This site uses cookies. Accept all cookies to continue.';
    expect(looksLikeShell(md, { minWords: 200 })).toBe(true);
  });

  it('flags a short German consent wall', () => {
    const md = 'Wir schätzen Ihre Privatsphäre. Diese Seite verwendet Cookies. Alle akzeptieren, um fortzufahren.';
    expect(looksLikeShell(md, { minWords: 200 })).toBe(true);
  });

  it('flags a JavaScript-required stub', () => {
    expect(looksLikeShell('Please enable JavaScript to continue.', { minWords: 200 })).toBe(true);
  });

  it('flags a wordy-but-marker-dense paywall pitch', () => {
    const md = ('Subscribe to continue reading. Create a free account. Sign in to continue. ' +
      'Subscribe to read the full story. ').repeat(6);
    expect(looksLikeShell(md, { minWords: 200 })).toBe(true);
  });

  it('returns false on empty input', () => {
    expect(looksLikeShell('', { minWords: 200 })).toBe(false);
  });
});
