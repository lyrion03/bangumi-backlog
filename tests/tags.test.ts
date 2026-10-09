import { it, expect } from 'vitest';
import { defaults, normalize, matchesTags, hasSignificantTag } from '../src/domain';
it('requires both a minimum vote count and share of the strongest tag', () => {
  const subject = normalize({
    id: 1,
    tags: [
      { name: '科幻', count: 100 },
      { name: '恋爱', count: 1 },
      { name: '悬疑', count: 20 },
    ],
  });
  expect(hasSignificantTag(subject, '恋爱')).toBe(false);
  expect(hasSignificantTag(subject, '悬疑')).toBe(true);
  expect(matchesTags(subject, { ...defaults(), excluded: ['恋爱'] })).toBe(true);
  expect(matchesTags(subject, { ...defaults(), tags: ['恋爱'] })).toBe(false);
  expect(matchesTags(subject, { ...defaults(), excluded: ['科幻'] })).toBe(false);
});
it('does not treat global tag counts or uncounted legacy tags as subject evidence', () => {
  expect(
    hasSignificantTag(
      normalize({ id: 1, tags: [{ name: '恋爱', count: 2, total_count: 900000 }] }),
      '恋爱',
    ),
  ).toBe(false);
  expect(hasSignificantTag(normalize({ id: 1, tags: ['恋爱'] }), '恋爱')).toBe(false);
});
it('preserves counts through storage normalization and applies the fixed 10 percent boundary', () => {
  const s = normalize({
    id: 1,
    tags: [
      { name: '科幻', count: 100 },
      { name: '恋爱', count: 40 },
      { name: '恋爱', count: 30 },
    ],
  });
  expect(normalize(s).tagVotes).toEqual(s.tagVotes);
  expect(hasSignificantTag(s, '恋爱')).toBe(true);
  expect(
    hasSignificantTag(
      normalize({
        id: 2,
        tags: [
          { name: 'TV', count: 100 },
          { name: '音乐', count: 10 },
        ],
      }),
      '音乐',
    ),
  ).toBe(true);
  expect(
    hasSignificantTag(
      normalize({
        id: 3,
        tags: [
          { name: 'TV', count: 101 },
          { name: '音乐', count: 10 },
        ],
      }),
      '音乐',
    ),
  ).toBe(false);
  expect(hasSignificantTag(normalize({ id: 4, tags: [{ name: '音乐', count: 9 }] }), '音乐')).toBe(
    false,
  );
});
