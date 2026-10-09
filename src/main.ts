import { preloadPosters } from './poster-preload';
import {
  matchesQuarter,
  updateQuarterControls,
  toggleQuarterMenu,
  selectQuarterYear,
  commitQuarter,
  clearQuarter,
  closeQuarterMenu,
} from './season';
import { createBackup } from './backup';
import { FilteredPager } from './filtered-pager';
import { updateYearRange } from './year-range';
import { TAG_GROUPS } from './tags';
import './style.css';
import { Api } from './api';
import { Store } from './store';
import { Sync, type ConflictChoice } from './sync';
import { collectSeries } from './series';
import { SeriesCache } from './series-cache';
import { prepareSeriesPage } from './series-preparation';
import {
  STATUS,
  defaults,
  title,
  aired,
  safeImage,
  matchesTags,
  type Subject,
  type Status,
  type User,
  type Episode,
  type Item,
} from './domain';
import {
  shell,
  icon,
  esc,
  card,
  empty,
  badge,
  image,
  toast,
  statusOptions,
  seriesSpotlight,
  seriesRow,
} from './ui';
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const store = new Store(localStorage);
const api = new Api();
const sync = new Sync(store, api);
const seriesCache = new SeriesCache(localStorage);
const realtimeIds = new Map<number, boolean>();
const cacheScope = () => (user ? `user-${user.id}` : 'public');
const filteredPager = new FilteredPager();
let totalExact = true;
let hiddenSignature = '';
let user: User | null = null;
let view = 'discover';
let filters = defaults();
let results: Subject[] = [];
let total = 0;
let loading = false;
let searchGeneration = 0;
let dialogGeneration = 0;
let selected = new Set<number>();
let hideHandled = false;
let recordStatus = 'all';
let recordPage = 1;
let confirmCallback: (() => void | Promise<void>) | null = null;
let dialogSubject: Subject | null = null;
let seriesEntries: Subject[] = [];
let seriesReturn: {
  nodes: Node[];
  entries: Subject[];
  scroll: number;
  revisions: Map<number, number | undefined>;
} | null = null;
const seriesMatches = new Map<number, boolean>();
let episodeTypes: Record<number, number> = {};
let episodeList: Episode[] = [];
let authBusy = false;
let exporting = false;
let realtimeTimer: ReturnType<typeof setTimeout>;
$('#app').innerHTML = shell();
const dialog = $<HTMLDialogElement>('#dialog');
function fail(error: unknown) {
  const message = error instanceof Error ? error.message : '操作失败，请重试';
  if (dialog.open) {
    let alert = dialog.querySelector<HTMLElement>('.dialog-error');
    if (!alert) {
      alert = document.createElement('p');
      alert.className = 'dialog-error notice error-text';
      alert.setAttribute('role', 'alert');
      dialog.prepend(alert);
    }
    alert.textContent = message;
  } else toast(message, true);
}
function run(task: () => void | Promise<void>) {
  Promise.resolve().then(task).catch(fail);
}
function checked(id: string) {
  return $<HTMLInputElement>(id).checked;
}
function value(id: string) {
  return $<HTMLInputElement>(id).value;
}
function acceptsSubject(s: Subject, f = filters) {
  return (
    store.get(s.id)?.status !== 'not_interested' &&
    (!hideHandled || !store.get(s.id)) &&
    s.score >= f.rating &&
    matchesTags(s, f) &&
    matchesQuarter(s, f)
  );
}
function visibleResults() {
  return results.filter((s) => acceptsSubject(s));
}
function hiddenKey() {
  return store
    .all()
    .filter((s) => hideHandled || s.status === 'not_interested')
    .map((s) => s.id)
    .sort((a, b) => a - b)
    .join(',');
}
function filteredPage(
  f: typeof filters,
  cancelled: () => boolean,
  ready: () => Promise<void> = async () => {},
  priority = 1,
) {
  const source = { ...f, page: 1, size: 20 };
  const key = JSON.stringify([cacheScope(), api.token, source]);
  return filteredPager.page(
    key,
    f.page,
    f.size,
    async (page) => {
      await ready();
      if (cancelled()) throw new DOMException('筛选已更新', 'AbortError');
      return api.search({ ...source, page }, priority);
    },
    (s) => acceptsSubject(s, f),
    cancelled,
    false,
    priority === 0 ? 6 : Infinity,
  );
}

