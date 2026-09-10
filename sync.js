// ═══════════════════════════════════════════════════════════════════
// THREE-WAY MERGE FOR JOB RECORDS
// ═══════════════════════════════════════════════════════════════════
// Two engineers can edit the same job while offline. Picking a winner by
// timestamp would silently discard the loser's readings, so instead every
// change is merged against the version last seen by both sides (the base):
// a field only one side touched merges cleanly; a field both sides changed
// to different values is reported as a conflict for a human to settle.
//
// Pure functions with no browser or Firebase dependency, so the rules can
// be tested directly.

(function (root) {
  'use strict';

  const eq = (a, b) => {
    if (a === b) return true;
    if (a == null || b == null) return (a ?? '') === (b ?? '');
    if (typeof a !== 'object') return String(a) === String(b);
    return JSON.stringify(a) === JSON.stringify(b);
  };

  // Fields that describe sync state rather than survey data — never merged or
  // reported as conflicts, since each device maintains its own.
  const META_KEYS = new Set(['cts', 'photos', 'syncedAt', 'baseRev']);

  function mergeFields(base, local, remote, path, conflicts) {
    const out = {};
    const keys = new Set([
      ...Object.keys(base || {}),
      ...Object.keys(local || {}),
      ...Object.keys(remote || {}),
    ]);
    for (const k of keys) {
      if (META_KEYS.has(k)) continue;
      const b = base ? base[k] : undefined;
      const l = local ? local[k] : undefined;
      const r = remote ? remote[k] : undefined;
      if (eq(l, r)) out[k] = l !== undefined ? l : r;
      else if (eq(l, b)) out[k] = r;            // only remote changed
      else if (eq(r, b)) out[k] = l;            // only local changed
      else {
        out[k] = l;                             // keep local, flag for review
        conflicts.push({ path: path.concat(k).join('.'), local: l, remote: r });
      }
    }
    return out;
  }

  const byId = list => new Map((list || []).map(x => [x.id, x]));

  // Merge a list of {id, …} records, resolving adds and deletes on both sides.
  function mergeList(baseList, localList, remoteList, path, conflicts, mergeItem) {
    const B = byId(baseList), L = byId(localList), R = byId(remoteList);
    const order = [];
    for (const x of localList || []) order.push(x.id);
    for (const x of remoteList || []) if (!L.has(x.id)) order.push(x.id);

    const out = [];
    for (const id of order) {
      const b = B.get(id), l = L.get(id), r = R.get(id);

      if (l && r) { out.push(mergeItem(b, l, r, path.concat(id), conflicts)); continue; }

      if (l && !r) {
        // Absent remotely: either deleted there, or added here since the base.
        if (!b) { out.push(l); continue; }             // added locally
        if (eq(l, b)) continue;                        // deleted remotely, untouched here
        out.push(l);                                   // deleted remotely but edited here
        conflicts.push({ path: path.concat(id).join('.'), local: 'edited', remote: 'deleted' });
        continue;
      }

      if (!l && r) {
        if (!b) { out.push(r); continue; }             // added remotely
        if (eq(r, b)) continue;                        // deleted here, untouched remotely
        out.push(r);                                   // deleted here but edited remotely
        conflicts.push({ path: path.concat(id).join('.'), local: 'deleted', remote: 'edited' });
      }
    }
    return out;
  }

  // Photos are immutable once captured, so presence is all that needs merging.
  function mergePhotoList(baseList, localList, remoteList, path, conflicts) {
    return mergeList(baseList, localList, remoteList, path, conflicts,
      (b, l, r, p, c) => mergeFields(b, l, r, p, c));
  }

  function mergeCT(base, local, remote, path, conflicts) {
    const ct = mergeFields(base, local, remote, path, conflicts);
    ct.id = local.id;
    ct.photos = mergePhotoList(
      base && base.photos, local.photos, remote.photos,
      path.concat('photos'), conflicts);
    return ct;
  }

  // base   — the job as it stood when this device last synced (null if never)
  // local  — the job on this device now
  // remote — the job in Firestore now
  function mergeJobs(base, local, remote) {
    if (!remote) return { merged: local, conflicts: [] };
    if (!local) return { merged: remote, conflicts: [] };

    const conflicts = [];
    const merged = mergeFields(base, local, remote, [], conflicts);
    merged.id = local.id;
    merged.cts = mergeList(
      base && base.cts, local.cts, remote.cts, ['cts'], conflicts, mergeCT);
    merged.photos = mergePhotoList(
      base && base.photos, local.photos, remote.photos, ['photos'], conflicts);
    return { merged, conflicts };
  }

  const api = { mergeJobs, mergeFields, mergeList, eq };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Sync = api;
})(typeof self !== 'undefined' ? self : this);
