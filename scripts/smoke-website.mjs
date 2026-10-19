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
const report = { checkedAt: new Date().toISOString(), success: false, scope: 'Local React pages; review-success UI uses an explicit isolated mock, not a hosted database.', checks: [], geometry: [], typography: [], headings: [], targets: [], captures: [], errors: [], screenshots: [] };
const check = (name, condition) => {
  assert(condition, name);
  report.checks.push(name);
  if (report.checks.length % 10 === 0) console.log(`Website QA: ${report.checks.length} checks passed; ${name}`);
};
const browser = await chromium.launch({ headless: true, ...(process.env.LITTLE_WEBSITE_BROWSER ? { executablePath: process.env.LITTLE_WEBSITE_BROWSER } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
page.setDefaultTimeout(12_000);
page.setDefaultNavigationTimeout(20_000);
page.on('pageerror', error => report.errors.push(error.message));
async function visit(route) {
  // Product pages perform independent release/review requests. Document content,
  // its primary heading and fonts are the stable readiness contract for layout.
  try {
    await page.goto(new URL(route, origin).href, { waitUntil: 'domcontentloaded' });
    await page.locator('h1').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.fonts.status === 'loaded');
    await page.evaluate(() => document.fonts.ready);
  } catch (error) {
    report.navigationFailure = { route, url: page.url(), message: error.message };
    throw error;
  }
}
async function screenshot(name) { await page.screenshot({ path: path.join(screenshots, name) }); report.screenshots.push(`desktop/screenshots/${name}`); }
async function geometry(route, width) {
  await page.setViewportSize({ width, height: 900 }); await visit(route);
  const value = await page.evaluate(() => ({ viewport: window.innerWidth, content: document.documentElement.scrollWidth, fontStatus: document.fonts.status }));
  report.geometry.push({ route, width, ...value }); check(`No page overflow: ${route} at ${width}px`, value.content <= value.viewport);
  check(`Local fonts finish loading: ${route} at ${width}px`, value.fontStatus === 'loaded');
  await readability(route, width);
  await headingStructure(route, width);
  if (width <= 390) await headerTargets(route, width);
}

// Evaluate representative reading text rather than every decorative micro-label.
// These floors express reading/touch requirements, not one exact design scale.
async function readability(route, width) {
  const selector = route.startsWith('/docs/') ? '.docs-article-header>p,.docs-section>p'
    : route === '/docs' ? '.docs-intro>p,.docs-guide-card p'
      : route === '/reviews' ? '.community-hero>p,.rr-heading>p,.rr-form-intro'
        : '.hero-description,.section-heading>p,.file-editorial p,.docs-promo-copy p,.journey-timeline p,.download-copy>p';
  const samples = await page.locator(selector).evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const zero = context.measureText('0').width;
    return { text: element.textContent.trim().slice(0, 70), fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight), fontFamily: style.fontFamily, width: box.width, measureCh: zero ? box.width / zero : null, visible: box.width > 0 && box.height > 0 };
  }));
  const visible = samples.filter(sample => sample.visible);
  report.typography.push({ route, viewport: width, samples: visible });
  check(`Reading text exists: ${route} at ${width}px`, visible.length > 0);
  check(`Readable prose size: ${route} at ${width}px`, visible.every(sample => sample.fontSize >= 15));
  check(`Readable prose leading: ${route} at ${width}px`, visible.every(sample => sample.lineHeight / sample.fontSize >= 1.45));
  if (route.startsWith('/docs/') && width >= 1024) check(`Bounded documentation line length: ${route} at ${width}px`, visible.every(sample => sample.measureCh !== null && sample.measureCh <= 85));
}

async function headingStructure(route, width) {
  const headings = await page.locator('main h1,main h2,main h3,main h4,main h5,main h6').evaluateAll(elements => elements.map(element => ({ level: Number(element.tagName.slice(1)), text: element.textContent.trim() })));
  report.headings.push({ route, viewport: width, headings });
  check(`One semantic primary heading: ${route} at ${width}px`, headings.filter(heading => heading.level === 1).length === 1);
  check(`Content begins with its primary heading: ${route} at ${width}px`, headings[0]?.level === 1);
  check(`Headings contain text: ${route} at ${width}px`, headings.every(heading => heading.text.length > 0));
  check(`Heading levels progress in order: ${route} at ${width}px`, headings.every((heading, index) => index === 0 || heading.level <= headings[index - 1].level + 1));
}

async function headerTargets(route, width) {
  const targets = await page.locator('header button,header a').evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { label: element.getAttribute('aria-label') || element.textContent.trim(), width: box.width, height: box.height, visible: style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0 };
  }).filter(element => element.visible));
  report.targets.push({ route, viewport: width, location: 'header', targets });
  check(`Mobile header touch targets: ${route} at ${width}px`, targets.length > 0 && targets.every(target => target.width >= 44 && target.height >= 44));
}

