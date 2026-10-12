import { AXES, type RadarResult } from './radar-score';
import { esc } from './ui';
export { analyzeRadar } from './radar-data';
export function radarView(result: RadarResult) {
  const center = 200,
    radius = 125;
  const point = (index: number, scale = 1) => {
    const angle = ((-90 + index * 60) * Math.PI) / 180;
    return [center + Math.cos(angle) * radius * scale, center + Math.sin(angle) * radius * scale];
  };
  const ring = (scale: number) => AXES.map((_, i) => point(i, scale).join(',')).join(' ');
  const polygon = result.scores.map((s, i) => point(i, (s ?? 0) / 100).join(',')).join(' ');
  const grid = [0.2, 0.4, 0.6, 0.8, 1]
    .map((scale) => '<polygon points="' + ring(scale) + '" class="radar-grid"/>')
    .join('');
  const spokes = AXES.map(
    (_, i) =>
      '<line x1="200" y1="200" x2="' +
      point(i)[0] +
      '" y2="' +
      point(i)[1] +
      '" class="radar-grid"/>',
  ).join('');
  const labels = AXES.map(([name], i) => {
    const [x, y] = point(i, 1.3);
    return (
      '<text x="' +
      x +
      '" y="' +
      (y - 3) +
      '" text-anchor="middle" class="radar-label">' +
      name +
      '<tspan x="' +
      x +
      '" dy="19" class="radar-number">' +
      (result.scores[i] ?? '—') +
      '</tspan></text>'
    );
  }).join('');
  const dots = result.scores
    .map((s, i) =>
      s === null
        ? ''
        : '<circle cx="' +
          point(i, s / 100)[0] +
          '" cy="' +
          point(i, s / 100)[1] +
          '" r="3.5" class="radar-dot"/>',
    )
    .join('');
  const chart =
    '<svg viewBox="0 0 400 400" role="img" aria-label="六维雷达图，' +
    AXES.map(([n], i) => n + ' ' + (result.scores[i] ?? '资料不足')).join('，') +
    '">' +
    grid +
    spokes +
    '<polygon points="' +
    polygon +
    '" class="radar-shape"/>' +
    dots +
    labels +
    '</svg>';
  const axes = AXES.map(
    ([name, tip], i) =>
      '<div class="radar-axis"><button type="button" class="radar-help" aria-describedby="radar-tip-' +
      i +
      '">' +
      name +
      ' <span aria-hidden="true">ⓘ</span><span role="tooltip" id="radar-tip-' +
      i +
      '">' +
      tip +
      '</span></button><strong>' +
      (result.scores[i] ?? '—') +
      '</strong><small>' +
      (result.scores[i] === null
        ? '资料不足'
        : result.confidence[i] >= 0.7
          ? '依据较充分'
          : result.confidence[i] >= 0.3
            ? '仅供参考'
            : '样本或资料偏少') +
      '</small></div>',
  ).join('');
  return (
    '<div class="radar-intro"><span class="eyebrow">JUST FOR FUN</span><p>你的动画足迹，换个角度看看</p><small>' +
    result.total +
    ' 部记录 · ' +
    result.started +
    ' 部已开坑 · 资料覆盖 ' +
    Math.round(result.coverage * 100) +
    '%</small></div><div class="radar-layout"><div class="radar-chart">' +
    chart +
    '</div><div class="radar-axes">' +
    axes +
    '</div></div><div class="radar-facts"><span>正篇完坑 <b>' +
    result.completed +
    ' / ' +
    result.eligible +
    '</b></span><span>主线系列 <b>' +
    result.seriesComplete +
    ' / ' +
    result.seriesEligible +
    '</b></span><span>' +
    (result.registered ? esc(result.registered) + ' 加入 Bangumi' : '注册日期暂未读取') +
    '</span></div><p class="muted small radar-note">' +
    (result.conflicts
      ? '有 ' + result.conflicts + ' 部作品的「看过」与单集进度不一致，暂不计入完坑分。'
      : '想看与不感兴趣不计入观看画像；未完结或刚完结的作品暂不计入完坑分。') +
    ' ' +
    (result.incompleteSeries
      ? '有 ' + result.incompleteSeries + ' 组主线资料尚不完整，未计入系列完坑分。'
      : '') +
    (result.coverage < 1 ? '部分资料未获取，可稍后重新计算。' : '') +
    '</p>'
  );
}
