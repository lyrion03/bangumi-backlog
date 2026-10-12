import { it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { registration } from '../server/registration.mjs';
afterEach(() => vi.unstubAllGlobals());
function response() {
  const res = new EventEmitter() as any;
  res.headers = {};
  res.status = 200;
  res.setHeader = (k: string, v: string) => (res.headers[k] = v);
  res.writeHead = (status: number) => {
    res.status = status;
    return res;
  };
  res.end = (body: string) => {
    res.body = body;
    return res;
  };
  return res;
}
it('follows numeric profile redirects only within the fixed Bangumi profile origin', async () => {
  const mock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response('', { status: 302, headers: { location: '/user/testprofile' } }),
    )
    .mockResolvedValueOnce(new Response('<span>Bangumi</span><span>2016-6-1 加入</span>'));
  vi.stubGlobal('fetch', mock);
  const res = response();
  await registration({ url: '/__bangumi/registration/123450', method: 'GET' }, res);
  expect(JSON.parse(res.body)).toEqual({ id: 123450, registered: '2016-06-01' });
  expect(String(mock.mock.calls[1][0])).toBe('https://bgm.tv/user/testprofile');
  expect(mock.mock.calls[0][1].headers.Authorization).toBeUndefined();
});
it('rejects off-origin redirects, arbitrary URLs and non-GET requests', async () => {
  const mock = vi
    .fn()
    .mockResolvedValue(
      new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
    );
  vi.stubGlobal('fetch', mock);
  const res = response();
  await registration({ url: '/__bangumi/registration/123451', method: 'GET' }, res);
  expect(res.status).toBe(502);
  expect(mock).toHaveBeenCalledTimes(1);
  for (const req of [
    { url: '/__bangumi/registration/http://example.com', method: 'GET' },
    { url: '/__bangumi/registration/123452', method: 'POST' },
  ]) {
    const r = response();
    await registration(req, r);
    expect(r.status).toBe(400);
  }
  expect(mock).toHaveBeenCalledTimes(1);
});
