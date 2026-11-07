/** Time source + timers. Real time in the browser; virtual time in tests. */
export interface Scheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(h: number): void;
}

export class RealScheduler implements Scheduler {
  private speed: number;
  private t0 = Date.now();
  /** speed > 1 runs the simulation faster than wall time. */
  constructor(speed = 1) {
    this.speed = speed;
  }
  now() {
    return (Date.now() - this.t0) * this.speed;
  }
  setTimeout(fn: () => void, ms: number) {
    return setTimeout(fn, Math.max(0, ms / this.speed)) as unknown as number;
  }
  clearTimeout(h: number) {
    clearTimeout(h);
  }
}

/** Deterministic virtual clock. Nothing runs until you call advance()/runUntilIdle(). */
export class FakeScheduler implements Scheduler {
  private t = 0;
  private seq = 0;
  private q: { at: number; seq: number; fn: () => void; h: number }[] = [];
  private cancelled = new Set<number>();
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const h = ++this.seq;
    this.q.push({ at: this.t + Math.max(0, ms), seq: h, fn, h });
    return h;
  }
  clearTimeout(h: number) {
    this.cancelled.add(h);
  }
  private next() {
    let best = -1;
    for (let i = 0; i < this.q.length; i++) {
      const e = this.q[i];
      if (best < 0 || e.at < this.q[best].at || (e.at === this.q[best].at && e.seq < this.q[best].seq)) best = i;
    }
    return best;
  }
  /** Run timers due up to now + ms. Promise jobs run between timers. */
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      await flushMicrotasks();
      const i = this.next();
      if (i < 0 || this.q[i].at > end) break;
      const [e] = this.q.splice(i, 1);
      this.t = e.at;
      if (this.cancelled.delete(e.h)) continue;
      e.fn();
    }
    this.t = end;
    await flushMicrotasks();
  }
  /** Run until a promise settles (or virtual time limit). */
  async runUntil<T>(p: Promise<T>, limitMs = 10 * 60_000): Promise<T> {
    let done = false;
    let value: T | undefined;
    let error: unknown;
    let failed = false;
    p.then(
      (v) => ((done = true), (value = v)),
      (e) => ((done = true), (failed = true), (error = e)),
    );
    const end = this.t + limitMs;
    while (!done && this.t < end) {
      await flushMicrotasks();
      if (done) break;
      const i = this.next();
      if (i < 0) break;
      const [e] = this.q.splice(i, 1);
      if (e.at > end) {
        this.q.push(e);
        break;
      }
      this.t = e.at;
      if (this.cancelled.delete(e.h)) continue;
      e.fn();
    }
    await flushMicrotasks();
    if (!done) throw new Error(`runUntil: promise still pending at t=${this.t}ms`);
    if (failed) throw error;
    return value as T;
  }
}

async function flushMicrotasks() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Small seeded PRNG (mulberry32) so simulations are reproducible. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
