const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const BASE = process.env.APP_URL || 'http://localhost:8769/ct-manager/';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8Dwn4GBgYGJAQpgDAAyoQIBl4BjEwAAAABJRU5ErkJggg==';

const CONFIG = JSON.stringify({
  apiKey: 'fake-api-key',
  authDomain: 'ct-manager-test.firebaseapp.com',
  projectId: 'ct-manager-test',
  storageBucket: 'ct-manager-test.appspot.com',
  useEmulator: true,
});

let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (d ? '\n         ' + d : ''))); };

// A "device" = its own browser context, i.e. its own localStorage + IndexedDB
async function device(browser, label, email) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(label + ' PAGEERROR: ' + e.message));
  page.on('dialog', d => d.accept());
  await page.route('**://fonts.googleapis.com/**', r => r.abort());
  await page.addInitScript(cfg => {
    localStorage.setItem('ctm_settings', JSON.stringify({ firebaseConfig: cfg }));
  }, CONFIG);
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  // Sign in with a Google credential, as production does — carries email_verified,
  // which the security rules require.
  await page.evaluate(async (em) => {
    await Cloud.init();
    const cred = firebase.auth.GoogleAuthProvider.credential(
      JSON.stringify({ sub: 'uid-' + em, email: em, email_verified: true }));
    await Cloud._auth.signInWithCredential(cred);
  }, email);
  await page.waitForTimeout(600);
  const who = await page.evaluate(() => Cloud.userEmail());
  return { ctx, page, errs, label, who };
}

const sync = async d => { await d.page.evaluate(() => Cloud.syncAll()); await d.page.waitForTimeout(1500); };
const jobs = d => d.page.evaluate(() => DB.getJobs());

