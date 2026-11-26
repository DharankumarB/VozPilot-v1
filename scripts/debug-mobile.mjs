/** Targeted debug: reproduce the blank mobile overview with full logging. */
import { createRequire } from 'module';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const require = createRequire(import.meta.url);
const { chromium: playwright } = require('playwright-core');
const mod = require('@sparticuz/chromium');
const sparticuz = mod.default ?? mod;
const { inflate } = mod;

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4000';
const stamp = Date.now().toString(36);

async function main() {
  const libDir = join(tmpdir(), 'al2023', 'lib');
  if (!existsSync(libDir)) {
    await inflate(join(process.cwd(), 'node_modules/@sparticuz/chromium/bin/al2023.tar.br')).catch(() => undefined);
  }
  process.env.FONTCONFIG_PATH ??= join(tmpdir(), 'fonts');
  process.env.LD_LIBRARY_PATH = [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');

  const browser = await playwright.launch({
    executablePath: await sparticuz.executablePath(),
    args: [...sparticuz.args, '--no-sandbox', '--disable-dev-shm-usage'],
    headless: true,
    env: { ...process.env },
  });

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const page = await context.newPage();
  page.on('console', (m) => console.log(`[console.${m.type()}]`, m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message, '\n', e.stack?.split('\n').slice(0, 4).join('\n')));
  page.on('requestfailed', (r) => console.log('[requestfailed]', r.url(), r.failure()?.errorText));
  page.on('response', (r) => { if (r.status() >= 400) console.log('[http]', r.status(), r.url()); });

  await page.goto(`${BASE}/register`, { waitUntil: 'networkidle' });
  await page.fill('#register-name', 'Mobile Debug');
  await page.fill('#register-email', `mob-${stamp}@vozpilot.test`);
  await page.fill('#register-password', 'MobileQA!2026');
  await page.click('button[type=submit]');
  await page.waitForURL(`${BASE}/`, { timeout: 15000 });
  console.log('landed:', page.url());

  for (const wait of [500, 1500, 3000]) {
    await page.waitForTimeout(wait);
    const info = await page.evaluate(() => ({
      title: document.title,
      bodyText: document.body.innerText.slice(0, 400),
      mainHTML: document.querySelector('main')?.innerHTML.slice(0, 300) ?? '(no main)',
      mainChildren: document.querySelector('main')?.children.length ?? -1,
      footer: Boolean(document.querySelector('footer')),
      docHeight: document.documentElement.scrollHeight,
      route: location.pathname,
    }));
    console.log(`--- after ${wait}ms:`, JSON.stringify(info, null, 2));
  }

  await page.screenshot({ path: 'screenshots/debug-mobile-overview.png', fullPage: true });
  console.log('captured debug screenshot');
  await browser.close();
}

main().catch((error) => {
  console.error('debug failed:', error);
  process.exit(1);
});