function find(id: number) {
  return (
    results.find((s) => s.id === id) || store.get(id) || seriesEntries.find((s) => s.id === id)
  );
}
function showView(name: string) {
  if (!['discover', 'records', 'sync'].includes(name)) name = 'discover';
  view = name;
  document.querySelectorAll<HTMLElement>('.view').forEach((el) => (el.hidden = el.id !== name));
  document.querySelectorAll<HTMLButtonElement>('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === name);
    el.setAttribute('aria-current', el.dataset.view === name ? 'page' : 'false');
  });
  history.replaceState(null, '', `#${name}`);
  renderSelection();
  renderRecords();
  renderSync();
  window.scrollTo({ top: 0 });
}
function renderStats() {
  const items = store.all();
  const dirty = store.dirty().length;
  $('#nav-count').textContent = String(items.length);
  $('#nav-dirty').textContent = String(dirty);
  $('#nav-dirty').hidden = !dirty;
  $('#stat-total').innerHTML = `${items.length}<small>部</small>`;
  $('#stat-watched').innerHTML =
    `${items.filter((i) => i.status === 'collect').length}<small>部</small>`;
  $('#stat-dirty').innerHTML = `${dirty}<small>部</small>`;
  $<HTMLInputElement>('#realtime').checked = store.state.settings.realtime;
  $<HTMLInputElement>('#complete-episodes').checked = store.state.settings.completeEpisodes;
  $<HTMLInputElement>('#auto-next').checked = store.state.settings.autoNext;
}
function renderTags() {
  const expanded = document.querySelector<HTMLDetailsElement>('#tags details')?.open ?? false;
  const renderTag = (tag: string) =>
    `<span class="tag ${filters.tags.includes(tag) ? 'active' : ''} ${filters.excluded.includes(tag) ? 'excluded' : ''}"><button data-action="tag" data-tag="${tag}" aria-pressed="${filters.tags.includes(tag)}">${tag}</button><button data-action="exclude" data-tag="${tag}" aria-label="${filters.excluded.includes(tag) ? '取消屏蔽' : '屏蔽'}${tag}">${filters.excluded.includes(tag) ? '↺' : '×'}</button></span>`;
  const extras = TAG_GROUPS.slice(1);
  const extraSelected = extras
    .flatMap((g) => [...g.tags])
    .filter((tag) => filters.tags.includes(tag) || filters.excluded.includes(tag)).length;
  $('#tags').innerHTML =
    `<div class="tag-group"><span class="tag-group-label">常用</span><div class="tag-options">${TAG_GROUPS[0].tags.map(renderTag).join('')}</div></div><details class="more-tags" ${expanded || extraSelected ? 'open' : ''}><summary>更多标签 <span>题材 · 兴趣 · 氛围 · 原作${extraSelected ? ` · 已选 ${extraSelected}` : ''}</span></summary>${extras.map((group) => `<div class="tag-group"><span class="tag-group-label">${group.label}</span><div class="tag-options">${group.tags.map(renderTag).join('')}</div></div>`).join('')}</details>`;
}
function renderSelection() {
  const visible = visibleResults();
  const ids = new Set(visible.map((s) => s.id));
  selected = new Set([...selected].filter((id) => ids.has(id)));
  $('#batch-bar').hidden = !selected.size || view !== 'discover';
  document.body.classList.toggle('has-batch-selection', !!selected.size && view === 'discover');
  $('#selected-number').textContent = String(selected.size);
  const all = $<HTMLInputElement>('#select-page');
  all.checked = !!visible.length && selected.size === visible.length;
  all.indeterminate = selected.size > 0 && selected.size < visible.length;
  all.disabled = loading || !visible.length;
  $('#selection-hint').textContent = selected.size
    ? `已选择 ${selected.size} 部作品`
    : '支持多选，一次完成补标';
}
function renderGrid() {
  const visible = visibleResults();
  $('#grid').innerHTML = visible.length
    ? visible
        .map((s) =>
          card(
            s,
            store.get(s.id),
            selected.has(s.id),
            seriesMatches.get(s.id),
            !filters.keyword && filters.sort === 'rank',
          ),
        )
        .join('')
    : empty(
        '没有符合当前条件的作品',
        filters.nsfw === 'only'
          ? filters.keyword && filters.sort !== 'date'
            ? '当前搜索候选中没有符合条件的 NSFW 作品（官方关键词搜索最多返回 1000 个候选）。可调整关键词或筛选条件。'
            : '当前账号可读取的目录中没有符合条件的 NSFW 作品。可重置年份、评分和标签筛选，或关闭隐藏已整理；空结果不代表账号一定没有权限。'
          : filters.tags.length || filters.excluded.length
            ? '可检索候选中没有符合标签和记录状态条件的作品，可取消部分筛选条件。'
            : '可检索作品均已整理或不符合筛选条件，试试放宽筛选或关闭「隐藏已整理」。',
        '<button class="button secondary" data-action="reset">重置筛选</button>',
      );
  $('#results-title').textContent = filters.keyword
    ? `“${filters.keyword}” 的搜索结果`
    : '发现好动画';
  renderResultsCount();
  renderSelection();
  renderPager();
}
function renderResultsCount() {
  $('#results-count').textContent =
    `${totalExact ? '符合条件共' : '已找到至少'} ${total.toLocaleString()} 部 · 本页 ${visibleResults().length} 部${filters.nsfw === 'only' && filters.keyword && filters.sort !== 'date' ? '（最多检索 1000 个候选）' : ''}`;
}
function totalPages(size = filters.size) {
  return Math.max(1, Math.ceil(total / size) + (!totalExact && total % size === 0 ? 1 : 0));
}
function renderPager() {
  const pages = totalPages();
  $('#pager').innerHTML =
    `<span>第 ${filters.page} / ${pages}${totalExact ? '' : '+'} 页</span><button class="button square" data-action="prev" aria-label="上一页" ${loading || filters.page <= 1 ? 'disabled' : ''}>‹</button>${Array.from(
      new Set([
        1,
        ...[filters.page - 1, filters.page, filters.page + 1].filter((n) => n > 1 && n < pages),
        ...(pages > 1 ? [pages] : []),
      ]),
    )
      .map(
        (n, i, a) =>
          `${i && n - a[i - 1] > 1 ? '<span>…</span>' : ''}<button class="page-number ${n === filters.page ? 'active' : ''}" data-action="page" data-page="${n}" ${loading ? 'disabled' : ''}>${n}</button>`,
      )
      .join(
        '',
      )}<button class="button square" data-action="next" aria-label="下一页" ${loading || filters.page >= pages ? 'disabled' : ''}>›</button><form id="jump-form"><label>前往 <input aria-label="跳转页码" id="jump" type="number" min="1" max="${pages}" value="${filters.page}"> 页</label><button class="text-button" ${loading ? 'disabled' : ''}>跳转</button></form>`;
}
function updateSeriesHint(id: number, hasSeries: boolean) {
  seriesMatches.set(id, hasSeries);
  if (seriesMatches.size > 600) seriesMatches.delete(seriesMatches.keys().next().value!);
  const currentCard = document.querySelector<HTMLElement>(`.anime-card[data-id="${id}"]`);
  if (!currentCard) return;
  currentCard.querySelector<HTMLElement>('[data-series-slot]')!.innerHTML = seriesSpotlight(
    id,
    hasSeries,
  );
}
async function discoverSeries(generation: number) {
  const scope = cacheScope();
  const snapshot = structuredClone(filters);
  const cancelled = () => generation !== searchGeneration || scope !== cacheScope();
  const waitUntilReady = async () => {
    while (
      !cancelled() &&
      (dialog.open || sync.progress.active || authBusy || exporting || view !== 'discover')
    )
      await new Promise((resolve) => setTimeout(resolve, 250));
  };
  const prepare = (subjects: Subject[], pageNumber: number, probeOnly = false) =>
    prepareSeriesPage(api, seriesCache, scope, subjects, {
      priority: pageNumber === snapshot.page ? 1 : 0,
      probeOnly,
      cancelled,
      waitUntilReady,
      onHint: pageNumber === snapshot.page ? updateSeriesHint : () => {},
      onProgress: (phase, done, count, failed) => {
        if (cancelled()) return;
        $('#series-scan-status').textContent =
          `第 ${pageNumber} 页 · ${phase === 'probe' ? '发现系列' : '关联缓存'} ${done} / ${count}${failed ? ` · ${failed} 项可重试` : ''}`;
      },
    });
  let subjects = visibleResults().slice();
  let failed = false;
  let cachedThrough = snapshot.page;
  let probedThrough = snapshot.page;
  let postersThrough = snapshot.page;
  const report = (note = '') => {
    if (cancelled()) return;
    const parts = [`已缓存至第 ${cachedThrough} 页`];
    if (probedThrough > cachedThrough) parts.push(`已探查第 ${probedThrough} 页`);
    if (postersThrough > probedThrough) parts.push(`海报已准备至第 ${postersThrough} 页`);
    if (note) parts.push(note);
    else parts.push(failed ? '部分失败可重试' : '系列准备完成');
    $('#series-scan-status').textContent = parts.join(' · ');
  };
  for (let distance = 0; distance <= 3 && !cancelled(); distance++) {
    const pageNumber = snapshot.page + distance;
    if (distance) {
      // Keep sparse filters from scanning the entire catalog merely to fill the prefetch window.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await waitUntilReady();
      if (cancelled()) return;
      try {
        const nextPage = await filteredPage(
          { ...snapshot, page: pageNumber },
          cancelled,
          waitUntilReady,
          0,
        );
        if (cancelled()) return;
        // Extra IDs already supplied in a catalog chunk can expand totals at zero network cost.
        total = nextPage.total;
        totalExact = nextPage.exact;
        renderPager();
        renderResultsCount();
        if (!nextPage.filled) {
          report('已暂停预加载，切页时继续');
          return;
        }
        if (nextPage.page < pageNumber || !nextPage.data.length) {
          report();
          return;
        }
        subjects = nextPage.data;
      } catch {
        report('后续页将在切页时重试');
        return;
      }
    }
    if (distance <= 2) {
      const result = await prepare(subjects, pageNumber, distance === 2);
      if (cancelled()) return;
      failed ||= !!result?.failed;
      probedThrough = pageNumber;
      if (distance <= 1) cachedThrough = pageNumber;
    }
    if (distance) {
      await preloadPosters(subjects, cancelled, waitUntilReady);
      if (cancelled()) return;
      postersThrough = pageNumber;
    }
    report();
    if (totalExact && pageNumber >= totalPages(snapshot.size)) return;
  }
  // The official catalog/search APIs return full records, not an ID-only projection.
  // Do not fetch page n+4 onward just to increase an inexact page count.
}

