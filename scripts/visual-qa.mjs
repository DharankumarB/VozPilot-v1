/**
 * Visual QA helper (not part of the app): boots headless Chromium from the
 * npm-bundled binary and captures screenshots of key routes/viewports for
 * review. Run: node scripts/visual-qa.mjs
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

  // Extract the shared-library bundle even off Amazon Linux: Chromium needs
  // libnspr4/libnss3 from it. (glibc is forward compatible on this host.)
  const libDir = join(tmpdir(), 'al2023', 'lib');
  if (!existsSync(libDir)) {
    const binDir = join(process.cwd(), 'node_modules', '@sparticuz', 'chromium', 'bin');
    await inflate(join(binDir, 'al2023.tar.br')).catch((error) => console.warn('al2023 inflate:', error.message));
  }
  process.env.FONTCONFIG_PATH ??= join(tmpdir(), 'fonts');
  process.env.LD_LIBRARY_PATH = [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  console.log('LD_LIBRARY_PATH:', process.env.LD_LIBRARY_PATH);

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
    await page.waitForTimeout(opts.wait ?? 700);
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: Boolean(opts.fullPage) });
    console.log('  captured', name);
  };

  // 1. Login (logged out)
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await shot('01-login');

  // Register
  await page.goto(`${BASE}/register`, { waitUntil: 'networkidle' });
  await shot('02-register');

  // Create a fresh account for the visual run
  await page.goto(`${BASE}/register`, { waitUntil: 'networkidle' });
  await page.fill('#register-name', 'Visual QA');
  await page.fill('#register-email', `visual-${stamp}@vozpilot.test`);
  await page.fill('#register-password', 'VisualQA!2026');
  await page.click('button[type=submit]');
  await page.waitForURL(`${BASE}/`, { timeout: 15000 });
  await page.waitForLoadState('networkidle');
  await shot('03-overview', { waitUntil: 'networkidle' });
  await shot('03b-overview-full', { fullPage: true });

  const routes = [
    ['/command-center', '04-command-center'],
    ['/agents', '05-agent-hub'],
    ['/tasks', '06-task-manager'],
    ['/workflows', '07-workflows'],
    ['/memories', '08-memories'],
    ['/activity', '09-activity'],
    ['/approvals', '10-approvals'],
    ['/integrations', '11-integrations'],
    ['/analytics', '12-analytics'],
    ['/settings', '13-settings'],
  ];
  for (const [route, name] of routes) {
    await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
    await shot(name);
  }

  // Collapsed sidebar state
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.click('button[aria-label="Collapse sidebar"]');
  await shot('14-sidebar-collapsed');

  // Mobile viewport
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const mpage = await mobile.newPage();
  await mpage.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await mpage.screenshot({ path: `${OUT}/20-mobile-login.png` });
  console.log('  captured 20-mobile-login');

  // Log in on mobile to see dashboard
  await mpage.fill('#login-email', `visual-${stamp}@vozpilot.test`);
  await mpage.fill('#login-password', 'VisualQA!2026');
  await mpage.click('button[type=submit]');
  await mpage.waitForURL(`${BASE}/`, { timeout: 15000 });
  await mpage.waitForLoadState('networkidle');
  await mpage.screenshot({ path: `${OUT}/21-mobile-overview.png`, fullPage: true });
  console.log('  captured 21-mobile-overview');

  await mpage.click('button[aria-label="Open navigation"]');
  await mpage.waitForTimeout(500);
  await mpage.screenshot({ path: `${OUT}/22-mobile-nav.png` });
  console.log('  captured 22-mobile-nav');

  await mpage.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' });
  await mpage.screenshot({ path: `${OUT}/23-mobile-tasks.png`, fullPage: true });
  console.log('  captured 23-mobile-tasks');

  await browser.close();
  console.log('done →', OUT);
}

main().catch((error) => {
  console.error('visual QA failed:', error);
  process.exit(1);
});