async function screenshotFormatting(route) {
  const figures = page.locator('.docs-figure');
  check(`Documentation includes real product captures: ${route}`, await figures.count() > 0);
  for (let index = 0; index < await figures.count(); index++) {
    const figure = figures.nth(index);
    const image = figure.locator('button img').first();
    await image.scrollIntoViewIfNeeded();
    await image.evaluate(element => element.decode());
    const value = await figure.evaluate(element => {
      const image = element.querySelector('button img');
      const caption = element.querySelector('figcaption');
      const captionFonts = [caption, ...caption.querySelectorAll('strong,span')].filter(node => node.textContent.trim()).map(node => parseFloat(getComputedStyle(node).fontSize));
      const label = element.querySelector('.docs-figure-heading');
      return { source: image.getAttribute('src'), alt: image.alt, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, width: Number(image.getAttribute('width')), height: Number(image.getAttribute('height')), caption: caption.textContent.trim(), captionFont: Math.min(...captionFonts), label: label?.textContent.trim() || '' };
    });
    report.captures.push({ route, ...value });
    check(`Product capture dimensions and description: ${route} ${index + 1}`, value.alt.length > 0 && value.width === value.naturalWidth && value.height === value.naturalHeight);
    check(`Readable screenshot caption: ${route} ${index + 1}`, value.caption.length > 0 && value.captionFont >= 12);
    check(`Real capture is identified: ${route} ${index + 1}`, value.label.includes('ACTUAL APP CAPTURE'));
  }
}

