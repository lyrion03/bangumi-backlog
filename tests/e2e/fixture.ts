import { test as base } from '@playwright/test';
export { expect, type Page } from '@playwright/test';
// UI tests own isolated browsers; the packaged smoke test exercises the real disk bridge.
export const test = base.extend<{ isolatedDisk: void }>({
  isolatedDisk: [
    async ({ context }, use) => {
      await context.route('**/__backlog/data**', (route) => route.fulfill({ status: 404 }));
      await use();
    },
    { auto: true },
  ],
});
