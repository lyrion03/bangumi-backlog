/** Bounded network workers; jobs are claimed in display order. */
export async function concurrent<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(items.length, Math.max(1, limit)) }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}