async function search() {
  const generation = ++searchGeneration;
  $('#series-scan-status').textContent = '';
  loading = true;
  selected.clear();
  renderSelection();
  renderPager();
  $('#grid').setAttribute('aria-busy', 'true');
  $('#grid').innerHTML = Array.from(
    { length: filters.size },
    () => '<div class="skeleton-card"><div></div><span></span><span></span></div>',
  ).join('');
  $('#results-count').textContent = '加载中';
  try {
    hiddenSignature = hiddenKey();
    const page = await filteredPage(
      structuredClone(filters),
      () => generation !== searchGeneration,
    );
    if (generation !== searchGeneration) return;
    total = page.total;
    totalExact = page.exact;
    filters.page = page.page;
    results = page.data;
    seriesMatches.clear();
    for (const subject of results) {
      const hint = seriesCache.confirmedHint(cacheScope(), subject.id);
      if (hint !== undefined) seriesMatches.set(subject.id, hint);
    }
    loading = false;
    renderGrid();
    run(() => discoverSeries(generation));
  } catch (error) {
    if (generation !== searchGeneration) return;
    results = [];
    total = 0;
    totalExact = true;
    loading = false;
    $('#grid').innerHTML = empty(
      '暂时无法加载动画',
      (error as Error).message,
      '<button class="button primary" data-action="retry">重新加载</button>',
    );
    $('#results-count').textContent = '连接失败，已保存的记录仍可使用';
    renderPager();
    renderSelection();
  } finally {
    if (generation === searchGeneration) $('#grid').removeAttribute('aria-busy');
  }
}
function updateSortOptions() {
  const sort = $<HTMLSelectElement>('#sort');
  const heat = sort.querySelector<HTMLOptionElement>('option[value="heat"]')!;
  heat.hidden = value('#nsfw') === 'only' && !value('#keyword').trim();
  heat.disabled = heat.hidden;
  if (heat.hidden && sort.value === 'heat') sort.value = 'date';
  const match = sort.querySelector('option[value="match"]');
  if (value('#keyword').trim()) {
    if (!match) sort.add(new Option('匹配度', 'match'));
  } else {
    if (sort.value === 'match') sort.value = heat.hidden ? 'date' : 'heat';
    match?.remove();
  }
}
function readFilters() {
  updateSortOptions();
  const { from, to } = updateYearRange();
  updateQuarterControls();
  filters = {
    ...filters,
    keyword: value('#keyword').trim(),
    sort: value('#sort'),
    from: value('#quarter') ? '' : from,
    to: value('#quarter') ? '' : to,
    quarterYear: value('#quarter-year'),
    quarter: value('#quarter'),
    rating: +value('#rating'),
    nsfw: value('#nsfw'),
    page: 1,
  };
  run(search);
}
function resetFilters() {
  filters = defaults();
  $<HTMLFormElement>('#search-form').reset();
  updateYearRange();
  clearQuarter();
  updateSortOptions();
  $<HTMLSelectElement>('#page-size').value = '20';
  hideHandled = false;
  $<HTMLInputElement>('#hide-handled').checked = false;
  renderTags();
  run(search);
}
function changed() {
  renderStats();
  renderRecords();
  renderSync();
  const signature = hiddenKey();
  if (signature !== hiddenSignature) {
    hiddenSignature = signature;
    run(search);
  } else if (!loading) renderGrid();
}
store.onChange(changed);
function maybeRealtime(ids: number[] = [], reviewConflicts = false) {
  clearTimeout(realtimeTimer);
  if (!store.state.settings.realtime || !api.token) return;
  for (const id of ids)
    if (store.get(id)?.dirty && store.get(id)?.status !== 'not_interested')
      realtimeIds.set(id, reviewConflicts || realtimeIds.get(id) === true);
  if (!realtimeIds.size) return;
  realtimeTimer = setTimeout(() => {
    if (sync.progress.active || authBusy || exporting) {
      maybeRealtime();
      return;
    }
    const batch = [...realtimeIds.keys()];
    const needsReview = [...realtimeIds.values()].some(Boolean);
    realtimeIds.clear();
    run(async () => {
      await sync.push(batch, needsReview);
      if (!sync.wasCancelled) maybeRealtime();
    });
  }, 500);
}
function maybeAutoNext(pageSubjects: Subject[] = visibleResults()) {
  if (
    store.state.settings.autoNext &&
    view === 'discover' &&
    !loading &&
    pageSubjects.length > 0 &&
    pageSubjects.every((s) => !!store.get(s.id)) &&
    filters.page < totalPages()
  ) {
    filters.page++;
    run(search);
  }
}
function mark(
  subjects: Subject[],
  status: Status,
  patch: Partial<Pick<Item, 'rate' | 'comment' | 'private' | 'episodeChanges'>> = {},
  reviewConflicts = false,
) {
  // Capture before marking: hiding handled items or dismissing the last card can empty the page.
  const pageSubjects = visibleResults();
  store.mark(subjects, status, patch);
  toast(
    `已将 ${subjects.length} 部作品保存为「${STATUS[status].label}」${status === 'not_interested' ? '，仅本地生效' : ''}`,
  );
  maybeRealtime(
    subjects.map((s) => s.id),
    reviewConflicts,
  );
  if (subjects.some((subject) => pageSubjects.some((visible) => visible.id === subject.id)))
    maybeAutoNext(pageSubjects);
}
let pendingConflict: ((choice: ConflictChoice) => void) | null = null;
sync.onConflicts = (conflicts, mode) =>
  new Promise<ConflictChoice>((resolve) => {
    openDialog(
      '收藏状态冲突',
      `<p class="dialog-description">${mode === 'pull' ? '拉取' : '推送'}前发现 ${conflicts.length} 部作品的状态不同。以下选择统一应用于本批全部冲突；未同步的评分、短评和单集编辑仍会保留。${mode === 'pull' ? '保留本地的状态将列为待同步，不在本次拉取中写入云端。' : '采用云端状态的冲突条目本次不推送。'} </p><div class="conflict-list"><table><thead><tr><th>作品</th><th>本地状态</th><th>云端状态</th></tr></thead><tbody>${conflicts.map((c) => `<tr><td>${esc(title(c.local))}<small>#${c.local.id}</small></td><td>${esc(STATUS[c.local.status].label)}</td><td>${esc(STATUS[c.remoteStatus].label)}</td></tr>`).join('')}</tbody></table></div><div class="dialog-footer"><button class="text-button" data-action="close">取消本次同步</button><button class="button secondary" data-action="sync-choice" data-choice="remote">全部采用云端状态</button><button class="button primary" data-action="sync-choice" data-choice="local">全部保留本地状态</button></div>`,
      true,
    );
    pendingConflict = resolve;
  });
