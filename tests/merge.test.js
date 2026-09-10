const { mergeJobs } = require(require('path').join(__dirname, '..', 'sync.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

const job = (over = {}) => ({
  id: 'j1', jobNumber: 'JOB-1', siteName: 'Alpha', siteAddress: '1 St', clientContact: '',
  cts: [{ id: 'c1', serialNumber: 'CT-1', ratio: '100/5', burden: '10', photos: [] }],
  photos: [], status: 'Draft', ...over,
});

const ct = (j, i = 0) => j.cts[i];

console.log('\nTHREE-WAY MERGE');

// ── 1. Disjoint edits both survive — the core requirement ──
{
  const base = job();
  const local = job(); local.cts[0].burden = '15';          // engineer on site
  const remote = job(); remote.siteAddress = '2 New Road';  // office
  const { merged, conflicts } = mergeJobs(base, local, remote);
  check('site edit + reading edit both survive',
    ct(merged).burden === '15' && merged.siteAddress === '2 New Road',
    `burden=${ct(merged).burden} address=${merged.siteAddress}`);
  check('  …and reports no conflict', conflicts.length === 0, JSON.stringify(conflicts));
}

// ── 2. Same field, different values = conflict, not silent loss ──
{
  const base = job();
  const local = job(); local.cts[0].ratio = '200/5';
  const remote = job(); remote.cts[0].ratio = '400/5';
  const { merged, conflicts } = mergeJobs(base, local, remote);
  check('same field changed both sides is flagged', conflicts.length === 1, JSON.stringify(conflicts));
  check('  …conflict names the field and both values',
    conflicts[0] && conflicts[0].path === 'cts.c1.ratio' && conflicts[0].local === '200/5' && conflicts[0].remote === '400/5',
    JSON.stringify(conflicts[0]));
  check('  …local value kept pending resolution', ct(merged).ratio === '200/5');
}

// ── 3. Identical edits on both sides are not a conflict ──
{
  const base = job();
  const local = job(); local.siteName = 'Bravo';
  const remote = job(); remote.siteName = 'Bravo';
  const { merged, conflicts } = mergeJobs(base, local, remote);
  check('same value both sides is not a conflict', conflicts.length === 0 && merged.siteName === 'Bravo');
}

// ── 4. New CT added on each side — both must appear ──
{
  const base = job();
  const local = job(); local.cts.push({ id: 'c2', serialNumber: 'CT-2', ratio: '', burden: '', photos: [] });
  const remote = job(); remote.cts.push({ id: 'c3', serialNumber: 'CT-3', ratio: '', burden: '', photos: [] });
  const { merged, conflicts } = mergeJobs(base, local, remote);
  const ids = merged.cts.map(c => c.id).sort();
  check('CTs added on both sides are both kept',
    JSON.stringify(ids) === JSON.stringify(['c1','c2','c3']), JSON.stringify(ids));
  check('  …with no conflict', conflicts.length === 0);
}

// ── 5. Delete propagates when the other side left it alone ──
{
  const base = job(); base.cts.push({ id: 'c2', serialNumber: 'CT-2', ratio: '', burden: '', photos: [] });
  const local = JSON.parse(JSON.stringify(base));
  const remote = JSON.parse(JSON.stringify(base));
  remote.cts = remote.cts.filter(c => c.id !== 'c2');   // office removed it
  const { merged, conflicts } = mergeJobs(base, local, remote);
  check('remote delete applies when untouched locally',
    merged.cts.map(c => c.id).join() === 'c1', merged.cts.map(c => c.id).join());
  check('  …with no conflict', conflicts.length === 0);
}

// ── 6. Delete vs edit — the dangerous one. Edited data must NOT vanish ──
{
  const base = job(); base.cts.push({ id: 'c2', serialNumber: 'CT-2', ratio: '', burden: '', photos: [] });
  const local = JSON.parse(JSON.stringify(base));
  local.cts[1].burden = '22';                            // engineer recorded a reading
  const remote = JSON.parse(JSON.stringify(base));
  remote.cts = remote.cts.filter(c => c.id !== 'c2');    // office deleted the CT
  const { merged, conflicts } = mergeJobs(base, local, remote);
  const kept = merged.cts.find(c => c.id === 'c2');
  check('edited CT survives a remote delete', !!kept && kept.burden === '22',
    JSON.stringify(merged.cts.map(c => c.id)));
  check('  …and is flagged for review',
    conflicts.some(c => c.local === 'edited' && c.remote === 'deleted'), JSON.stringify(conflicts));
}

// ── 7. Photos union across devices ──
{
  const base = job();
  const local = job(); local.photos = [{ id: 'p1', name: 'a.jpg' }];
  const remote = job(); remote.photos = [{ id: 'p2', name: 'b.jpg' }];
  const { merged, conflicts } = mergeJobs(base, local, remote);
  check('photos from both devices are kept',
    merged.photos.map(p => p.id).sort().join() === 'p1,p2', JSON.stringify(merged.photos));
  check('  …with no conflict', conflicts.length === 0);
}

// ── 8. CT-level photos merge too ──
{
  const base = job();
  const local = job(); local.cts[0].photos = [{ id: 'p1', name: 'a.jpg' }];
  const remote = job(); remote.cts[0].photos = [{ id: 'p2', name: 'b.jpg' }];
  const { merged } = mergeJobs(base, local, remote);
  check('CT photos merge from both sides',
    ct(merged).photos.map(p => p.id).sort().join() === 'p1,p2', JSON.stringify(ct(merged).photos));
}

// ── 9. First sync with no base (never synced before) ──
{
  const local = job(); local.cts[0].burden = '15';
  const remote = job(); remote.siteAddress = '2 New Road';
  const { merged, conflicts } = mergeJobs(null, local, remote);
  check('no base: differing fields are conflicts, nothing lost silently',
    conflicts.length > 0 && ct(merged).burden === '15', JSON.stringify(conflicts));
}

// ── 10. Job that exists only on one side ──
{
  const local = job();
  check('remote missing returns local untouched', mergeJobs(null, local, null).merged === local);
  check('local missing returns remote untouched', mergeJobs(null, null, local).merged === local);
}

// ── 11. Empty string vs undefined must not register as a change ──
{
  const base = job();
  const local = job(); delete local.clientContact;
  const remote = job(); remote.clientContact = '';
  const { conflicts } = mergeJobs(base, local, remote);
  check('blank vs missing is not a spurious conflict', conflicts.length === 0, JSON.stringify(conflicts));
}

// ── 12. Merging is stable: re-merging its own output changes nothing ──
{
  const base = job();
  const local = job(); local.cts[0].burden = '15';
  const remote = job(); remote.siteAddress = '2 New Road';
  const first = mergeJobs(base, local, remote).merged;
  const second = mergeJobs(base, first, first).merged;
  check('re-merging a merged result is stable',
    JSON.stringify(first) === JSON.stringify(second));
}

// ── 13. Order of sides does not change what survives ──
{
  const base = job();
  const local = job(); local.cts[0].burden = '15';
  const remote = job(); remote.siteAddress = '2 New Road';
  const ab = mergeJobs(base, local, remote).merged;
  const ba = mergeJobs(base, remote, local).merged;
  check('merge is symmetric for disjoint edits',
    ab.siteAddress === ba.siteAddress && ct(ab).burden === ct(ba).burden,
    `${ab.siteAddress}/${ba.siteAddress} ${ct(ab).burden}/${ct(ba).burden}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