(async () => {
  // Reset the emulator so counts are reproducible across runs
  await fetch('http://127.0.0.1:8080/emulator/v1/projects/ct-manager-test/databases/(default)/documents', { method: 'DELETE' });

  // Load the SHIPPED rules, with the colleague added to the allow-list, so the two-device
  // flow is exercised through the same rules that will run in production.
  const shipped = require('fs').readFileSync(require('path').join(__dirname, '..', 'firestore.rules'), 'utf8')
    .replace("'joshsmounce@gmail.com'", "'joshsmounce@gmail.com',\n        'office@3jsystems.co.uk'");
  await fetch('http://127.0.0.1:8080/emulator/v1/projects/ct-manager-test:securityRules', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: shipped }] } }),
  });

  const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--no-sandbox'] });

  const phone = await device(browser, 'phone', 'joshsmounce@gmail.com');
  const pc = await device(browser, 'pc', 'office@3jsystems.co.uk');
  console.log('\nSIGN-IN');
  check('phone signed in', phone.who === 'joshsmounce@gmail.com', phone.who);
  check('pc signed in', pc.who === 'office@3jsystems.co.uk', pc.who);

  // ── Phone creates a job with a photo, syncs up ──
  console.log('\nPUSH FROM PHONE');
  await phone.page.evaluate(() => {
    const j = blankJob();
    j.id = 'shared-1'; j.jobNumber = 'JOB-100'; j.siteName = 'Alpha Substation';
    j.siteAddress = '1 Old Road'; j.cts[0].id = 'ct-1'; j.cts[0].serialNumber = 'CT-AAA';
    j.cts[0].ratio = '100/5'; j.cts[0].burden = '10';
    DB.upsertJob(j);
  });
  await phone.page.setInputFiles('#photo-input-job-job', { name: 's.png', mimeType: 'image/png', buffer: Buffer.from(PNG,'base64') })
    .catch(async () => {
      // no job open; attach the photo through the store directly
      await phone.page.evaluate(async () => {
        const blob = await (await fetch('data:image/jpeg;base64,/9j/4AAQSkZJRg==')).blob();
        await Photos.put('ph-1', blob);
        const j = DB.getJob('shared-1'); j.photos = [{ id:'ph-1', name:'s.jpg', takenAt:new Date().toISOString() }];
        DB.upsertJob(j);
      });
    });
  await sync(phone);
  let pj = await jobs(phone);
  check('job pushed to Firestore', pj.length === 1 && pj[0].jobNumber === 'JOB-100');
  check('photo got a storagePath', !!(pj[0].photos[0] && pj[0].photos[0].storagePath), JSON.stringify(pj[0].photos));

  // ── PC pulls it down ──
  console.log('\nPULL TO PC');
  await sync(pc);
  let cj = await jobs(pc);
  check('pc received the job', cj.length === 1 && cj[0].jobNumber === 'JOB-100', JSON.stringify(cj.map(j=>j.jobNumber)));
  check('  …with CT readings intact', cj[0].cts[0].serialNumber === 'CT-AAA' && cj[0].cts[0].burden === '10');
  check('  …and photo metadata', cj[0].photos.length === 1 && !!cj[0].photos[0].storagePath);

  const dl = await pc.page.evaluate(async () => {
    const j = DB.getJob('shared-1');
    const n = await Cloud.fetchMissingPhotos(j);
    return { downloaded: n, hasBlob: !!(await Photos.getBlob(j.photos[0].id)) };
  });
  check('  …and the photo bytes download on demand', dl.downloaded === 1 && dl.hasBlob, JSON.stringify(dl));

  // ── THE REAL TEST: both edit different fields of the same job, offline ──
  console.log('\nCONCURRENT OFFLINE EDITS (different fields)');
  await phone.page.evaluate(() => {
    const j = DB.getJob('shared-1'); j.cts[0].burden = '15'; j.cts[0].ratio = '200/5'; DB.upsertJob(j);
  });
  await pc.page.evaluate(() => {
    const j = DB.getJob('shared-1'); j.siteAddress = '2 New Road'; j.clientContact = 'Dave'; DB.upsertJob(j);
  });
  await sync(phone);
  await sync(pc);
  await sync(phone);   // phone pulls the office's change back

  pj = await jobs(phone); cj = await jobs(pc);
  check('phone keeps its own reading', pj[0].cts[0].burden === '15', pj[0].cts[0].burden);
  check('phone receives the office address', pj[0].siteAddress === '2 New Road', pj[0].siteAddress);
  check('pc keeps its address edit', cj[0].siteAddress === '2 New Road', cj[0].siteAddress);
  check('pc receives the engineer reading', cj[0].cts[0].burden === '15', cj[0].cts[0].burden);
  check('  …and the ratio', cj[0].cts[0].ratio === '200/5', cj[0].cts[0].ratio);
  const conf = await phone.page.evaluate(() => Cloud.conflicts.length);
  check('no false conflict for disjoint edits', conf === 0, 'conflicts=' + conf);

  // ── Genuine conflict: same field, different values ──
  console.log('\nGENUINE CONFLICT (same field)');
  await phone.page.evaluate(() => { const j = DB.getJob('shared-1'); j.cts[0].burden = '20'; DB.upsertJob(j); });
  await pc.page.evaluate(() => { const j = DB.getJob('shared-1'); j.cts[0].burden = '30'; DB.upsertJob(j); });
  await sync(phone);
  await sync(pc);
  const pcConf = await pc.page.evaluate(() => JSON.parse(JSON.stringify(Cloud.conflicts)));
  cj = await jobs(pc);
  check('conflict is reported, not silently resolved', pcConf.length === 1 && pcConf[0].items.length === 1, JSON.stringify(pcConf));
  check('  …naming both values', pcConf[0] && pcConf[0].items[0].local === '30' && pcConf[0].items[0].remote === '20', JSON.stringify(pcConf[0] && pcConf[0].items[0]));
  check('  …and neither value is lost from view', cj[0].cts[0].burden === '30');

  // ── Delete propagates ──
  console.log('\nDELETE');
  await pc.page.evaluate(() => { DB.deleteJob('shared-1'); Cloud.markDeleted('shared-1'); });
  await sync(pc);
  await sync(phone);
  pj = await jobs(phone);
  check('delete on pc removes it from phone', pj.length === 0, JSON.stringify(pj.map(j=>j.jobNumber)));

  console.log('\nerrors:', [...phone.errs, ...pc.errs]);
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