sync.onCancel = () => {
  if (pendingConflict) closeDialog();
};
let dialogPageScroll = 0;
function openDialog(heading: string, content: string, wide = false) {
  if (pendingConflict) closeDialog();
  if (!dialog.open) dialogPageScroll = window.scrollY;
  dialogGeneration++;
  seriesReturn = null;
  confirmCallback = null;
  dialog.classList.toggle('wide-dialog', wide);
  dialog.innerHTML = `<div class="dialog-header"><h2 id="dialog-title">${esc(heading)}</h2><button class="button square" data-action="close" aria-label="关闭弹窗">${icon('close')}</button></div>${content}`;
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
}
function closeDialog() {
  const resolve = pendingConflict;
  pendingConflict = null;
  resolve?.('cancel');
  seriesReturn = null;
  dialogGeneration++;
  confirmCallback = null;
  dialog.close();
  window.scrollTo({ top: dialogPageScroll, behavior: 'instant' });
}
function closeTopDialog() {
  if (!seriesReturn) return closeDialog();
  const previous = seriesReturn;
  seriesReturn = null;
  dialogGeneration++;
  confirmCallback = null;
  seriesEntries = previous.entries;
  dialog.replaceChildren(...previous.nodes);
  dialog.classList.add('wide-dialog');
  for (const subject of seriesEntries) {
    const row = dialog.querySelector<HTMLElement>(`[data-series-id="${subject.id}"]`);
    const item = store.get(subject.id);
    if (!row || previous.revisions.get(subject.id) === item?.revision) continue;
    row.querySelector<HTMLInputElement>('.series-select')!.checked = false;
    row.querySelector<HTMLElement>('.series-row-status')!.innerHTML = item
      ? badge(item.status)
      : '<small class="muted">待整理</small>';
    row
      .querySelectorAll<HTMLElement>('[data-status]')
      .forEach((button) =>
        button.setAttribute('aria-pressed', String(button.dataset.status === item?.status)),
      );
  }
  updateSeriesSelection();
  dialog.scrollTop = previous.scroll;
}
function confirm(
  heading: string,
  description: string,
  content: string,
  callback: () => void | Promise<void>,
  label = '确认操作',
) {
  openDialog(
    heading,
    `<p class="dialog-description">${esc(description)}</p>${content}<div class="dialog-footer"><button class="button secondary" data-action="close">取消</button><button class="button primary" data-action="confirm">${esc(label)}</button></div>`,
  );
  confirmCallback = callback;
}
function confirmBatch(subjects: Subject[], status: Status) {
  if (!subjects.length) return toast('请先选择作品');
  confirm(
    `批量标记 ${subjects.length} 部作品`,
    `将选中的作品设为「${STATUS[status].label}」。${store.state.settings.realtime && api.token && status !== 'not_interested' ? '自动推送已开启，保存后将同步到已连接账号。' : '保存到本地后，可在同步中心检查并推送。'}已有状态将被替换，评分与评论保持不变。`,
    `<div class="confirm-list">${subjects.map((s) => `<div>${image(s)}<span>${esc(title(s))}</span>${store.get(s.id) ? badge(store.get(s.id)!.status) : '<span class="muted small">未标记</span>'}${icon('arrow')}${badge(status)}</div>`).join('')}</div>`,
    () => {
      mark(subjects, status);
      selected.clear();
      renderSelection();
      closeDialog();
    },
    '确认标记',
  );
}
function renderRecords() {
  const all = store.all();
  const tabs = [
    ['all', '全部'],
    ...Object.entries(STATUS).map(([key, v]) => [key, v.label]),
    ['dirty', '待同步'],
  ];
  $('#record-tabs').innerHTML = tabs
    .map(
      ([key, label]) =>
        `<button class="tab ${recordStatus === key ? 'active' : ''}" data-action="record-tab" data-status="${key}">${label}<span>${key === 'all' ? all.length : key === 'dirty' ? store.dirty().length : all.filter((i) => i.status === key).length}</span></button>`,
    )
    .join('');
  const keyword = value('#record-keyword').trim().toLowerCase();
  let items = all.filter(
    (i) =>
      (recordStatus === 'all' ||
        (recordStatus === 'dirty' ? i.dirty : i.status === recordStatus)) &&
      `${i.name} ${i.name_cn}`.toLowerCase().includes(keyword),
  );
  const sort = value('#record-sort');
  items.sort((a, b) =>
    sort === 'rate'
      ? b.rate - a.rate
      : sort === 'name'
        ? title(a).localeCompare(title(b), 'zh-CN')
        : b.updatedAt - a.updatedAt,
  );
  const pages = Math.max(1, Math.ceil(items.length / 30));
  recordPage = Math.min(recordPage, pages);
  $('#records-list').innerHTML = items.length
    ? `<div class="record-list">${items
        .slice((recordPage - 1) * 30, recordPage * 30)
        .map(
          (i) =>
            `<article class="record-row">${image(i)}<div class="record-name"><button data-action="detail" data-id="${i.id}">${esc(title(i))}</button><small>${esc(i.date || '日期未知')} · ${i.rate ? `个人评分 ${i.rate}` : '未评分'}${i.private ? ' · 私密' : ''}</small>${i.comment ? `<p>${esc(i.comment)}</p>` : ''}</div>${badge(i.status)}<span class="sync-label ${i.dirty ? 'pending' : ''}">${i.status === 'not_interested' ? '仅本地' : i.error ? '同步失败' : i.dirty ? '待同步' : '已同步'}</span><button class="button secondary compact" data-action="detail" data-id="${i.id}">编辑</button><button class="icon-button" data-action="remove" data-id="${i.id}" aria-label="移除 ${esc(title(i))} 的本地记录">${icon('close')}</button></article>`,
        )
        .join('')}</div>`
    : empty(
        '这里还没有记录',
        '去发现页选择几部动画，或在同步中心拉取已有收藏。',
        '<button class="button primary" data-view="discover">开始补标</button>',
      );
  $('#record-pager').innerHTML =
    `<button class="button secondary" data-action="record-prev" ${recordPage <= 1 ? 'disabled' : ''}>上一页</button><span>${items.length} 部 · ${recordPage} / ${pages} 页</span><button class="button secondary" data-action="record-next" ${recordPage >= pages ? 'disabled' : ''}>下一页</button>`;
}
function renderAuth() {
  $('#account-name').textContent = user ? user.nickname || user.username : '连接 Bangumi';
  $('#account-chip').classList.toggle('connected', !!user);
  $('#account-status').textContent = sync.progress.active
    ? sync.progress.message
    : authBusy
      ? '正在验证连接…'
      : user
        ? store.state.settings.realtime
          ? '已连接 · 自动推送开启'
          : '已连接 · 手动推送'
        : '未连接 · 点击配置';
  $('#auth-summary').innerHTML = user
    ? `<div class="user-summary">${safeImage(user.avatar?.medium) ? `<img src="${esc(safeImage(user.avatar?.medium))}" alt="">` : icon('check')}<div><strong>${esc(user.nickname || user.username)}</strong><small>@${esc(user.username)} · 已连接</small></div></div>`
    : '<p class="muted">尚未连接。你可以先整理本地记录，稍后再同步。</p>';
  $<HTMLButtonElement>('#connect').disabled = authBusy || sync.progress.active;
}
function renderSync() {
  const pending = store.dirty();
  $('#pending-total').textContent = String(pending.length);
  $('#pending-list').innerHTML = pending.length
    ? `<div class="pending-list">${pending
        .slice(0, 50)
        .map(
          (i) =>
            `<div class="pending-row"><span>${esc(title(i))}${i.error ? `<small class="error-text">${esc(i.error)}</small>` : ''}</span>${badge(i.status)}<small>${i.rate ? `${i.rate} 分` : '未评分'}${i.private ? ' · 私密' : ''}</small><button class="text-button" data-action="detail" data-id="${i.id}">检查 ${icon('chevron')}</button></div>`,
        )
        .join(
          '',
        )}</div>${pending.length > 50 ? '<p class="muted small">仅预览前 50 条，推送将处理全部待同步记录。</p>' : ''}`
    : '<div class="sync-empty">' + icon('check') + '没有待同步的修改，收藏井井有条。</div>';
  $('#last-pull').textContent = store.state.lastPull
    ? `上次拉取：${new Date(store.state.lastPull).toLocaleString('zh-CN')}`
    : '还没有从账号拉取过收藏';
  renderProgress();
  renderAuth();
}
function renderProgress() {
  const p = sync.progress;
  $('#sync-progress').innerHTML = p.message
    ? `<div class="progress-box"><div><span>${esc(p.message)}</span>${p.active ? '<button class="text-button" data-action="cancel-sync">停止任务</button>' : ''}</div>${p.active ? `<progress max="${p.total || 1}" value="${p.done}"></progress>` : ''}</div>`
    : '';
  document
    .querySelectorAll<HTMLButtonElement>(
      '[data-action="push"], [data-action="pull"], [data-action="logout"], [data-action="clear"], [data-action="export"]',
    )
    .forEach((b) => (b.disabled = p.active || authBusy || exporting));
}
sync.onProgress = () => {
  renderProgress();
  renderAuth();
};
async function login(token: string, remember: boolean) {
  if (sync.progress.active || authBusy) throw new Error('请等待当前任务完成');
  if (!token) throw new Error('请先输入个人访问令牌');
  authBusy = true;
  renderAuth();
  renderProgress();
  try {
    const me = await api.me(token);
    if (!me?.id || !me.username) throw new Error('账号信息无效');
    store.bind(me);
    localStorage.removeItem('bbm-token');
    sessionStorage.removeItem('bbm-token');
    (remember ? localStorage : sessionStorage).setItem('bbm-token', token);
    api.token = token;
    user = me;

    seriesMatches.clear();
    $<HTMLInputElement>('#token').value = '';
    toast(`已连接 ${me.nickname || me.username}，正在拉取官方收藏`);
    renderAuth();
    try {
      await sync.pull(me);
      toast(sync.progress.message, !!sync.progress.failed);
    } catch (error) {
      toast(`已连接，但自动拉取失败：${(error as Error).message}，可在同步中心重试`, true);
    }
  } finally {
    authBusy = false;
    renderAuth();
    renderProgress();
    if (!loading && results.length) run(() => discoverSeries(++searchGeneration));
  }
}
async function exportBackup() {
  if (exporting || sync.progress.active || authBusy) throw new Error('请等待当前任务完成后导出');
  exporting = true;
  renderProgress();
  try {
    const data = store.loadError
      ? localStorage.getItem('bangumi-batch-marker-v1') || '{}'
      : JSON.stringify(
          await createBackup(store, api, (done, total) => {
            document.querySelectorAll<HTMLElement>('[data-action="export"]').forEach((button) => {
              button.textContent = `正在整理单集 ${done}/${total}`;
            });
          }),
          null,
          2,
        );
    const href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = href;
    link.download = `bangumi-backlog-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  } finally {
    exporting = false;
    document.querySelectorAll<HTMLElement>('[data-action="export"]').forEach((button) => {
      button.textContent = '导出备份';
    });
    renderProgress();
  }
}

async function detail(id: number) {
  const base = find(id);
  if (!base) return;
  const previous =
    dialog.open && dialog.querySelector('.series-list')
      ? {
          nodes: [...dialog.childNodes],
          entries: [...seriesEntries],
          scroll: dialog.scrollTop,
          revisions: new Map(seriesEntries.map((s) => [s.id, store.get(s.id)?.revision])),
        }
      : null;
  dialogSubject = base;
  episodeList = [];
  episodeTypes = {};
  const item = store.get(id);
  openDialog(
    '作品详情',
    `<div class="detail-head">${image(base)}<div><span class="eyebrow">ANIME COLLECTION</span><h3>${esc(title(base))}</h3><p class="muted">${esc(base.name)}</p><div class="detail-meta"><span class="detail-score">${icon('star')}${base.score || '—'}</span><span>${esc(base.date || '日期未知')} · ${esc(base.platform || '动画')}</span></div><div class="button-row"><a href="https://bgm.tv/subject/${id}" target="_blank" rel="noopener noreferrer">Bangumi 条目 ↗</a><button class="text-button" data-action="series" data-id="${id}">查看系列 ${icon('arrow')}</button></div></div></div><form id="detail-form" class="editor"><div class="editor-fields"><label>收藏状态<select id="edit-status" required>${statusOptions(item?.status)}</select></label><label>个人评分<select id="edit-rate">${Array.from({ length: 11 }, (_, i) => `<option value="${i}" ${item?.rate === i ? 'selected' : ''}>${i ? `${i} 分` : '未评分'}</option>`).join('')}</select></label><label class="check-label"><input id="edit-private" type="checkbox" ${item?.private ? 'checked' : ''}>仅自己可见</label></div><label class="field-label" for="edit-comment">我的短评</label><textarea id="edit-comment" rows="3" maxlength="20000" placeholder="给这段故事留下一点感想…">${esc(item?.comment || '')}</textarea><div class="editor-footer"><span class="muted small">${item?.dirty ? '有未同步修改' : '修改后保存到本地'} · 不感兴趣不影响远端收藏</span><button class="button primary" type="submit">${icon('check')}保存记录</button></div></form><details class="detail-section" open><summary>故事简介</summary><p id="detail-summary" class="summary-text">${esc(base.summary || '正在加载简介…')}</p></details><details class="detail-section"><summary>主要角色</summary><div id="characters" class="characters"><span class="muted">正在加载…</span></div></details><details class="detail-section" open><summary>单集进度</summary><p id="episode-note" class="muted small">正在加载…</p><div id="episodes" class="episodes"></div></details>`,
    true,
  );
  seriesReturn = previous;
  if (previous)
    dialog.querySelector('.dialog-header button')!.setAttribute('aria-label', '返回系列补标');
  const gen = dialogGeneration;
  api
    .subject(id, 2)
    .then((s) => {
      if (gen !== dialogGeneration) return;
      dialogSubject = s;
      $('#detail-summary').textContent = s.summary || '暂无简介';
    })
    .catch((e) => {
      if (gen === dialogGeneration) $('#detail-summary').textContent = base.summary || e.message;
    });
  api
    .characters(id, 2)
    .then((chars) => {
      if (gen !== dialogGeneration) return;
      const order: Record<string, number> = { 主角: 0, 配角: 1, 客串: 2 };
      chars.sort((a, b) => (order[a.relation] ?? 3) - (order[b.relation] ?? 3));
      $('#characters').innerHTML =
        chars
          .slice(0, 18)
          .map(
            (c) =>
              `<a class="character" href="https://bgm.tv/character/${c.id}" target="_blank" rel="noopener noreferrer"><img src="${esc(safeImage(c.images?.medium || c.images?.grid) || './placeholder.svg')}" alt="" loading="lazy"><strong>${esc(c.name)}</strong><small>${esc(c.relation)}</small></a>`,
          )
          .join('') || '<p class="muted">暂无角色信息</p>';
    })
    .catch((e) => {
      if (gen === dialogGeneration) $('#characters').textContent = e.message;
    });
  try {
    const eps = await api.episodes(id, 2);
    if (gen !== dialogGeneration) return;
    episodeList = eps
      .filter((ep) => ep.type === 0 || ep.type === 1)
      .sort((a, b) => a.type - b.type || a.sort - b.sort);
    let note = '未连接账号，仅显示本地待同步的单集修改；不会根据已看总数推测具体集数。';
    if (api.token) {
      try {
        const remote = await api.episodeCollections(id, 2);
        if (gen !== dialogGeneration) return;
        episodeTypes = Object.fromEntries(remote.map((x) => [x.episode.id, x.type]));
        note = '已读取账号单集进度。点击单集暂存修改，推送后生效。';
      } catch {
        note = '未能读取账号单集进度，仅显示本地修改。可重新打开详情重试。';
      }
    }
    if (gen !== dialogGeneration) return;
    $('#episode-note').textContent = note;
    renderEpisodes(id);
  } catch (e) {
    if (gen === dialogGeneration) $('#episode-note').textContent = (e as Error).message;
  }
}
function renderEpisodes(id: number) {
  const changes = store.get(id)?.episodeChanges || {};
  $('#episodes').innerHTML =
    episodeList
      .map((ep) => {
        const watched = (changes[ep.id] ?? episodeTypes[ep.id]) === 2;
        return `<button class="episode ${watched ? 'watched' : ''} ${Object.hasOwn(changes, ep.id) ? 'changed' : ''}" data-action="episode" data-id="${ep.id}" data-subject="${id}" aria-pressed="${watched}" title="${esc(ep.name_cn || ep.name)}${!aired(ep.airdate) ? ' · 未播出或日期未知' : ''}" ${!aired(ep.airdate) ? 'disabled' : ''}>${ep.type === 1 ? 'SP ' : ''}${ep.sort ?? ep.ep}</button>`;
      })
      .join('') || '<p class="muted">暂无正篇与 SP 章节</p>';
}
async function series(id: number) {
  const base = find(id) || dialogSubject;
  if (!base) return;
  openDialog(
    '系列补标',
    `<div class="series-loading">${icon('sync')}<h3>正在整理关联系列</h3><p id="series-progress">从前作到续作，按播出时间排列…</p><p class="muted small">关闭弹窗即可停止继续查找。</p></div>`,
    true,
  );
  const gen = dialogGeneration;
  try {
    const scope = cacheScope();
    const cached = seriesCache.series(scope, id);
    const found =
      cached ||
      (await collectSeries(
        api,
        base,
        () => gen !== dialogGeneration,
        (count) => {
          if (gen === dialogGeneration)
            $('#series-progress').textContent = `已找到 ${count} 部作品…`;
        },
        undefined,
        2,
      ));
    if (gen !== dialogGeneration) return;
    if (!cached) seriesCache.putSeries(scope, id, found);
    if (!found.truncated && found.entries.length > 1)
      for (const entry of found.entries) updateSeriesHint(entry.id, true);
    updateSeriesHint(id, found.entries.length > 1);
    seriesEntries = found.entries;
    openDialog(
      '系列补标',
      `<p class="dialog-description">按播出时间排列，仅包含主线前传与续作。排除 WEB、其他类型；TV、OVA 排除不足 5 分钟或无单集时长的作品，剧场版不限制时长。默认选择已播出且尚未整理的作品。右侧可逐部标记为看过、搁置、抛弃或不感兴趣，标记后自动取消该条目的批量勾选。</p>${found.truncated ? '<p class="notice">系列较大，仅展示关联范围内前 24 部，可从末尾作品继续查找。</p>' : ''}<div class="series-list">${seriesEntries.map((s) => seriesRow(s, store.get(s.id))).join('')}</div><div class="series-selection-note"><span id="series-selected-count" aria-live="polite"></span><small>未播出或日期未知的作品暂不可标记</small></div><div class="dialog-footer"><button class="text-button" data-action="series-select-all">选择全部已播作品</button><select id="series-status" aria-label="系列批量状态"><option value="collect">看过</option><option value="doing">在看</option><option value="wish">想看</option><option value="on_hold">搁置</option><option value="dropped">抛弃</option><option value="not_interested">不感兴趣</option></select><button class="button primary" data-action="series-apply">检查并标记 ${icon('arrow')}</button></div>`,
      true,
    );
    updateSeriesSelection();
  } catch (e) {
    if (gen === dialogGeneration)
      openDialog(
        '系列加载失败',
        empty(
          '暂时无法加载系列',
          (e as Error).message,
          `<button class="button primary" data-action="series" data-id="${id}">重试</button>`,
        ),
      );
  }
}
function updateSeriesSelection() {
  const count = document.querySelectorAll('.series-select:checked').length;
  const label = document.querySelector<HTMLElement>('#series-selected-count');
  if (label) label.textContent = `批量已选 ${count} 部`;
  const apply = document.querySelector<HTMLButtonElement>('[data-action="series-apply"]');
  if (apply) apply.disabled = count === 0;
}
function guide() {
  openDialog(
    '欢迎使用 bangumi动画补标工具',
    `<div class="guide"><div><b>01</b><span><h3>准备网络与令牌</h3><p>请自行配置科学上网，确保能正常访问 Bangumi 及其 API。先进入「同步中心」，点击「获取令牌」，在 Bangumi 官方页面生成个人访问令牌。</p></span></div><div><b>02</b><span><h3>验证连接，自动拉取</h3><p>粘贴令牌并点击「验证并连接」。连接成功后自动拉取官方收藏，已有记录会显示在作品卡片和「我的记录」中。</p></span></div><div><b>03</b><span><h3>发现系列，批量补标</h3><p>点击海报上的「发现系列」进入系列补标。自动推送标记默认开启，连接后每次标记都会同步到 Bangumi；可在同步中心关闭。「看过」默认补齐已播正篇进度。</p></span></div></div><div class="notice">不感兴趣与移除记录仅本地生效。尚未连接时，标记先保存在本地；连接后可检查并手动推送这些历史记录。</div><div class="dialog-footer"><button class="text-button" data-action="close">稍后连接</button><button class="button primary" data-action="setup-account">前往同步中心 ${icon('arrow')}</button></div>`,
  );
}
async function action(button: HTMLElement) {
  const id = Number(button.dataset.id);
  const status = button.dataset.status as Status;
  switch (button.dataset.action) {
    case 'season-toggle':
      toggleQuarterMenu();
      break;
    case 'season-year':
      selectQuarterYear(button.dataset.year!);
      break;
    case 'season-quarter':
      commitQuarter(button.dataset.quarter!);
      readFilters();
      break;
    case 'season-clear':
      clearQuarter();
      readFilters();
      break;
    case 'setup-account':
      closeDialog();
      showView('sync');
      $('#token').focus();
      break;
    case 'close':
      closeTopDialog();
      break;
    case 'guide':
      guide();
      break;
    case 'retry':
      await search();
      break;
    case 'reset':
      resetFilters();
      break;
    case 'prev':
      filters.page = Math.max(1, filters.page - 1);
      await search();
      break;
    case 'next':
      filters.page = Math.min(totalPages(), filters.page + 1);
      await search();
      break;
    case 'page':
      filters.page = Number(button.dataset.page);
      await search();
      break;
    case 'tag':
    case 'exclude': {
      const tag = button.dataset.tag!;
      const key = button.dataset.action === 'tag' ? 'tags' : 'excluded';
      const other = key === 'tags' ? 'excluded' : 'tags';
      filters[key] = filters[key].includes(tag)
        ? filters[key].filter((t) => t !== tag)
        : [...filters[key], tag];
      filters[other] = filters[other].filter((t) => t !== tag);
      filters.page = 1;
      renderTags();
      await search();
      break;
    }
    case 'mark':
      if (find(id)) mark([find(id)!], status);
      break;
    case 'dismiss':
      if (find(id)) mark([find(id)!], 'not_interested');
      break;
    case 'clear-selection':
      selected.clear();
      renderGrid();
      break;
    case 'batch':
      confirmBatch(
        visibleResults().filter((s) => selected.has(s.id)),
        status,
      );
      break;
    case 'confirm':
      if (confirmCallback) {
        const fn = confirmCallback;
        confirmCallback = null;
        button.setAttribute('disabled', '');
        try {
          await fn();
        } catch (e) {
          confirmCallback = fn;
          button.removeAttribute('disabled');
          throw e;
        }
      }
      break;
    case 'detail':
      await detail(id);
      break;
    case 'series':
      await series(id);
      break;
    case 'series-mark': {
      const subject = seriesEntries.find((s) => s.id === id);
      if (!subject || !aired(subject.date)) return;
      const row = button.closest<HTMLElement>('[data-series-id]');
      if (!row) return;
      mark([subject], status);
      row.querySelector<HTMLInputElement>('.series-select')!.checked = false;
      row.querySelector<HTMLElement>('.series-row-status')!.innerHTML = badge(status);
      row.querySelectorAll<HTMLButtonElement>('[data-action="series-mark"]').forEach((option) => {
        option.setAttribute('aria-pressed', String(option.dataset.status === status));
      });
      updateSeriesSelection();
      break;
    }
    case 'series-select-all':
      document
        .querySelectorAll<HTMLInputElement>('.series-select:not(:disabled)')
        .forEach((e) => (e.checked = true));
      updateSeriesSelection();
      break;
    case 'series-apply': {
      const ids = [...document.querySelectorAll<HTMLInputElement>('.series-select:checked')].map(
        (e) => +e.value,
      );
      const subjects = seriesEntries.filter((s) => ids.includes(s.id) && aired(s.date));
      if (!subjects.length) return toast('请先选择作品');
      mark(subjects, value('#series-status') as Status, {}, true);
      selected.clear();
      renderSelection();
      closeDialog();
      break;
    }
    case 'record-tab':
      recordStatus = button.dataset.status!;
      recordPage = 1;
      renderRecords();
      break;
    case 'record-prev':
      recordPage--;
      renderRecords();
      break;
    case 'record-next':
      recordPage++;
      renderRecords();
      break;
    case 'remove':
      confirm(
        '移除本地记录',
        '此操作只移除本机记录，不取消 Bangumi 账号上的收藏。',
        `<p>${esc(title(find(id)!))}</p><a href="https://bgm.tv/subject/${id}" target="_blank" rel="noopener noreferrer">需要取消远端收藏？前往条目页 ↗</a>`,
        () => {
          store.remove([id]);
          closeDialog();
          toast('已移除本地记录');
        },
        '移除本地记录',
      );
      break;
    case 'token-eye': {
      const input = $<HTMLInputElement>('#token');
      input.type = input.type === 'password' ? 'text' : 'password';
      button.textContent = input.type === 'password' ? '显示' : '隐藏';
      break;
    }
    case 'logout':
      if (sync.progress.active || authBusy) throw new Error('请等待当前任务完成');
      api.token = '';
      user = null;

      seriesMatches.clear();
      realtimeIds.clear();
      run(() => discoverSeries(++searchGeneration));
      clearTimeout(realtimeTimer);
      localStorage.removeItem('bbm-token');
      sessionStorage.removeItem('bbm-token');
      renderAuth();
      toast('已断开连接，本地记录已保留');
      break;
    case 'sync-choice': {
      const resolve = pendingConflict;
      pendingConflict = null;
      closeDialog();
      resolve?.(button.dataset.choice === 'remote' ? 'remote' : 'local');
      break;
    }
    case 'push': {
      if (!user || !api.token) {
        showView('sync');
        throw new Error('请先连接 Bangumi 账号');
      }
      const pending = store.dirty();
      if (!pending.length) return toast('没有待同步的记录');
      await sync.push(
        pending.map((i) => i.id),
        true,
      );
      toast(sync.progress.message, !!sync.progress.failed);
      break;
    }
    case 'pull':
      if (!user) throw new Error('请先连接 Bangumi 账号');
      await sync.pull(user);
      toast(sync.progress.message);
      break;
    case 'cancel-sync':
      realtimeIds.clear();
      clearTimeout(realtimeTimer);
      sync.cancel();
      break;
    case 'export':
      await exportBackup();
      break;
    case 'import':
      $<HTMLInputElement>('#import-file').click();
      break;
    case 'clear':
      confirm(
        '清空本地记录',
        '此操作无法撤销，不影响账号收藏。建议先导出 JSON 备份。',
        `<p>将移除本地 ${store.all().length} 条记录及账号归属信息。</p>`,
        () => {
          store.clear();
          if (user) store.bind(user);
          closeDialog();
          toast('本地记录已清空');
        },
        '清空记录',
      );
      break;
    case 'test-api':
      await api.request('GET', '/v0/subjects/8');
      toast('Bangumi API 连接正常');
      break;
    case 'diagnostics':
      openDialog(
        '请求日志',
        `<p class="muted small">最近 ${api.logs.length} 次请求 · 0 表示网络失败或超时</p><div class="logs">${api.logs.map((l) => `<div><span>${new Date(l.time).toLocaleTimeString('zh-CN')}</span><strong>${l.method}</strong><code>${esc(l.path)}</code><b class="${l.status >= 200 && l.status < 300 ? 'success-text' : 'error-text'}">${l.status}</b><span>${l.ms} ms</span></div>`).join('') || '<p>还没有请求记录</p>'}</div>`,
        true,
      );
      break;
    case 'episode': {
      const subjectId = Number(button.dataset.subject);
      const subject = find(subjectId) || dialogSubject;
      if (!subject) return;
      const ep = episodeList.find((e) => e.id === id);
      if (!ep || !aired(ep.airdate)) return;
      const item = store.get(subjectId);
      const changes = { ...item?.episodeChanges };
      const old = changes[id] ?? episodeTypes[id];
      changes[id] = old === 2 ? 0 : 2;
      store.mark(
        [subject],
        item?.status && item.status !== 'not_interested' ? item.status : 'doing',
        { episodeChanges: changes },
      );
      renderEpisodes(subjectId);
      maybeRealtime([subjectId]);
      toast('单集修改已暂存，推送后生效');
      break;
    }
  }
}
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (!target.closest('.quarter-filter')) closeQuarterMenu();
  const button = target.closest<HTMLElement>('[data-action]');
  if (button && !(button as HTMLButtonElement).disabled) {
    e.preventDefault();
    run(() => action(button));
    return;
  }
  const nav = target.closest<HTMLElement>('[data-view]');
  if (nav) {
    e.preventDefault();
    closeDialog();
    showView(nav.dataset.view!);
  }
});
document.addEventListener('change', (e) =>
  run(async () => {
    const target = e.target as HTMLInputElement;
    if (target.classList.contains('series-select')) updateSeriesSelection();
    if (target.dataset.select) {
      const id = +target.dataset.select;
      target.checked ? selected.add(id) : selected.delete(id);
      target.closest('.anime-card')?.classList.toggle('selected', target.checked);
      renderSelection();
    }
    switch (target.id) {
      case 'select-page':
        selected = target.checked ? new Set(visibleResults().map((s) => s.id)) : new Set();
        renderGrid();
        break;
      case 'hide-handled':
        hideHandled = target.checked;
        filters.page = 1;
        await search();
        break;
      case 'auto-next':
        store.settings({ autoNext: target.checked });
        if (target.checked) maybeAutoNext();
        break;
      case 'sort':
      case 'quarter-year':
      case 'quarter':
      case 'year-from':
      case 'year-to':
      case 'nsfw':
        readFilters();
        break;
      case 'page-size':
        filters.size = +target.value;
        filters.page = 1;
        await search();
        break;
      case 'record-sort':
        renderRecords();
        break;
      case 'realtime':
        store.settings({ realtime: target.checked });
        if (target.checked) toast('已开启自动推送；下一次编辑后开始同步');
        else {
          clearTimeout(realtimeTimer);
          realtimeIds.clear();
        }
        break;
      case 'complete-episodes':
        store.settings({ completeEpisodes: target.checked });
        break;
      case 'import-file': {
        const file = target.files?.[0];
        target.value = '';
        if (!file) return;
        if (file.size > 25 * 1024 * 1024) throw new Error('备份文件不能超过 25 MB');
        const items = store.parseImport(JSON.parse(await file.text()));
        const repeated = items.filter((i: Item) => store.get(i.id)).length;
        confirm(
          '导入收藏备份',
          `读取到 ${items.length} 条记录，${repeated} 条与当前记录重复。重复记录保留当前版本，新增记录将列为待同步；不会自动推送。`,
          '',
          () => {
            const n = store.import(items);
            closeDialog();
            toast(`已导入 ${n} 条新记录`);
          },
          '确认导入',
        );
        break;
      }
    }
  }),
);
document.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  run(async () => {
    if (form.id === 'search-form') readFilters();
    if (form.id === 'auth-form') await login(value('#token').trim(), checked('#remember'));
    if (form.id === 'jump-form') {
      filters.page = Math.min(
        Math.max(1, Math.round(+value('#jump') || 1)),
        Math.max(1, totalPages()),
      );
      await search();
    }
    if (form.id === 'detail-form' && dialogSubject) {
      mark([dialogSubject], value('#edit-status') as Status, {
        rate: +value('#edit-rate'),
        comment: value('#edit-comment'),
        private: checked('#edit-private'),
      });
      closeTopDialog();
    }
  });
});
for (const id of ['year-from', 'year-to']) {
  const input = $<HTMLInputElement>('#' + id);
  input.addEventListener('input', () => updateYearRange(input));
}
updateYearRange();
updateQuarterControls();
$('#keyword').addEventListener('input', updateSortOptions);
$('#record-keyword').addEventListener('input', () => {
  recordPage = 1;
  renderRecords();
});
dialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeTopDialog();
});
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) {
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
      const fromSeries = !!seriesReturn || !!dialog.querySelector('.series-list');
      closeDialog();
      // Closing over the current discovery page must not run navigation's scroll reset.
      if (fromSeries && view !== 'discover') showView('discover');
    }
  }
});
document.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (img instanceof HTMLImageElement && !img.src.endsWith('/placeholder.svg'))
      img.src = './placeholder.svg';
  },
  true,
);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#season-menu').hidden) {
    e.preventDefault();
    closeQuarterMenu();
    $('#season-trigger').focus();
    return;
  }
  if (
    e.key === '/' &&
    !dialog.open &&
    !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)
  ) {
    e.preventDefault();
    showView('discover');
    $('#keyword').focus();
  }
});
window.addEventListener('beforeunload', (e) => {
  if (sync.progress.active) {
    e.preventDefault();
  }
});
window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
window.addEventListener('storage', (e) => {
  if (e.key === 'bangumi-batch-marker-v1') {
    store.loadError = '另一个标签页修改了存档。请刷新此页面后继续编辑，以避免覆盖新记录。';
    toast(store.loadError, true);
  }
});
renderTags();
changed();
showView(location.hash.slice(1) || 'discover');
if (store.loadError) toast(store.loadError, true);
try {
  if (!localStorage.getItem('bbm-onboarding-v1')) {
    guide();
    localStorage.setItem('bbm-onboarding-v1', '1');
  }
} catch {
  guide();
}
run(async () => {
  let token = '';
  let remember = false;
  try {
    token = sessionStorage.getItem('bbm-token') || localStorage.getItem('bbm-token') || '';
    remember = !!localStorage.getItem('bbm-token');
  } catch {
    toast('浏览器限制了凭据存储，本次无法恢复连接', true);
  }
  if (token) {
    try {
      await login(token, remember);
    } catch (e) {
      fail(e);
    }
  }
  await search();
});
