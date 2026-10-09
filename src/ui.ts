import { seasonPicker } from './season';
import { YEAR_MIN, YEAR_MAX } from './year-range';
import {
  STATUS,
  QUICK,
  title,
  safeImage,
  aired,
  type Subject,
  type Item,
  type Status,
} from './domain';
export const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const paths: Record<string, string> = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  book: '<path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4zM13 7a3 3 0 0 1 3-3h5v15h-5a3 3 0 0 0-3 2"/>',
  sync: '<path d="M20 7a9 9 0 0 0-15-2L2 8m0-5v5h5m-3 9a9 9 0 0 0 15 2l3-3m0 5v-5h-5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  down: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  up: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  shield: '<path d="M12 3 4 6v5c0 5 8 10 8 10s8-5 8-10V6z"/><path d="m8 12 3 3 5-6"/>',
  link: '<path d="m10 14 4-4m-6 7-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2-1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(2 0)"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
};
export const icon = (name: string, cls = '') =>
  `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.grid}</svg>`;
export const badge = (status: Status) =>
  `<span class="status status-${status}">${esc(STATUS[status].label)}</span>`;
export const image = (s: Subject, cls = '') =>
  `<img class="${cls}" src="${esc(safeImage(s.image) || './placeholder.svg')}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
export function seriesSpotlight(id: number, hasSeries = false) {
  return hasSeries
    ? `<button class="series-spotlight" data-action="series" data-id="${id}" aria-label="发现系列，进入系列补标">${icon('link')}发现系列 · 去补标${icon('arrow')}</button>`
    : '';
}
export function seriesRow(s: Subject, item: Item | undefined) {
  const available = aired(s.date);
  return `<div class="series-row" data-series-id="${s.id}"><input type="checkbox" class="series-select" value="${s.id}" aria-label="选择 ${esc(title(s))}" ${!item && available ? 'checked' : ''} ${!available ? 'disabled' : ''}>${image(s)}<span class="series-name"><strong>${esc(title(s))}</strong><small>${esc(s.date || '日期未知')} · ${esc(s.platform || '动画')}</small></span><span class="series-row-status">${item ? badge(item.status) : `<small class="muted">${available ? '待整理' : '未播 / 未知'}</small>`}</span><div class="series-quick" role="group" aria-label="${esc(title(s))} 快捷标记">${(['collect', 'on_hold', 'dropped', 'not_interested'] as Status[]).map((status) => `<button type="button" data-action="series-mark" data-id="${s.id}" data-status="${status}" aria-pressed="${item?.status === status}" title="${available ? `标记为${STATUS[status].label}，并取消此条目的批量勾选` : '未播出或日期未知，暂不可标记'}" ${!available ? 'disabled' : ''}>${STATUS[status].label}</button>`).join('')}</div><button type="button" class="text-button series-detail" data-action="detail" data-id="${s.id}" aria-label="${esc(title(s))} 详情">详情 ${icon('chevron')}</button></div>`;
}
export function card(
  s: Subject,
  item: Item | undefined,
  selected: boolean,
  hasSeries = false,
  showRank = false,
) {
  return `<article class="anime-card ${selected ? 'selected' : ''}" data-id="${s.id}">
    <div class="poster">${image(s)}<button class="poster-hit" data-action="detail" data-id="${s.id}" aria-label="查看 ${esc(title(s))} 详情"></button>
      <label class="select-cover"><input type="checkbox" data-select="${s.id}" ${selected ? 'checked' : ''} aria-label="选择 ${esc(title(s))}"><span>${icon('check')}</span></label>
      <button class="dismiss" data-action="dismiss" data-id="${s.id}" title="不感兴趣（仅本地）" aria-label="不感兴趣：${esc(title(s))}">${icon('close')}</button>
      ${item ? `<div class="poster-status">${badge(item.status)}</div>` : ''}
      <div data-series-slot>${seriesSpotlight(s.id, hasSeries)}</div><span class="score" title="${showRank ? 'Bangumi 全站动画排名' : 'Bangumi 评分'}">${showRank ? (s.rank > 0 ? `#${s.rank}` : '未上榜') : `${icon('star')}${s.score ? s.score.toFixed(1) : '—'}`}</span>
    </div>
    <div class="card-copy"><button class="card-title" data-action="detail" data-id="${s.id}" title="${esc(title(s))}">${esc(title(s))}</button><div class="card-meta"><span>${esc(s.date?.slice(0, 4) || '年份未知')}<i>·</i>${esc(s.platform || '动画')}</span></div></div>
    <div class="quick-actions">${QUICK.map((status) => `<button data-action="mark" data-id="${s.id}" data-status="${status}" class="${item?.status === status ? 'marked' : ''}" aria-pressed="${item?.status === status}">${item?.status === status ? icon('check') : ''}${STATUS[status].label}</button>`).join('')}</div>
  </article>`;
}
export const empty = (heading: string, description: string, action = '') =>
  `<div class="empty-state"><div class="empty-icon">${icon('book')}</div><h3>${esc(heading)}</h3><p>${esc(description)}</p>${action}</div>`;
export function toast(message: string, error = false) {
  const node = document.createElement('div');
  node.className = `toast ${error ? 'error' : ''}`;
  node.textContent = message;
  document.querySelector('#toasts')!.append(node);
  setTimeout(() => node.remove(), error ? 9000 : 4500);
}
export const statusOptions = (current?: Status) =>
  (current ? '' : '<option value="" disabled selected>请选择状态</option>') +
  Object.entries(STATUS)
    .map(
      ([key, value]) =>
        `<option value="${key}" ${current === key ? 'selected' : ''}>${value.label}</option>`,
    )
    .join('');
export function shell() {
  return `<aside class="sidebar">
    <a class="brand" href="#discover"><img src="./favicon.svg" alt=""><span>bangumi<small>动画补标工具</small></span></a>
    <div class="sidebar-label">我的动画工作台</div>
    <nav aria-label="主导航"><button class="nav-item active" data-view="discover">${icon('grid')}发现与补标</button><button class="nav-item" data-view="records">${icon('book')}我的记录<span id="nav-count" class="nav-count">0</span></button><button class="nav-item" data-view="sync">${icon('sync')}同步中心<span id="nav-dirty" class="nav-count pink">0</span></button></nav>
    <div class="sidebar-note"><span class="note-symbol">✧</span><strong>看过的故事，值得记住。</strong><p>把散落在记忆里的动画，<br>慢慢整理成你的收藏。</p><button data-action="guide">使用小指南 ${icon('arrow')}</button></div>
    <div class="sidebar-bottom"><button id="account-chip" class="account-chip" data-view="sync"><span class="connection-dot"></span><span class="account-copy"><span id="account-name">连接 Bangumi</span><small id="account-status">未连接 · 点击配置</small></span>${icon('chevron')}</button><small>v1.0.0 <a href="https://bgm.tv" target="_blank" rel="noopener noreferrer">Bangumi ↗</a></small></div>
  </aside>
  <div class="workspace">
    <main id="main"><section id="discover" class="view">
      <div class="page-heading"><h1>让每一次补番都有迹可循</h1></div>
      <div class="stats"><div>${icon('book')}<span>已整理作品<strong id="stat-total">0<small>部</small></strong></span></div><div>${icon('check')}<span>已经看过<strong id="stat-watched">0<small>部</small></strong></span></div><div>${icon('sync')}<span>等待同步<strong id="stat-dirty">0<small>部</small></strong></span></div><div class="stats-tip">${icon('shield')}<span>标记自动保存在本地<small>连接后，标记自动同步到 Bangumi</small></span></div></div>
      <section class="filter-panel" aria-label="搜索与筛选"><form id="search-form"><div class="search-row"><div class="search-input">${icon('search')}<input id="keyword" name="keyword" placeholder="搜索动画名称，找回熟悉的故事…" aria-label="搜索动画名称"><kbd>/</kbd></div><button class="button primary" type="submit">搜索动画 ${icon('arrow')}</button></div><div class="filters"><label>排序<select id="sort"><option value="heat">热度优先</option><option value="rank">排名优先</option><option value="date">日期优先</option></select></label><div class="year-filter" role="group" aria-label="首播年份范围"><span>年份</span><div class="year-slider" title="拖动两端选择首播年份，松开后筛选；两端拉满为全部年份"><div class="year-track"><div class="year-fill"></div></div><input id="year-from" type="range" min="${YEAR_MIN}" max="${YEAR_MAX}" value="${YEAR_MIN}" step="1" aria-label="起始年份" aria-describedby="year-label"><input id="year-to" type="range" min="${YEAR_MIN}" max="${YEAR_MAX}" value="${YEAR_MAX}" step="1" aria-label="结束年份" aria-describedby="year-label"></div><output id="year-label" for="year-from year-to">全部年份</output></div>${seasonPicker()}<label>评分<select id="rating"><option value="0">不限评分</option>${[5, 6, 6.5, 7, 7.5, 8, 8.5, 9].map((n) => `<option value="${n}">${n} 分以上</option>`).join('')}</select></label><label><select id="nsfw" aria-label="内容分级"><option value="hide">隐藏 NSFW</option><option value="all">全部内容</option><option value="only">仅 NSFW</option></select></label><button class="text-button reset" type="button" data-action="reset">重置筛选</button></div></form><div class="tag-picker"><div class="tag-picker-heading"><span>标签筛选</span><small>点击筛选 · × 屏蔽 · 多选需同时满足</small></div><div id="tags"></div><p class="tag-consensus" title="固定规则：至少 10 票，且达到本作最高票标签的 10%；筛选与屏蔽使用相同标准。">仅采用有足够票数支持的标签，忽略零星误标。过滤后自动补齐每页，最后一页除外。</p></div></section>
      <div class="results-heading"><div><h2 id="results-title">发现好动画</h2><span id="results-count">正在加载…</span></div><div class="results-options"><label class="check-label"><input id="hide-handled" type="checkbox">隐藏已整理</label><label class="check-label"><input id="auto-next" type="checkbox">自动翻页</label><select id="page-size" aria-label="每页条数"><option value="20">20 部 / 页</option><option value="10">10 部 / 页</option></select></div></div>
      <div class="select-line"><label class="check-label"><input id="select-page" type="checkbox">选择本页</label><span id="series-scan-status" aria-live="polite"></span><span id="selection-hint">支持多选，一次完成补标</span></div>
      <div id="grid" class="anime-grid" aria-live="polite"></div><div id="pager" class="pager"></div>
    </section><section id="records" class="view" hidden><div class="page-heading"><div><div class="eyebrow">YOUR PERSONAL COLLECTION</div><h1>我的记录</h1></div><button class="button secondary" data-action="export">${icon('down')}导出备份</button></div><div class="record-toolbar"><div id="record-tabs" class="tabs"></div><div class="record-filters"><input id="record-keyword" placeholder="搜索我的记录…" aria-label="搜索我的记录"><select id="record-sort" aria-label="记录排序"><option value="updated">最近修改</option><option value="rate">个人评分</option><option value="name">名称顺序</option></select></div></div><div id="records-list"></div><div id="record-pager" class="pager"></div></section>
    <section id="sync" class="view" hidden><div class="page-heading"><div><div class="eyebrow">KEEP EVERYTHING IN SYNC</div><h1>让收藏，完整相连</h1></div><span class="pill">${icon('shield')}直连官方 API</span></div><div class="sync-layout"><div class="panel"><div class="panel-title"><span class="panel-icon">${icon('link')}</span><div><h2>连接 Bangumi</h2><p>使用个人访问令牌连接你的账号</p></div></div><div id="auth-summary"></div><form id="auth-form"><label class="field-label" for="token">个人访问令牌</label><div class="token-field"><input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="粘贴 Access Token"><button type="button" data-action="token-eye" aria-label="显示或隐藏令牌">显示</button></div><label class="check-label remember"><input id="remember" type="checkbox">在此浏览器记住令牌</label><p class="muted small">默认仅在本次会话保存。记住后会存入本机浏览器，请仅在自己的设备上启用。</p><div class="button-row"><button class="button primary" id="connect" type="submit">验证并连接 ${icon('arrow')}</button><a href="https://next.bgm.tv/demo/access-token" target="_blank" rel="noopener noreferrer">获取令牌 ↗</a><button class="text-button" type="button" data-action="logout">断开连接</button></div></form></div>
      <div class="panel"><div class="panel-title"><span class="panel-icon teal">${icon('sync')}</span><div><h2>同步偏好</h2><p>为补标找到适合你的节奏</p></div></div><label class="setting"><span><strong>自动推送标记</strong><small>默认开启：每次标记自动推送；关闭后仅本地保存</small></span><input id="realtime" type="checkbox" role="switch"></label><label class="setting"><span><strong>看过时补齐正篇进度</strong><small>仅已播正篇；不改变 SP、搁置或抛弃的进度</small></span><input id="complete-episodes" type="checkbox" role="switch"></label><div class="sync-buttons"><button class="button secondary" data-action="pull">${icon('down')}拉取账号收藏</button><button class="button primary" data-action="push">${icon('up')}推送待同步</button></div><p id="last-pull" class="muted small"></p></div>
      <div class="panel wide"><div class="section-title"><div><h2>待同步清单 <span id="pending-total" class="count-pill">0</span></h2><p class="muted small">不感兴趣仅本地保存；拉取或手动推送遇到状态冲突时，整批询问保留哪一边。</p></div><button class="text-button" data-view="records">查看全部记录 ${icon('arrow')}</button></div><div id="sync-progress" aria-live="polite"></div><div id="pending-list"></div></div>
      <div class="panel"><div class="panel-title"><span class="panel-icon">${icon('book')}</span><div><h2>备份与迁移</h2><p>随时带走你的收藏记录</p></div></div><p class="muted">JSON 备份保留账号信息、作品状态、可用标记时间及逐集进度，不包含标签。连接账号后导出会读取最新单集状态；离线时导出本地已知进度。导入时重复条目保留当前记录，新增记录待手动同步。</p><div class="button-row"><button class="button secondary" data-action="export">${icon('down')}导出 JSON</button><button class="button secondary" data-action="import">${icon('up')}导入备份</button><button class="text-button danger" data-action="clear">清空本地记录</button></div><input id="import-file" type="file" accept="application/json,.json" hidden></div>
      <div class="panel"><div class="panel-title"><span class="panel-icon teal">${icon('info')}</span><div><h2>连接诊断</h2><p>检查官方 API 的请求状态</p></div></div><div class="button-row"><button class="button secondary" data-action="diagnostics">查看请求日志</button><button class="text-button" data-action="test-api">测试连接</button></div><p class="muted small">日志仅记录请求路径、状态与耗时，不记录令牌和评论内容。</p></div></div></section>
    <footer class="footer"><span>为每一份热爱，留下一枚标记。</span><span>数据来自 <a href="https://bgm.tv" target="_blank" rel="noopener noreferrer">Bangumi 番组计划 ↗</a> · 非官方工具</span></footer></main>
    <div id="batch-bar" class="batch-bar" hidden><div><span class="selected-number" id="selected-number">0</span> 部已选择<button class="text-button" data-action="clear-selection">取消选择</button></div><div class="batch-actions"><button class="button primary" data-action="batch" data-status="collect">${icon('check')}标记看过</button><button class="button secondary" data-action="batch" data-status="on_hold">搁置</button><button class="button secondary" data-action="batch" data-status="dropped">抛弃</button><button class="text-button" data-action="batch" data-status="not_interested">不感兴趣</button></div></div>
  </div>`;
}
