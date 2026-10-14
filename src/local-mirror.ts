export const MIRROR_KEYS = [
  'bangumi-batch-marker-v1',
  'bbm-series-cache-v5',
  'bbm-radar-data-v1',
  'bbm-episode-snapshots-v1',
] as const;
const RECORDS = MIRROR_KEYS[0];
const URL = '/__backlog/data';
type Snapshot = { version: 1; scope: string; values: Record<string, string> };
export function recordScope(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw);
    if (
      value?.version !== 1 ||
      !value.items ||
      typeof value.items !== 'object' ||
      Array.isArray(value.items)
    )
      return null;
    return value.owner == null
      ? 'local'
      : Number.isSafeInteger(value.owner) && value.owner > 0
        ? 'user-' + value.owner
        : null;
  } catch {
    return null;
  }
}
function validValue(key: string, raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  try {
    const value = JSON.parse(raw);
    return key === RECORDS
      ? recordScope(raw) !== null
      : key === MIRROR_KEYS[1]
        ? value?.version === 1 && Array.isArray(value.records)
        : Array.isArray(value);
  } catch {
    return false;
  }
}
/** Browser remains authoritative. Disk is only consulted to fill absent keys at startup. */
export class LocalMirror implements Storage {
  private writeKey = '';
  private active = false;
  private dirty = false;
  private sending = false;
  private last = '';
  private timer?: ReturnType<typeof setInterval>;
  private warned = false;
  constructor(
    private storage: Storage,
    private request: typeof fetch = (input, init) => fetch(input, init),
    private onError: (message: string) => void = () => {},
  ) {}
  get length() {
    return this.storage.length;
  }
  key(index: number) {
    return this.storage.key(index);
  }
  getItem(key: string) {
    return this.storage.getItem(key);
  }
  setItem(key: string, value: string) {
    const before = this.storage.getItem(key);
    this.storage.setItem(key, value);
    if (before !== value && MIRROR_KEYS.includes(key as any)) this.dirty = true;
  }
  removeItem(key: string) {
    this.storage.removeItem(key);
    if (MIRROR_KEYS.includes(key as any)) this.dirty = true;
  }
  clear() {
    this.storage.clear();
    this.dirty = true;
  }
  private warn(message: string) {
    if (!this.warned) {
      this.warned = true;
      this.onError(message);
    }
  }
  private async readDisk(scope: string | null) {
    return this.request(URL + (scope ? '?scope=' + scope : ''), {
      signal: AbortSignal.timeout(1500),
      credentials: 'omit',
    });
  }
  async connect() {
    try {
      const before = this.storage.getItem(RECORDS);
      const scope = recordScope(before);
      // Corrupt browser records must not overwrite a valid disk copy.
      if (before !== null && !scope) return;
      const response = await this.readDisk(scope);
      if (response.status === 404) return; // Static hosting, dev server or older launcher.
      if (!response.ok) {
        this.warn('本地数据副本暂不可用，浏览器记录不受影响');
        return;
      }
      const data = await response.json();
      if (
        data?.version !== 1 ||
        typeof data.writeKey !== 'string' ||
        !data.writeKey ||
        !data.values ||
        typeof data.values !== 'object'
      )
        return;
      this.writeKey = data.writeKey;
      const diskScope = recordScope(data.values[RECORDS] ?? null);
      const current = this.storage.getItem(RECORDS);
      const currentScope = recordScope(current);
      if (current !== null && !currentScope) return;
      let restoreFailed = false;
      if (diskScope && (!currentScope || currentScope === diskScope)) {
        for (const key of MIRROR_KEYS) {
          // Recheck each key: another tab may have populated it while the request was in flight.
          if (this.storage.getItem(key) === null && validValue(key, data.values[key])) {
            try {
              this.storage.setItem(key, data.values[key]);
            } catch {
              restoreFailed = true;
              this.warn('浏览器空间不足，部分本地数据未能恢复；磁盘副本已保留');
            }
          }
        }
        if (current === null && this.storage.getItem(RECORDS) !== null)
          this.storage.setItem('bbm-onboarding-v1', '1');
      }
      if (restoreFailed) return; // Preserve the complete disk copy after a partial restore.
      this.active = true;
      this.dirty = true;
      this.timer = setInterval(() => {
        void this.flush();
      }, 5000);
    } catch {
      // No local service must not prevent ordinary web use.
    }
  }
  private snapshot(): Snapshot | null {
    const raw = this.storage.getItem(RECORDS),
      scope = recordScope(raw);
    if (!scope || raw === null) return null;
    const values: Record<string, string> = { [RECORDS]: raw };
    for (const key of MIRROR_KEYS.slice(1)) {
      const value = this.storage.getItem(key);
      if (validValue(key, value)) values[key] = value;
    }
    return { version: 1, scope, values };
  }
  async flush(leaving = false) {
    if (!this.active || !this.dirty || this.sending) return;
    let snapshot: Snapshot | null;
    try {
      snapshot = this.snapshot();
    } catch {
      this.warn('无法读取浏览器缓存，本地数据副本已保留');
      return;
    }
    if (!snapshot) return;
    const body = JSON.stringify(snapshot);
    if (body === this.last) {
      this.dirty = false;
      return;
    }
    // Browser keepalive requests have a small body budget; larger copies stay pending for the next visit.
    if (leaving && new TextEncoder().encode(body).length > 60000) return;
    this.sending = true;
    this.dirty = false;
    try {
      const send = () =>
        this.request(URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Backlog-Key': this.writeKey },
          body,
          credentials: 'omit',
          keepalive: leaving,
          signal: leaving ? undefined : AbortSignal.timeout(5000),
        });
      let response = await send();
      // The launcher rotates its write key on restart. Keep an already-open tab saving.
      if (response.status === 403 && !leaving) {
        const current = await this.readDisk(snapshot.scope);
        if (current.ok) {
          const data = await current.json();
          if (data?.version === 1 && typeof data.writeKey === 'string' && data.writeKey) {
            this.writeKey = data.writeKey;
            response = await send();
          }
        }
      }
      if (!response.ok) throw Error('save failed');
      this.last = body;
      this.warned = false;
    } catch {
      this.dirty = true;
      this.warn('本地副本保存失败，请检查 EXE 旁 data 文件夹的写入权限；浏览器记录已保留');
    } finally {
      this.sending = false;
    }
  }
  changedElsewhere() {
    this.dirty = true;
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.active = false;
  }
}
export async function createLocalStorage(storage: Storage, onError: (message: string) => void) {
  const mirror = new LocalMirror(storage, undefined, onError);
  await mirror.connect();
  window.addEventListener('storage', () => mirror.changedElsewhere());
  window.addEventListener('pagehide', () => {
    void mirror.flush(true);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void mirror.flush(true);
  });
  return mirror;
}
