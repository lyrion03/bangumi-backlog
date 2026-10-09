import type { Subject } from './domain';
const warmed = new Set<string>();
/** One low-priority image at a time, within the visible page's prefetch window. */
export async function preloadPosters(
  subjects: Subject[],
  cancelled: () => boolean,
  waitUntilReady: () => Promise<void>,
) {
  for (const subject of subjects) {
    await waitUntilReady();
    if (cancelled()) return;
    const url = subject.image;
    if (!url || warmed.has(url) || !/^https?:\/\//.test(url)) continue;
    const loaded = await new Promise<boolean>((resolve) => {
      const image = new Image();
      image.fetchPriority = 'low';
      image.decoding = 'async';
      const finish = (success: boolean) => {
        clearTimeout(timeout);
        image.onload = image.onerror = null;
        if (!success) image.removeAttribute('src');
        resolve(success);
      };
      const timeout = setTimeout(() => finish(false), 5000);
      image.onload = () => finish(true);
      image.onerror = () => finish(false);
      image.src = url;
    });
    if (loaded) {
      warmed.add(url);
      if (warmed.size > 200) warmed.delete(warmed.values().next().value!);
    }
  }
}
