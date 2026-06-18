// queue.js — a tiny in-memory job queue with a concurrency limit.
//
// This keeps the starter zero-infrastructure: no Redis needed to try it. For
// production, replace this file with BullMQ on Redis (same surface: add(), get(),
// and a processor) so jobs survive restarts and scale across worker machines.
// See HOSTING-PLAN.md.

const { randomUUID } = require('crypto');

class JobQueue {
  constructor({ concurrency = 1, processor, ttlMs = 1000 * 60 * 60 } = {}) {
    this.concurrency = concurrency;
    this.processor = processor;        // async (job, onProgress) => result
    this.ttlMs = ttlMs;
    this.jobs = new Map();             // id -> job
    this.waiting = [];                 // ids
    this.active = 0;
    setInterval(() => this._sweep(), 60 * 1000).unref?.();
  }

  add(payload) {
    const id = randomUUID();
    const job = { id, payload, status: 'queued', pct: 0, createdAt: Date.now(),
      result: null, error: null };
    this.jobs.set(id, job);
    this.waiting.push(id);
    this._pump();
    return job;
  }

  get(id) { return this.jobs.get(id) || null; }

  position(id) {
    const i = this.waiting.indexOf(id);
    return i < 0 ? 0 : i + 1;
  }

  _pump() {
    while (this.active < this.concurrency && this.waiting.length) {
      const id = this.waiting.shift();
      const job = this.jobs.get(id);
      if (!job) continue;
      this.active++;
      job.status = 'rendering';
      job.startedAt = Date.now();
      Promise.resolve()
        .then(() => this.processor(job, (p) => { job.pct = p.pct; job.frame = p.frame; job.total = p.total; }))
        .then((result) => { job.status = 'done'; job.pct = 100; job.result = result; job.finishedAt = Date.now(); })
        .catch((err) => { job.status = 'error'; job.error = err.message || String(err); })
        .finally(() => { this.active--; this._pump(); });
    }
  }

  _sweep() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      const done = job.status === 'done' || job.status === 'error';
      if (done && now - (job.finishedAt || job.createdAt) > this.ttlMs) {
        if (job.result && job.result.cleanup) { try { job.result.cleanup(); } catch (_) {} }
        this.jobs.delete(id);
      }
    }
  }
}

module.exports = { JobQueue };
