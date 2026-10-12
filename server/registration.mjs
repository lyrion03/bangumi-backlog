const cache = new Map();
export function parseRegistration(html, now = Date.now()) {
  const match = html.match(
    /\bBangumi<\/span>\s*<span\b[^>]*>\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*加入/,
  );
  if (!match) return null;
  const date = match[1] + '-' + match[2].padStart(2, '0') + '-' + match[3].padStart(2, '0');
  const time = Date.parse(date);
  return Number.isFinite(time) &&
    time <= now &&
    Number(match[1]) >= 2000 &&
    new Date(time).toISOString().slice(0, 10) === date
    ? date
    : null;
}
export async function registration(req, res) {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (!path.startsWith('/__bangumi/registration/')) return false;
  const match = path.match(/^\/__bangumi\/registration\/([1-9]\d{0,9})$/);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' || !match) {
    res.writeHead(400).end('{}');
    return true;
  }
  const id = Number(match[1]);
  const found = cache.get(id);
  if (found && Date.now() - found.at < 86400000) {
    res.end(JSON.stringify({ id, registered: found.date }));
    return true;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  const abort = () => controller.abort();
  res.on('close', abort);
  try {
    let url = new URL('https://bgm.tv/user/' + id);
    let response;
    for (let redirect = 0; redirect < 3; redirect++) {
      response = await fetch(url, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'bangumi-backlog/1.0 (+https://github.com/lyrion03/bangumi-backlog)',
        },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      const next = new URL(response.headers.get('location') || '', url);
      if (
        next.origin !== 'https://bgm.tv' ||
        !/^\/user\/[a-zA-Z0-9_]+$/.test(next.pathname) ||
        next.search ||
        next.hash
      )
        throw Error('Invalid profile redirect');
      url = next;
    }
    if (!response?.ok) throw Error('Unavailable');
    const reader = response.body.getReader();
    let size = 0;
    const decoder = new TextDecoder();
    let html = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) {
        await reader.cancel();
        throw Error('Too large');
      }
      html += decoder.decode(value, { stream: true });
    }
    html += decoder.decode();
    const date = parseRegistration(html);
    if (!date) throw Error('Registration date missing');
    cache.set(id, { at: Date.now(), date });
    if (cache.size > 100) cache.delete(cache.keys().next().value);
    if (!res.destroyed) res.end(JSON.stringify({ id, registered: date }));
  } catch {
    if (!res.destroyed) res.writeHead(502).end(JSON.stringify({ error: '注册日期暂不可用' }));
  } finally {
    clearTimeout(timeout);
    res.off('close', abort);
  }
  return true;
}
