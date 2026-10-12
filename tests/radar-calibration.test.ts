import { it, expect } from 'vitest';
import fixtures from './fixtures/radar-subjects.json';
import { features, metadata } from '../src/radar-score';
// Curated public examples check direction, not population percentiles or an objective ranking.
const now = Date.parse('2026-10-10');
const score = (id: number, axis: number) =>
  features(metadata(fixtures.subjects.find((s) => s.id === id)), now)[axis]!;
it('recognizes philosophical/experimental expression without awarding staff-name tags', () => {
  expect(score(4188, 0)).toBeGreaterThan(score(1014, 0) + 30); // Angel’s Egg / Index
  expect(score(321, 0)).toBeGreaterThan(score(364450, 0) + 40); // Patlabor 2 / Lycoris
  expect(score(237, 0)).toBeGreaterThan(65);
});
it('distinguishes disturbing content from warm daily-life shows', () => {
  expect(score(211311, 2)).toBeGreaterThan(85); // Devilman Crybaby
  expect(score(839, 2)).toBeGreaterThan(60); // Perfect Blue
  expect(score(843, 2)).toBeGreaterThan(50); // Paranoia Agent
  expect(score(207195, 2)).toBeLessThan(15); // Yuru Camp
  expect(score(207195, 3)).toBeGreaterThan(score(211311, 3) + 35);
});
it('keeps public popularity separate from acclaim and disturbing themes', () => {
  expect(score(32318, 1)).toBeGreaterThan(score(160209, 1) + 40); // Polar Bear Cafe / Your Name
  expect(score(93739, 0)).toBeGreaterThan(40); // Ping Pong
  for (const raw of fixtures.subjects)
    for (const v of features(metadata(raw), now))
      if (v !== null) expect(v >= 0 && v <= 100 && Number.isFinite(v)).toBe(true);
});
