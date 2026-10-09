export const YEAR_MIN = 1990;
export const YEAR_MAX = new Date().getFullYear() + 1;

export function updateYearRange(changed?: HTMLInputElement) {
  const from = document.querySelector<HTMLInputElement>('#year-from')!;
  const to = document.querySelector<HTMLInputElement>('#year-to')!;
  if (+from.value > +to.value) {
    if (changed === to) to.value = from.value;
    else from.value = to.value;
  }
  const start = +from.value;
  const end = +to.value;
  const full = start === YEAR_MIN && end === YEAR_MAX;
  const track = document.querySelector<HTMLElement>('.year-slider')!;
  track.style.setProperty('--year-start', ((start - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100 + '%');
  track.style.setProperty('--year-end', ((end - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100 + '%');
  // At the upper endpoint the start thumb must remain reachable to reopen the range.
  from.style.zIndex = start === YEAR_MAX ? '3' : '1';
  to.style.zIndex = '2';
  from.setAttribute('aria-valuetext', start + ' 年');
  to.setAttribute('aria-valuetext', end + ' 年');
  document.querySelector('#year-label')!.textContent = full
    ? '全部年份'
    : start === end
      ? start + ' 年'
      : start + ' – ' + end;
  return { from: full ? '' : from.value, to: full ? '' : to.value };
}
