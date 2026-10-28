import { describe, expect, it } from 'vitest';

import { talkLinkAuthorizes } from './talkLink';

const TOKEN = 'a'.repeat(32);

describe('talkLinkAuthorizes', () => {
  it('accepts only linktalk://talk with this install token', () => {
    expect(talkLinkAuthorizes(`linktalk://talk?token=${TOKEN}`, TOKEN)).toBe(true);
    expect(talkLinkAuthorizes('linktalk://talk', TOKEN)).toBe(false);
    expect(talkLinkAuthorizes('linktalk://talk?token=other', TOKEN)).toBe(false);
    expect(talkLinkAuthorizes(`https://example.com/talk?token=${TOKEN}`, TOKEN)).toBe(false);
    expect(talkLinkAuthorizes(`linktalk://talk?token=${TOKEN}`, null)).toBe(false);
  });
});
