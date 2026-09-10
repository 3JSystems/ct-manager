const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const BASE = process.env.APP_URL || 'http://localhost:8769/ct-manager/';
const CONFIG = JSON.stringify({apiKey:'fake-api-key',authDomain:'ct-manager-test.firebaseapp.com',projectId:'ct-manager-test',storageBucket:'ct-manager-test.appspot.com',useEmulator:true});
let pass=0,fail=0; const check=(n,c,d)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(d?'\n         '+d:'')));};

// The emulator's Google sign-in mints a verified email, matching production.
async function asUser(browser, email) {
  const p = await (await browser.newContext()).newPage();
  await p.route('**://fonts.googleapis.com/**', r=>r.abort());
  await p.addInitScript(c=>localStorage.setItem('ctm_settings',JSON.stringify({firebaseConfig:c})),CONFIG);
  await p.goto(BASE,{waitUntil:'load'});
  await p.waitForTimeout(300);
  return { p, res: await p.evaluate(async (em) => {
    await Cloud.init();
    // signInWithCredential using a fabricated Google idToken → email_verified true
    const cred = firebase.auth.GoogleAuthProvider.credential(
      JSON.stringify({ sub: 'uid-' + em, email: em, email_verified: true }));
    await Cloud._auth.signInWithCredential(cred);
    const out = {};
    try { await Cloud._db.collection('jobs').doc('rules-probe').set({ job: { id:'x' } }); out.write = 'allowed'; }
    catch (e) { out.write = 'denied:' + e.code; }
    try { await Cloud._db.collection('jobs').get(); out.read = 'allowed'; }
    catch (e) { out.read = 'denied:' + e.code; }
    return out;
  }, email) };
}

(async () => {
  const b = await chromium.launch({executablePath: process.env.CHROME,args:['--no-sandbox']});
  console.log('\nSECURITY RULES');
  const allowed = await asUser(b, 'joshsmounce@gmail.com');
  check('allow-listed account can write', allowed.res.write === 'allowed', JSON.stringify(allowed.res));
  check('allow-listed account can read', allowed.res.read === 'allowed', JSON.stringify(allowed.res));

  const stranger = await asUser(b, 'someone-else@gmail.com');
  check('account NOT on the list is denied write', stranger.res.write.startsWith('denied'), JSON.stringify(stranger.res));
  check('account NOT on the list is denied read', stranger.res.read.startsWith('denied'), JSON.stringify(stranger.res));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await b.close(); process.exit(fail?1:0);
})();
