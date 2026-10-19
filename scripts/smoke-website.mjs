import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Optional developer QA: use an installed Playwright package/browser. Neither is
// required by the deployed site. Only an existing loopback preview is exercised.
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = new URL(process.env.LITTLE_WEBSITE_QA_URL || 'http://127.0.0.1:4173');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.protocol !== 'http:' || origin.username || origin.password || origin.pathname !== '/') throw new Error('Website QA requires a loopback HTTP origin.');
const { chromium } = require(process.env.LITTLE_WEBSITE_PLAYWRIGHT_MODULE || 'playwright');
const product = JSON.parse(await readFile(path.join(root, 'website', 'product.json'), 'utf8'));
const screenshots = path.join(root, 'desktop', 'screenshots');
const reportPath = path.join(root, 'desktop', 'logs', 'website-react-browser-qa.json');
await mkdir(screenshots, { recursive: true });
await mkdir(path.dirname(reportPath), { recursive: true });
const report = { checkedAt: new Date().toISOString(), success: false, scope: 'Local React pages; review-success UI uses an explicit isolated mock, not a hosted database.', checks: [], geometry: [], errors: [], screenshots: [] };
const check = (name, condition) => { assert(condition, name); report.checks.push(name); };
const browser = await chromium.launch({ headless: true, ...(process.env.LITTLE_WEBSITE_BROWSER ? { executablePath: process.env.LITTLE_WEBSITE_BROWSER } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
page.on('pageerror', error => report.errors.push(error.message));
async function visit(route) { await page.goto(new URL(route, origin).href, { waitUntil: 'networkidle' }); await page.evaluate(() => document.fonts.ready); }
async function screenshot(name) { await page.screenshot({ path: path.join(screenshots, name) }); report.screenshots.push(`desktop/screenshots/${name}`); }
async function geometry(route, width) {
  await page.setViewportSize({ width, height: 900 }); await visit(route);
  const value = await page.evaluate(() => ({ viewport: window.innerWidth, content: document.documentElement.scrollWidth }));
  report.geometry.push({ route, width, ...value }); check(`No page overflow: ${route} at ${width}px`, value.content <= value.viewport);
}
try {
  await visit('/');
  check('Homepage React hydration', (await page.locator('h1').innerText()).includes('Little Code.'));
  check('Workspace image loaded', await page.locator('.workspace-image').evaluate(image => image.complete && image.naturalWidth > 0));
  await screenshot('react-showcase-home.png');
  for (let index = 0; index < 4; index++) { await page.locator(`#mode-${index}`).click(); check(`Mode ${index + 1} panel binding`, await page.locator('#mode-panel').getAttribute('aria-labelledby') === `mode-${index}`); }
  await page.locator('#mode-3').press('Home'); check('Mode Home keyboard navigation', await page.locator('#mode-0').getAttribute('aria-selected') === 'true');
  for (let index = 0; index < 9; index++) { await page.locator(`#framework-${index}`).click(); check(`Framework ${index + 1} panel binding`, await page.locator('#framework-panel').getAttribute('aria-labelledby') === `framework-${index}`); }
  await page.locator('#framework-8').press('ArrowRight'); check('Framework keyboard wrap', await page.locator('#framework-0').getAttribute('aria-selected') === 'true');
  const capture = page.locator('.hero-workspace .capture-button');
  await capture.click(); check('Product screenshot opens', await page.locator('dialog[open]').count() === 1); await page.keyboard.press('Escape'); check('Product screenshot closes and restores focus', await capture.evaluate(element => element === document.activeElement));
  await page.getByRole('button', { name: 'Switch to dark appearance', exact: true }).click(); check('Dark theme', await page.locator('html').getAttribute('data-theme') === 'dark');
  await visit('/docs');
  check('Theme persists to docs', await page.locator('html').getAttribute('data-theme') === 'dark');
  await screenshot('react-documentation-dark.png');
  await page.getByRole('textbox', { name: 'Search documentation' }).fill('flutter');
  await page.locator('.docs-search-results').getByRole('link', { name: /Flutter preview/ }).click();
  check('Documentation search navigates', new URL(page.url()).pathname === '/docs/flutter');
  await visit('/docs/getting-started');
  const docCapture = page.getByRole('button', { name: /Enlarge screenshot/ }).first(); await docCapture.click(); check('Documentation screenshot opens', await page.locator('dialog[open]').count() === 1); await page.keyboard.press('Escape'); check('Documentation screenshot focus restoration', await docCapture.evaluate(element => element === document.activeElement));
  await visit('/docs/installation');
  const hashBlock = page.locator('.docs-code').filter({ hasText: 'Expected SHA-256' }); await hashBlock.getByRole('button', { name: 'Copy', exact: true }).click();
  check('Installation checksum copy', await page.evaluate(() => navigator.clipboard.readText()) === product.sha256);
  check('Installation illustration is labeled', await page.getByText('Process illustration · not a setup screenshot', { exact: true }).count() === 1);
  await page.getByRole('button', { name: 'Switch to light appearance', exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0)); await screenshot('react-docs-installation.png');
  await visit('/#download');
  await page.locator('#download-setup').filter({ hasText: 'Download for Windows' }).waitFor();
  check('Local setup download verified', await page.locator('#download-setup').getAttribute('href') === `/downloads/${product.fileName}`);
  await page.locator('.checksum summary').click();
  check('Displayed checksum matches release', await page.locator('.checksum code').innerText() === product.sha256);
  await visit('/reviews');
  await page.getByText(/Community reviews will open once the review service is connected/).waitFor();
  check('Unconfigured reviews show no invented score', await page.locator('.rr-score>strong').innerText() === '—');
  check('Unconfigured review submit disabled', await page.getByRole('button', { name: 'Submit for moderation' }).isDisabled());
  await screenshot('react-community-unconfigured.png');
  for (const width of [320, 390, 768]) for (const route of ['/', '/docs', '/docs/installation', '/docs/file-tools', '/reviews']) await geometry(route, width);
  await page.setViewportSize({ width: 390, height: 844 }); await visit('/');
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click(); check('Mobile menu expanded', await page.getByRole('button', { name: 'Close navigation', exact: true }).getAttribute('aria-expanded') === 'true');
  await page.keyboard.press('Escape'); check('Mobile menu Escape', await page.getByRole('button', { name: 'Open navigation', exact: true }).getAttribute('aria-expanded') === 'false');
  await screenshot('react-showcase-mobile.png');
  await visit('/docs/installation'); await page.getByRole('button', { name: 'Browse documentation' }).click(); check('Docs mobile menu expanded', await page.getByRole('button', { name: 'Browse documentation' }).getAttribute('aria-expanded') === 'true');
  await page.keyboard.press('Escape'); check('Docs mobile menu Escape', await page.getByRole('button', { name: 'Browse documentation' }).getAttribute('aria-expanded') === 'false'); await screenshot('react-docs-mobile.png');

  // Simulated backend exists only in this test browser. Never publish these rows.
  const mocked = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
  const mockPage = await mocked.newPage(); mockPage.on('pageerror', error => report.errors.push(error.message));
  let submitted; const queries = [];
  const rows = [{id:'00000000-0000-4000-8000-000000000001',name:'Browser QA fixture',rating:5,title:'Illustrative test review',body:'This isolated test checks the community interface, not a public testimonial.',version:product.version,createdAt:'2026-10-19T00:00:00Z'}];
  await mocked.route('**/api/reviews?*', async route => { const query = new URL(route.request().url()).searchParams; queries.push(Object.fromEntries(query)); const filtered = query.get('rating') === 'all' ? rows : rows.filter(row => String(row.rating) === query.get('rating')); await route.fulfill({ status:200,contentType:'application/json',body:JSON.stringify({configured:true,reviews:filtered,aggregate:{count:1,average:5,distribution:{1:0,2:0,3:0,4:0,5:1}},page:Number(query.get('page')),pageSize:6,hasMore:false}) }); });
  await mocked.route('**/api/reviews', async route => { submitted = route.request().postDataJSON(); await route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({message:'Your review was received and is awaiting moderation.'})}); });
  await mockPage.goto(new URL('/reviews',origin).href,{waitUntil:'networkidle'});
  check('Mock approved review renders', await mockPage.locator('.rr-score>strong').innerText() === '5.0');
  await mockPage.getByRole('combobox', { name:'Filter reviews by rating', exact:true }).selectOption('3'); await mockPage.getByText('No reviews with this rating yet.', { exact:true }).waitFor(); check('Rating filter requests selected rating', queries.some(query=>query.rating==='3'));
  await mockPage.getByRole('combobox', { name:'Filter reviews by rating', exact:true }).selectOption('all'); await mockPage.getByRole('heading',{name:'Illustrative test review',exact:true}).waitFor();
  await mockPage.getByRole('radio',{name:'5 stars',exact:true}).check();
  await mockPage.getByRole('textbox',{name:'Display name',exact:true}).fill('Review UI fixture'); await mockPage.getByRole('textbox',{name:'Review title',exact:true}).fill('A pending browser test');
  await mockPage.getByRole('textbox',{name:/Your review/}).fill('This is an isolated form test, kept outside the actual community service.'); await mockPage.getByRole('checkbox').check();
  await mockPage.getByRole('button',{name:'Submit for moderation'}).click(); await mockPage.getByText(/Thank you. Your review was received and is awaiting moderation/).waitFor();
  check('Review form sends rating and version', submitted?.rating===5&&submitted?.version===product.version&&submitted?.website==='');
  check('Pending review does not inflate public score', await mockPage.locator('.rr-score>p').innerText()==='1 published review');
  await mocked.close();
  check('No browser JavaScript errors', report.errors.length===0);
  report.success=true;
} catch (error) { report.failure=error.message; process.exitCode=1; }
finally { await browser.close(); await writeFile(reportPath,JSON.stringify(report,null,2)+'\n'); }
console.log(JSON.stringify({success:report.success,checks:report.checks.length,failure:report.failure,report:'desktop/logs/website-react-browser-qa.json'}));
