// ═══════════════════════════════════════════════════════════════════
// FIREBASE SYNC
// ═══════════════════════════════════════════════════════════════════
// The device stays the source of truth: everything is written locally first
// and works with no signal, exactly as before. Sync pushes local work up and
// pulls colleagues' work down, reconciling the two with a three-way merge
// against the version this device last saw (see sync.js).
//
// Photo bytes go to Firebase Storage; job records go to Firestore. Neither is
// required for the app to function offline.

const Cloud = {
  _ready: false,
  _user: null,
  _syncing: false,
  status: 'off',        // off | ready | syncing | synced | error
  lastSync: null,
  lastError: null,
  conflicts: [],        // surfaced to the user after a sync that could not auto-resolve

  // ── Config ──
  config() {
    const raw = DB.getSettings().firebaseConfig;
    if (!raw) return null;
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  },
  isConfigured() { const c = this.config(); return !!(c && c.projectId && c.apiKey); },
  isSignedIn() { return !!this._user; },
  userEmail() { return this._user ? this._user.email : null; },

  async init() {
    if (this._ready || !this.isConfigured()) return;
    if (typeof firebase === 'undefined') return;   // SDK not loaded (e.g. first offline start)
    try {
      const cfg = this.config();
      if (!firebase.apps.length) firebase.initializeApp(cfg);
      this._db = firebase.firestore();
      this._storage = firebase.storage();
      this._auth = firebase.auth();

      // Local emulator, when the config asks for it — used by the test suite.
      if (cfg.useEmulator) {
        this._db.useEmulator('127.0.0.1', 8080);
        this._storage.useEmulator('127.0.0.1', 9199);
        this._auth.useEmulator('http://127.0.0.1:9099', { disableWarnings: true });
      }

      this._auth.onAuthStateChanged(u => {
        this._user = u;
        this.status = u ? 'ready' : 'off';
        if (typeof render === 'function') render();
      });
      this._ready = true;
    } catch (err) {
      console.error(err);
      this.lastError = err.message;
    }
  },

  async signIn() {
    await this.init();
    if (!this._ready) { showToast('Add your Firebase config in Settings first'); return; }
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      await this._auth.signInWithPopup(provider);
      showToast('Signed in ✓');
      this.syncAll();
    } catch (err) {
      console.error(err);
      showToast('Sign-in failed: ' + (err.code || err.message));
    }
  },

  async signOut() {
    if (!this._ready) return;
    await this._auth.signOut();
    showToast('Signed out');
  },

  // ── Base snapshots: the version of each job this device last agreed with ──
  _bases() { return DB.get('ctm_bases', {}); },
  _setBase(id, job) { const b = this._bases(); b[id] = job; DB.set('ctm_bases', b); },
  _dropBase(id) { const b = this._bases(); delete b[id]; DB.set('ctm_bases', b); },

  // ── Tombstones, so a delete here is not undone by a colleague's copy ──
  tombstones() { return DB.get('ctm_deleted', {}); },
  markDeleted(id) {
    const t = this.tombstones();
    t[id] = new Date().toISOString();
    DB.set('ctm_deleted', t);
  },
  _clearTombstone(id) { const t = this.tombstones(); delete t[id]; DB.set('ctm_deleted', t); },

  // ── Photos ──
  _photoRef(id) { return this._storage.ref('photos/' + id); },

  async _pushPhotos(job) {
    for (const p of Photos.allIn(job)) {
      if (p.storagePath) continue;
      const blob = await Photos.getBlob(p.id);
      if (!blob) continue;
      await this._photoRef(p.id).put(blob, { contentType: blob.type || 'image/jpeg' });
      p.storagePath = 'photos/' + p.id;
    }
  },

  // Pull down any photo this device does not hold bytes for.
  async fetchMissingPhotos(job) {
    let got = 0;
    for (const p of Photos.allIn(job)) {
      if (!p.storagePath) continue;
      if (await Photos.getBlob(p.id)) continue;
      try {
        const url = await this._storage.ref(p.storagePath).getDownloadURL();
        const res = await fetch(url);
        if (!res.ok) continue;
        const blob = await res.blob();
        await Photos.put(p.id, blob);
        got++;
      } catch (err) { console.error(err); }
    }
    return got;
  },

  // ── Sync ──
  async syncAll() {
    if (!this._ready || !this._user || this._syncing) return;
    if (!navigator.onLine) { showToast('Offline — will sync when back in signal'); return; }

    this._syncing = true;
    this.status = 'syncing';
    this.conflicts = [];
    if (typeof render === 'function') render();

    try {
      const col = this._db.collection('jobs');
      const local = DB.getJobs();
      const localById = new Map(local.map(j => [j.id, j]));
      const bases = this._bases();
      const tombs = this.tombstones();

      const snap = await col.get();
      const remoteById = new Map();
      snap.forEach(d => remoteById.set(d.id, d.data()));

      const out = [];
      const ids = new Set([...localById.keys(), ...remoteById.keys()]);

      for (const id of ids) {
        const localJob = localById.get(id) || null;
        const remoteDoc = remoteById.get(id) || null;

        // Deleted here → push the deletion, keep it out of the local list
        if (tombs[id]) {
          if (remoteDoc && !remoteDoc.deleted) {
            await col.doc(id).set({ deleted: true, deletedAt: tombs[id] }, { merge: true });
          }
          this._dropBase(id);
          continue;
        }

        // Deleted elsewhere → drop it here too
        if (remoteDoc && remoteDoc.deleted) {
          this._dropBase(id);
          if (localJob) await Photos.removeForJob(localJob);
          continue;
        }

        // A document without a job payload is not ours to interpret; leaving it
        // alone beats letting one malformed record break sync for everybody.
        const remoteJob = remoteDoc && remoteDoc.job ? remoteDoc.job : null;
        if (!localJob && !remoteJob) continue;

        const { merged, conflicts } = Sync.mergeJobs(bases[id] || null, localJob, remoteJob);
        if (!merged) continue;
        if (conflicts.length) {
          this.conflicts.push({ jobId: id, jobNumber: merged.jobNumber || id, items: conflicts });
        }

        await this._pushPhotos(merged);

        const changedRemotely = JSON.stringify(remoteJob) !== JSON.stringify(merged);
        if (changedRemotely) {
          await col.doc(id).set({
            job: merged,
            deleted: false,
            updatedAt: new Date().toISOString(),
            updatedBy: this._user.email || 'unknown',
          });
        }

        this._setBase(id, JSON.parse(JSON.stringify(merged)));
        out.push(merged);
      }

      // Tombstones are pushed; forget them so they do not replay forever
      for (const id of Object.keys(tombs)) this._clearTombstone(id);

      out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      DB.saveJobs(out);

      this.status = 'synced';
      this.lastSync = new Date();
      this.lastError = null;

      const n = this.conflicts.reduce((s, c) => s + c.items.length, 0);
      showToast(n ? `Synced — ${n} conflict${n > 1 ? 's' : ''} need review` : `Synced ${out.length} jobs ✓`);
    } catch (err) {
      console.error(err);
      this.status = 'error';
      this.lastError = err.message;
      showToast('Sync failed: ' + err.message);
    } finally {
      this._syncing = false;
      if (typeof render === 'function') render();
    }
  },
};
