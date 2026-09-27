// Renders world snapshots with headless Chromium so the agent can look at its work
// even when no browser tab is open.
import { chromium } from 'playwright';

let pagePromise = null;
let queue = Promise.resolve();

async function openPage(baseUrl) {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  browser.on('disconnected', () => (pagePromise = null));
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
  page.on('pageerror', (e) => console.error('[capture page]', e.message));
  page.on('crash', () => {
    pagePromise = null;
    browser.close().catch(() => {});
  });
  await page.goto(`${baseUrl}/render.html`);
  await page.waitForFunction(() => window.ready === true);
  return page;
}

function getPage(baseUrl) {
  if (!pagePromise) {
    pagePromise = openPage(baseUrl).catch((e) => {
      pagePromise = null;
      throw e;
    });
  }
  return pagePromise;
}

async function render(baseUrl, snapshot, views) {
  const page = await getPage(baseUrl);
  const images = [];
  for (const view of views) {
    await page.evaluate(([s, v]) => window.renderView(s, v), [snapshot, view]);
    const buf = await page.screenshot({ type: 'jpeg', quality: 82 });
    images.push({ view, data: buf.toString('base64') });
  }
  return images;
}

export function capture(baseUrl, snapshot, views) {
  const job = queue.then(async () => {
    try {
      return await render(baseUrl, snapshot, views);
    } catch (e) {
      // A dead browser/page gets relaunched once.
      console.warn('[capture] retrying after:', e.message);
      const old = pagePromise;
      pagePromise = null;
      old?.then((p) => p.context().browser()?.close()).catch(() => {});
      return render(baseUrl, snapshot, views);
    }
  });
  queue = job.catch(() => {});
  return job;
}
