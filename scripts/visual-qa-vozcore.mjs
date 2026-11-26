/**
 * VozCore visual QA (not part of the app): registers a fresh account and
 * drives one real orchestration run through the browser — Node API → proxy →
 * FastAPI/LangGraph engine — capturing the execution panel states.
 *
 * The engine must be started in explicit test mode for this demo:
 *   NODE_ENV=development VOZCORE_TEST_FAKE_LLM=1 ../vozcore/.venv/bin/python -m vozcore
 * (refused when NODE_ENV=production; outputs are labelled "[test transport]").
 *
 * Run: node scripts/visual-qa-vozcore.mjs
 */
import { createRequire } from 'module';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const require = createRequire(import.meta.url);
const { chromium: playwright } = require('playwright-core');
const sparticuzModule = require('@sparticuz/chromium');
const sparticuz = sparticuzModule.default ?? sparticuzModule;
const { inflate } = sparticuzModule;

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4000';
const OUT = 'screenshots';
const stamp = Date.now().toString(36);

async function main() {
  mkdirSync(OUT, { recursive: true });

  const libDir = join(tmpdir(), 'al2023', 'lib');
  if (!existsSync(libDir)) {
    const binDir = join(process.cwd(), 'node_modules', '@sparticuz', 'chromium', 'bin');
    await inflate(join(binDir, 'al2023.tar.br')).catch((error) => console.warn('al2023 inflate:', error.message));
  }
  process.env.FONTCONFIG_PATH ??= join(tmpdir(), 'fonts');
  process.env.LD_LIBRARY_PATH = [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');

  const executablePath = await sparticuz.executablePath();
  console.log('chromium:', executablePath);

  const browser = await playwright.launch({
    executablePath,
    args: [...sparticuz.args, '--no-sandbox', '--disable-dev-shm-usage'],
    headless: true,
    env: { ...process.env },
  });

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('  [console.error]', msg.text());
  });
  page.on('pageerror', (error) => console.log('  [pageerror]', error.message));

  const shot = async (name, opts = {}) => {
    await page.waitForTimeout(opts.wait ?? 600);
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: Boolean(opts.fullPage) });
    console.log('  captured', name);
  };

  // Fresh account → Command Center
  await page.goto(`${BASE}/register`, { waitUntil: 'networkidle' });
  await page.fill('#register-name', 'VozCore QA');
  await page.fill('#register-email', `vozcore-${stamp}@vozpilot.test`);
  await page.fill('#register-password', 'VozCoreQA!2026');
  await page.click('button[type=submit]');
  await page.waitForURL(`${BASE}/`, { timeout: 15000 });
  await page.goto(`${BASE}/command-center`, { waitUntil: 'networkidle' });
  await shot('30-vozcore-engine-ready', { wait: 900 });

  // Send a real command (suggestion fills the composer)
  await page.getByRole('button', { name: /Summarise the biggest risks/ }).click();
  await page.waitForTimeout(200);
  await page.click('button[aria-label="Send message"]');

  // Live states — the fake transport still walks the full graph over HTTP
  await page.waitForSelector('text=Planning', { timeout: 8000 }).catch(() => {});
  await shot('31-vozcore-execution-planning', { wait: 300 });
  await page.waitForSelector('text=Running', { timeout: 8000 }).catch(() => {});
  await shot('32-vozcore-execution-running', { wait: 400 });

  // Terminal state: completed panel with plan, waves, timeline, results
  await page.waitForSelector('text=Completed', { timeout: 30000 });
  await page.waitForTimeout(700);
  await shot('33-vozcore-execution-complete');

  // Dependency edges + agent outputs expanded
  const deps = page.getByRole('button', { name: 'Show dependencies' });
  if (await deps.count()) await deps.first().click();
  const results = page.locator('details summary', { hasText: 'attempt' });
  if (await results.count()) await results.first().click();
  await shot('34-vozcore-dependencies-results', { wait: 500 });

  // Final consolidated response in the thread
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await shot('35-vozcore-final-response', { wait: 500, fullPage: true });

  // Engine health badge reflects the active mode honestly
  const healthText = await page.locator('header, div').filter({ hasText: 'VozCore online' }).first().textContent().catch(() => null);
  console.log('  engine badge:', (healthText ?? '').slice(0, 80));

  await browser.close();
  console.log('done →', OUT);
}

main().catch((error) => {
  console.error('VozCore visual QA crashed:', error);
  process.exit(1);
});
