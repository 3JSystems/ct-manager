const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const BASE = process.env.APP_URL || 'http://localhost:8769/ct-manager/';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8Dwn4GBgYGJAQpgDAAyoQIBl4BjEwAAAABJRU5ErkJggg==';

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  for (const u of ['**://fonts.googleapis.com/**','**://fonts.gstatic.com/**','**://alcdn.msauth.net/**','**://accounts.google.com/**'])
    await page.route(u, r => r.abort());
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('dialog', d => d.accept());

  await page.goto(BASE, { waitUntil: 'load' });

  // ── Build a job with photos at both job and CT level ──
  await page.click('text=+ New Job');
  await page.waitForTimeout(300);
  await page.locator('.field:has(label:text-is("Job Number *")) input').fill('BK-1');
  await page.locator('.field:has(label:text-is("Site Name *")) input').fill('Backup Site');
  await page.locator('.field:has(label:text-is("CT Serial Number *")) input').first().fill('CT-BK');
  await page.locator('.field:has(label:text-is("Burden (VA)")) input').first().fill('15');
  await page.setInputFiles('#photo-input-job-job', { name: 'site.png', mimeType: 'image/png', buffer: Buffer.from(PNG,'base64') });
  await page.waitForTimeout(500);
  const ctInput = await page.getAttribute('input[id^="photo-input-ct-"]', 'id');
  await page.setInputFiles('#' + ctInput, { name: 'ct.png', mimeType: 'image/png', buffer: Buffer.from(PNG,'base64') });
  await page.waitForTimeout(500);
  await page.click('text=Save');
  await page.waitForTimeout(400);

  const before = await page.evaluate(() => ({
    jobs: DB.getJobs().length,
    photoIds: Photos.allIn(DB.getJobs()[0]).map(p => p.id),
  }));
  console.log('Before export: jobs =', before.jobs, '| photos =', before.photoIds.length);

  // ── Export ──
  await page.evaluate(() => { state.set({ page: 'settings' }); render(); });
  await page.waitForTimeout(400);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('text=Export All Data (JSON)'),
  ]);
  const path = await download.path();
  const backup = JSON.parse(require('fs').readFileSync(path, 'utf8'));
  console.log('Backup file: version', backup.version,
    '| jobs', backup.jobs.length,
    '| photos embedded', Object.keys(backup.photos).length,
    '| size', (require('fs').statSync(path).size / 1024).toFixed(1) + 'KB');
  console.log('  photo payload is base64 image:', Object.values(backup.photos)[0].slice(0, 22) + '…');

  // ── Wipe the device completely: localStorage AND IndexedDB ──
  await page.evaluate(async () => {
    localStorage.clear();
    Photos.clearCache();
    const ids = await new Promise(r => {
      const q = indexedDB.open('ctm_photos', 1);
      q.onsuccess = () => { const t = q.result.transaction('photos','readwrite').objectStore('photos'); const c = t.clear(); c.onsuccess = () => r(true); };
    });
    return ids;
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);
  const wiped = await page.evaluate(() => DB.getJobs().length);
  console.log('\nAfter wipe: jobs =', wiped, '(want 0)');

  // ── Import the backup ──
  await page.evaluate(() => { state.set({ page: 'settings' }); render(); });
  await page.waitForTimeout(400);
  await page.setInputFiles('#import-input', path);
  await page.waitForTimeout(1200);

  const after = await page.evaluate(async () => {
    const jobs = DB.getJobs();
    const keys = await new Promise(r => {
      const q = indexedDB.open('ctm_photos', 1);
      q.onsuccess = () => { const t = q.result.transaction('photos','readonly').objectStore('photos').getAllKeys(); t.onsuccess = () => r(t.result); };
    });
    return { jobs: jobs.length, jobNumber: jobs[0]?.jobNumber, burden: jobs[0]?.cts[0]?.burden, blobKeys: keys };
  });
  console.log('After import: jobs =', after.jobs, '| job =', after.jobNumber, '| burden =', after.burden);
  console.log('  photo blobs restored:', after.blobKeys.length, '(want 2)');
  console.log('  same photo ids as before:', JSON.stringify(after.blobKeys.sort()) === JSON.stringify(before.photoIds.sort()));

  // ── The real proof: do the photos actually render after restore? ──
  await page.evaluate(() => { state.set({ page: 'list' }); render(); });
  await page.waitForTimeout(300);
  await page.click('text=BK-1');
  await page.waitForTimeout(900);
  const rendered = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('.photo-thumb img')];
    return { count: imgs.length, allLoaded: imgs.length > 0 && imgs.every(i => i.complete && i.naturalWidth > 0) };
  });
  console.log('  photos render after restore:', JSON.stringify(rendered), '(want 2, true)');
  console.log('\nerrors:', errs);
  await browser.close();
})();
