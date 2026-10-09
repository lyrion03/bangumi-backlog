import type { SearchFilters, Subject } from './domain';
import { YEAR_MAX } from './year-range';
export function quarterRange(f: SearchFilters) {
  if (!/^[1-9]\d{3}$/.test(f.quarterYear) || !['all', '1', '4', '7', '10'].includes(f.quarter))
    return null;
  const year = Number(f.quarterYear),
    month = f.quarter === 'all' ? 1 : Number(f.quarter);
  return {
    from: f.quarterYear + '-' + String(month).padStart(2, '0') + '-01',
    until:
      String(month === 10 || f.quarter === 'all' ? year + 1 : year) +
      '-' +
      String(month === 10 || f.quarter === 'all' ? 1 : month + 3).padStart(2, '0') +
      '-01',
  };
}
export function matchesQuarter(subject: Subject, filters: SearchFilters) {
  const range = quarterRange(filters);
  return (
    !range ||
    (/^\d{4}-\d{2}-\d{2}$/.test(subject.date) &&
      subject.date >= range.from &&
      subject.date < range.until)
  );
}
const choices = [
  ['all', '不限季度', '全年 · 1–12月'],
  ['1', '1月番', '1–3月'],
  ['4', '4月番', '4–6月'],
  ['7', '7月番', '7–9月'],
  ['10', '10月番', '10–12月'],
];
const input = (id: string) => document.querySelector<HTMLInputElement>('#' + id)!;
let draftYear = '';
export function seasonPicker() {
  return (
    '<div class="quarter-filter"><span>季度专选</span><input type="hidden" id="quarter-year" value=""><input type="hidden" id="quarter" value=""><div class="season-anchor"><button type="button" id="season-trigger" class="season-trigger" data-action="season-toggle" aria-expanded="false" aria-controls="season-menu"><span id="season-label">选择年份 / 季度</span><svg class="season-chevron" aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button type="button" id="season-clear" class="season-clear" data-action="season-clear" aria-label="清空季度专选" hidden>×</button><div id="season-menu" class="season-menu" role="group" aria-label="年份与季度选择" hidden><div class="season-years"><div class="season-column-label">选择年份</div><div id="season-years" class="season-year-list">' +
    Array.from({ length: YEAR_MAX - 1899 }, (_, i) => YEAR_MAX - i)
      .map(
        (y) =>
          '<button type="button" data-action="season-year" data-year="' +
          y +
          '" aria-pressed="false">' +
          y +
          ' 年<span aria-hidden="true">›</span></button>',
      )
      .join('') +
    '</div></div><div class="season-quarters"><div id="season-quarter-title" class="season-column-label">选择季度</div><div id="season-quarters"></div></div></div></div></div>'
  );
}
export function closeQuarterMenu() {
  document.querySelector<HTMLElement>('#season-menu')!.hidden = true;
  document.querySelector('#season-trigger')!.setAttribute('aria-expanded', 'false');
}
export function selectQuarterYear(year: string) {
  if (!/^[1-9]\d{3}$/.test(year)) return;
  draftYear = year;
  document
    .querySelectorAll<HTMLElement>('[data-action="season-year"]')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.year === year)));
  document.querySelector('#season-quarter-title')!.textContent = year + ' 年 · 选择季度';
  document.querySelector('#season-quarters')!.innerHTML = choices
    .map(
      ([value, label, note]) =>
        '<button type="button" data-action="season-quarter" data-quarter="' +
        value +
        '" aria-label="' +
        label +
        '" aria-pressed="' +
        (input('quarter-year').value === year && input('quarter').value === value) +
        '"><strong>' +
        label +
        '</strong><small>' +
        note +
        '</small><span aria-hidden="true">✓</span></button>',
    )
    .join('');
}
export function toggleQuarterMenu() {
  const menu = document.querySelector<HTMLElement>('#season-menu')!;
  if (!menu.hidden) return closeQuarterMenu();
  menu.hidden = false;
  document.querySelector('#season-trigger')!.setAttribute('aria-expanded', 'true');
  selectQuarterYear(input('quarter-year').value || String(new Date().getFullYear()));
  const selected = document.querySelector<HTMLElement>(
    '[data-action="season-year"][aria-pressed="true"]',
  )!;
  selected.parentElement!.scrollTop = selected.offsetTop - selected.parentElement!.offsetTop - 72;
  selected.focus({ preventScroll: true });
}
export function commitQuarter(quarter: string) {
  if (!choices.some(([v]) => v === quarter) || !draftYear) return;
  input('quarter-year').value = draftYear;
  input('quarter').value = quarter;
  closeQuarterMenu();
  updateQuarterControls();
  document.querySelector<HTMLElement>('#season-trigger')!.focus({ preventScroll: true });
}
export function clearQuarter() {
  input('quarter-year').value = '';
  input('quarter').value = '';
  closeQuarterMenu();
  updateQuarterControls();
  document.querySelector<HTMLElement>('#season-trigger')!.focus({ preventScroll: true });
}
export function updateQuarterControls() {
  const year = input('quarter-year').value,
    quarter = input('quarter').value;
  const active = !!year && !!quarter;
  const group = document.querySelector<HTMLElement>('.year-filter')!;
  group.classList.toggle('disabled', active);
  group.setAttribute('aria-disabled', String(active));
  group.title = active ? '已启用季度专选，清空后恢复年份范围' : '';
  for (const id of ['year-from', 'year-to']) input(id).disabled = active;
  document.querySelector('.quarter-filter')!.classList.toggle('active', active);
  document.querySelector('#season-label')!.textContent = active
    ? year + '年 · ' + choices.find(([v]) => v === quarter)?.[1]
    : '选择年份 / 季度';
  document.querySelector<HTMLElement>('#season-clear')!.hidden = !active;
  closeQuarterMenu();
}
