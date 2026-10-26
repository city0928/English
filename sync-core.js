(function (root) {
  'use strict';
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const stable = value => JSON.stringify(value, function (_, item) {
    if (item && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
    return item;
  });
  const accountStorageKey = id => id ? 'departureEnglish.sg.v2.account.' + encodeURIComponent(id) : 'departureEnglish.sg.v2';
  class SyncController {
    constructor(options) {
      this.api = options.api;
      this.state = clone(options.state);
      this.revision = options.revision || 0;
      this.dirty = !!options.dirty;
      this.sequence = 0;
      this.conflict = null;
      this.closed = false;
      this.upload = null;
      this.reading = null;
      this.lastSyncAt = options.lastSyncAt || null;
      this.onApply = options.onApply || (() => {});
      this.onStatus = options.onStatus || (() => {});
      this.onMeta = options.onMeta || (() => {});
      this.onConflict = options.onConflict || (() => {});
      this.canApply = options.canApply || (() => true);
      this.lastMetadata = stable({ revision: this.revision, dirty: this.dirty, lastSyncAt: this.lastSyncAt });
    }
    notify(status) {
      if (this.closed) return;
      const metadata = { revision: this.revision, dirty: this.dirty, lastSyncAt: this.lastSyncAt }, serialized = stable(metadata);
      if (serialized !== this.lastMetadata) {
        try { if (this.onMeta(metadata) !== false) this.lastMetadata = serialized; } catch { /* Pending state remains in memory and is retried on the next notification. */ }
      }
      this.onStatus(status);
    }
    changed(value) {
      if (this.closed) return;
      this.state = clone(value); this.sequence++; this.dirty = true;
      this.notify(this.conflict ? 'conflict' : 'pending');
    }
    receiveConflict(remote) {
      if (this.closed) return;
      this.conflict = clone(remote);
      this.notify('conflict');
      this.onConflict(this.conflict);
    }
    failure(error) {
      if (error?.status === 409 && error.data) this.receiveConflict(error.data);
      else this.notify(error?.status === 401 ? 'auth' : error?.status === 413 ? 'too-large' : 'offline');
    }
    async pull() {
      if (this.closed || this.conflict) return;
      if (this.reading) return this.reading;
      if (this.upload) { await this.upload; if (this.closed || this.conflict || this.dirty) return; }
      this.reading = (async () => {
        this.notify(this.dirty ? 'pending' : 'loading');
        try {
          const remote = await this.api.get();
          if (this.closed) return;
          if (remote.revision < this.revision) { this.notify(this.dirty ? 'pending' : 'saved'); return; }
          // Re-read dirty after awaiting: the learner may have typed while this request was in flight.
          if (this.dirty) {
            if (stable(remote.state) === stable(this.state)) {
              this.revision = remote.revision; this.dirty = false; this.lastSyncAt = Date.now(); this.notify('saved');
            } else if (remote.revision === this.revision) await this.flush();
            else this.receiveConflict(remote);
          } else {
            const different = remote.state !== null && stable(remote.state) !== stable(this.state);
            if (different && !this.canApply()) { this.notify('deferred'); return; }
            const advanced = remote.revision !== this.revision;
            this.revision = remote.revision;
            if (different) { this.state = clone(remote.state); this.onApply(clone(remote.state)); }
            if (advanced || different || !this.lastSyncAt) this.lastSyncAt = Date.now();
            this.notify('saved');
          }
        } catch (error) { if (!this.closed) this.failure(error); }
      })();
      try { await this.reading; } finally { this.reading = null; }
    }
    async flush() {
      if (this.closed || this.conflict || !this.dirty) return;
      if (this.upload) return this.upload;
      this.upload = (async () => {
        while (this.dirty && !this.closed && !this.conflict) {
          const sequence = this.sequence, snapshot = clone(this.state);
          this.notify('saving');
          try {
            const result = await this.api.put(this.revision, snapshot);
            if (this.closed) return;
            this.revision = result.revision;
            this.dirty = this.sequence !== sequence;
            this.lastSyncAt = Date.now(); this.notify(this.dirty ? 'pending' : 'saved');
          } catch (error) {
            if (!this.closed && error?.status === 409 && stable(error.data?.state) === stable(this.state)) {
              this.revision = error.data.revision; this.dirty = false; this.lastSyncAt = Date.now(); this.notify('saved');
            } else if (!this.closed) this.failure(error);
            return;
          }
        }
      })();
      try { await this.upload; } finally { this.upload = null; }
    }
    async useCloud() {
      if (this.closed || !this.conflict) return;
      const remote = this.conflict; this.conflict = null;
      this.revision = remote.revision; this.state = clone(remote.state); this.dirty = false; this.sequence++;
      this.lastSyncAt = Date.now(); this.onApply(clone(remote.state)); this.notify('saved');
    }
    async useLocal() {
      if (this.closed || !this.conflict) return;
      this.revision = this.conflict.revision; this.conflict = null; this.dirty = true;
      await this.flush();
    }
    stop() { this.closed = true; }
  }
  root.EnglishSyncCore = { SyncController, accountStorageKey };
})(globalThis);