async function desktopProductNavigation() {
  await page.setViewportSize({ width: 1440, height: 1000 }); await visit('/');
  const trigger = page.getByRole('button', { name: 'Explore Little Code', exact: true });
  const panel = page.locator('#lc-nav-product-panel');
  await trigger.click();
  check('Desktop product disclosure opens', await trigger.getAttribute('aria-expanded') === 'true' && await panel.isVisible());
  await trigger.press('Tab');
  check('Desktop product links receive keyboard focus', await panel.evaluate(element => element.contains(document.activeElement)));
  await page.keyboard.press('Escape');
  check('Desktop product Escape restores focus', await trigger.getAttribute('aria-expanded') === 'false' && await trigger.evaluate(element => element === document.activeElement));
  await trigger.click();
  // The open panel overlaps the hero heading. Use an actual outside control
  // whose hit target stays exposed, then verify that its own focus survives.
  const outside = page.getByRole('button', { name: /^Switch to (?:light|dark) appearance$/ });
  await outside.click();
  check('Desktop product outside pointer closes without stealing focus', await trigger.getAttribute('aria-expanded') === 'false' && await outside.evaluate(element => element === document.activeElement));
  await outside.click(); // Restore the appearance selected before this check.
  await trigger.click();
  const links = panel.locator('a');
  for (let index = 0; index <= await links.count(); index++) await page.keyboard.press('Tab');
  check('Desktop product Tab outside closes disclosure', await trigger.getAttribute('aria-expanded') === 'false');
}
try {
  await visit('/');
  check('Homepage React hydration', (await page.locator('h1').innerText()).includes('Little Code.'));
  await page.waitForFunction(() => { const image = document.querySelector('.workspace-image'); return image?.complete && image.naturalWidth > 0; });
  check('Workspace image loaded', await page.locator('.workspace-image').evaluate(image => image.complete && image.naturalWidth > 0));
  await screenshot('tactile-showcase-home.png');
  await desktopProductNavigation();
  for (let index = 0; index < 4; index++) { await page.locator(`#mode-${index}`).click(); check(`Mode ${index + 1} panel binding`, await page.locator('#mode-panel').getAttribute('aria-labelledby') === `mode-${index}`); }
  await page.locator('#mode-3').press('Home'); check('Mode Home keyboard navigation', await page.locator('#mode-0').getAttribute('aria-selected') === 'true');
  for (let index = 0; index < 9; index++) { await page.locator(`#framework-${index}`).click(); check(`Framework ${index + 1} panel binding`, await page.locator('#framework-panel').getAttribute('aria-labelledby') === `framework-${index}`); }
  await page.locator('#framework-8').press('ArrowRight'); check('Framework keyboard wrap', await page.locator('#framework-0').getAttribute('aria-selected') === 'true');
  const capture = page.locator('.hero-workspace .capture-button');
  await capture.click(); check('Product screenshot opens', await page.locator('dialog[open]').count() === 1); await page.keyboard.press('Escape'); check('Product screenshot closes and restores focus', await capture.evaluate(element => element === document.activeElement));
  await page.getByRole('button', { name: 'Switch to dark appearance', exact: true }).click(); check('Dark theme', await page.locator('html').getAttribute('data-theme') === 'dark');
  await page.evaluate(() => window.scrollTo(0, 0)); await screenshot('tactile-showcase-dark.png');
  await visit('/docs');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  check('Theme persists to docs', await page.locator('html').getAttribute('data-theme') === 'dark');
  await screenshot('tactile-documentation-dark.png');
  await page.getByRole('textbox', { name: 'Search documentation' }).fill('flutter');
  await page.locator('.docs-search-results').getByRole('link', { name: /Flutter preview/ }).click();
  check('Documentation search navigates', new URL(page.url()).pathname === '/docs/flutter');
  await visit('/docs/getting-started');
  const docCapture = page.getByRole('button', { name: /Enlarge screenshot/ }).first(); await docCapture.click(); check('Documentation screenshot opens', await page.locator('dialog[open]').count() === 1); await page.keyboard.press('Escape'); check('Documentation screenshot focus restoration', await docCapture.evaluate(element => element === document.activeElement));
  await screenshotFormatting('/docs/getting-started');
  await visit('/docs/installation');
  const hashBlock = page.locator('.docs-code').filter({ hasText: 'Expected SHA-256' }); await hashBlock.getByRole('button', { name: 'Copy', exact: true }).click();
  check('Installation checksum copy', await page.evaluate(() => navigator.clipboard.readText()) === product.sha256);
  check('Installation illustration is labeled', await page.getByText('Process illustration · not a setup screenshot', { exact: true }).count() === 1);
  await page.getByRole('button', { name: 'Switch to light appearance', exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0)); await screenshot('tactile-docs-installation.png');
  await visit('/docs'); await screenshot('tactile-documentation.png');
  await visit('/docs/file-tools'); await screenshotFormatting('/docs/file-tools');
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
  for (const width of [320, 360, 390, 768, 1024, 1440]) for (const route of ['/', '/docs', '/docs/installation', '/docs/file-tools', '/reviews']) await geometry(route, width);
  await page.setViewportSize({ width: 320, height: 900 }); await visit('/');
  for (let index = 0; index < 9; index++) {
    await page.locator(`#framework-${index}`).click();
    const bounds = await page.locator('#framework-panel').evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth, pageWidth: document.documentElement.scrollWidth, viewport: window.innerWidth }));
    check(`Narrow framework ${index + 1} wraps within its panel`, bounds.content <= bounds.width + 1 && bounds.pageWidth <= bounds.viewport);
  }
  await page.setViewportSize({ width: 390, height: 844 }); await visit('/');
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click(); check('Mobile menu expanded', await page.getByRole('button', { name: 'Close navigation', exact: true }).getAttribute('aria-expanded') === 'true');
  await headerTargets('/', 390);
  check('Mobile drawer exposes product destinations', await page.locator('#site-navigation .lc-nav-mobile-products a:visible').count() === 5);
  await page.keyboard.press('Escape'); check('Mobile menu Escape', await page.getByRole('button', { name: 'Open navigation', exact: true }).getAttribute('aria-expanded') === 'false');
  check('Mobile menu Escape restores trigger focus', await page.getByRole('button', { name: 'Open navigation', exact: true }).evaluate(element => element === document.activeElement));
  await screenshot('tactile-mobile.png');
  await visit('/docs/installation'); const docsMenu = page.locator('.docs-mobile-bar button'); await docsMenu.click(); check('Docs mobile menu expanded', await docsMenu.getAttribute('aria-expanded') === 'true');
  await page.keyboard.press('Escape'); check('Docs mobile menu Escape', await docsMenu.getAttribute('aria-expanded') === 'false'); check('Docs mobile Escape restores focus', await docsMenu.evaluate(element => element === document.activeElement)); await screenshot('tactile-docs-mobile.png');

  // Simulated backend exists only in this test browser. Never publish these rows.
  const mocked = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
  const mockPage = await mocked.newPage();
  mockPage.setDefaultTimeout(12_000);
  mockPage.setDefaultNavigationTimeout(20_000);
  mockPage.on('pageerror', error => report.errors.push(error.message));
  let submitted; const queries = [];
  const rows = [{id:'00000000-0000-4000-8000-000000000001',name:'Browser QA fixture',rating:5,title:'Illustrative test review',body:'This isolated test checks the community interface, not a public testimonial.',version:product.version,createdAt:'2026-10-19T00:00:00Z'}];
  await mocked.route('**/api/reviews?*', async route => { const query = new URL(route.request().url()).searchParams; queries.push(Object.fromEntries(query)); const filtered = query.get('rating') === 'all' ? rows : rows.filter(row => String(row.rating) === query.get('rating')); await route.fulfill({ status:200,contentType:'application/json',body:JSON.stringify({configured:true,reviews:filtered,aggregate:{count:1,average:5,distribution:{1:0,2:0,3:0,4:0,5:1}},page:Number(query.get('page')),pageSize:6,hasMore:false}) }); });
  await mocked.route('**/api/reviews', async route => { submitted = route.request().postDataJSON(); await route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({message:'Your review was received and is awaiting moderation.'})}); });
  await mockPage.goto(new URL('/reviews',origin).href,{waitUntil:'domcontentloaded'});
  await mockPage.locator('h1').waitFor({ state:'visible' });
  await mockPage.getByRole('heading',{name:'Illustrative test review',exact:true}).waitFor();
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
