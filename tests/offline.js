const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // block the optional CDNs the way a real offline phone would
  await page.route('**://fonts.googleapis.com/**', r => r.abort());
  await page.route('**://fonts.gstatic.com/**', r => r.abort());
  await page.route('**://alcdn.msauth.net/**', r => r.abort());
  await page.route('**://accounts.google.com/**', r => r.abort());

  const BASE = process.env.APP_URL || 'http://localhost:8769/ct-manager/';
  await page.goto(BASE, { waitUntil: 'load' });

  // wait for the service worker to install + activate
  const swState = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return { scope: reg.scope, active: !!reg.active };
  });
  console.log('SW:', swState);

  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const c = await caches.open(names[0]);
    return { cacheName: names[0], entries: (await c.keys()).map(r => r.url) };
  });
  console.log('CACHED:', cached);

  // create a job so we have data to prove persistence
  await page.click('text=+ New Job');
  await page.waitForTimeout(200);
  await page.locator('.field:has(label:text-is("Job Number *")) input').fill('JOB-001');
  await page.locator('.field:has(label:text-is("Site Name *")) input').fill('Test Substation');
  await page.locator('.field:has(label:text-is("Site Address")) input').fill('12 Example Way');
  await page.locator('.field:has(label:text-is("CT Serial Number *")) input').first().fill('CT-98765');
  await page.locator('.field:has(label:text-is("Ratio")) input').first().fill('200/5');
  await page.locator('.field:has(label:text-is("Burden (VA)")) input').first().fill('15');
  await page.locator('.field:has(label:text-is("Panel Serial No.")) input').first().fill('SWG-4421');
  await page.click('text=Save');
  await page.waitForTimeout(400);

  // NOW go fully offline and reload — this is the real test
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);

  const offlineBody = await page.textContent('body');
  console.log('--- OFFLINE RELOAD ---');
  console.log('App shell rendered:', offlineBody.includes('New Job'));
  console.log('Saved job survived:', offlineBody.includes('JOB-001'), '|', offlineBody.includes('Test Substation'));

  // open the saved job offline and confirm the CT data is intact
  await page.click('text=JOB-001');
  await page.waitForTimeout(400);
  const jobVals = await page.$$eval('input', els => els.map(e => e.value).filter(Boolean));
  console.log('Field values offline:', jobVals.filter(v => ['JOB-001','Test Substation','12 Example Way','CT-98765','200/5','15','SWG-4421'].includes(v)));

  await browser.close();
})();
