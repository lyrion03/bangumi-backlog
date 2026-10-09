import { expect, it, vi } from 'vitest';
import { defaults, normalize } from '../src/domain';
import { quarterRange, matchesQuarter } from '../src/season';
import { Api } from '../src/api';
it.each([
  ['1', '2024-01-01', '2024-03-31', '2024-04-01'],
  ['4', '2024-04-01', '2024-06-30', '2024-07-01'],
  ['7', '2024-07-01', '2024-09-30', '2024-10-01'],
  ['10', '2024-10-01', '2024-12-31', '2025-01-01'],
])(
  'quarter %s includes its full three months and excludes next-quarter and unknown dates',
  (quarter, from, last, until) => {
    const filters = { ...defaults(), quarterYear: '2024', quarter, from: '2010', to: '2012' };
    expect(quarterRange(filters)).toEqual({ from, until });
    for (const date of [from, last])
      expect(matchesQuarter(normalize({ date }), filters)).toBe(true);
    for (const date of [until, '2023-12-31', '', '2024-00-00'])
      expect(matchesQuarter(normalize({ date }), filters)).toBe(false);
  },
);
it.each(['heat', 'rank', 'match'])(
  'search sort %s applies season bounds instead of the disabled year range',
  async (sort) => {
    const api = new Api(0);
    const request = vi.spyOn(api, 'request').mockResolvedValue({
      total: 3,
      data: [
        { id: 1, date: '2024-04-01', rating: { rank: 1 } },
        { id: 2, date: '2024-06-30', rating: { rank: 2 } },
        { id: 3, date: '2024-07-01', rating: { rank: 3 } },
      ],
    });
    const result = await api.search({
      ...defaults(),
      keyword: sort === 'match' ? '测试' : '',
      sort,
      quarterYear: '2024',
      quarter: '4',
      from: '2010',
      to: '2012',
    });
    expect(request.mock.calls[0][0]).toBe('POST');
    expect(request.mock.calls[0][2]).toMatchObject({
      filter: { air_date: ['>=2024-04-01', '<2024-07-01'] },
    });
    expect(result.data.map((s) => s.id)).toEqual([1, 2]);
  },
);
it.each(['hide', 'only', 'all'])(
  'catalog mode %s filters quarter locally and requests only its year',
  async (nsfw) => {
    const api = new Api(0);
    api.token = 'fixture';
    const request = vi.spyOn(api, 'request').mockResolvedValue({
      total: 2,
      data: [
        { id: 1, date: '2024-10-01', nsfw: nsfw === 'only' },
        { id: 2, date: '2025-01-01', nsfw: nsfw === 'only' },
      ],
    });
    const result = await api.search({
      ...defaults(),
      sort: 'date',
      nsfw,
      quarterYear: '2024',
      quarter: '10',
    });
    expect(request.mock.calls[0][1]).toContain('&year=2024');
    expect(result.data.map((s) => s.id)).toEqual([1]);
  },
);
it('disabled quarter does not restrict dates', () => {
  expect(quarterRange(defaults())).toBeNull();
  expect(matchesQuarter(normalize({ date: '' }), defaults())).toBe(true);
});

it('defaults to empty and all quarters selects exactly one whole year', () => {
  expect(defaults()).toMatchObject({ quarterYear: '', quarter: '' });
  const filters = { ...defaults(), quarterYear: '2024', quarter: 'all', from: '2010', to: '2012' };
  expect(quarterRange(filters)).toEqual({ from: '2024-01-01', until: '2025-01-01' });
  for (const date of ['2024-01-01', '2024-04-01', '2024-07-01', '2024-12-31'])
    expect(matchesQuarter(normalize({ date }), filters)).toBe(true);
  for (const date of ['2023-12-31', '2025-01-01', ''])
    expect(matchesQuarter(normalize({ date }), filters)).toBe(false);
});
