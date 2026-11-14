// Minimal tween runner driven by the render loop.
const active = new Set();

export const ease = {
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  out: (t) => 1 - Math.pow(1 - t, 3),
  linear: (t) => t,
};

/** animate({ dur, ease, update(k), done() }) -> handle with cancel(). */
export function animate({ dur = 1, ease: fn = ease.inOut, update, done }) {
  const tw = { t: 0, dur, fn, update, done, cancel: () => active.delete(tw) };
  active.add(tw);
  update(0);
  return tw;
}

/** Advance all tweens; returns true while any is running. */
export function tickTweens(dt) {
  for (const tw of [...active]) {
    tw.t = Math.min(1, tw.t + dt / tw.dur);
    tw.update(tw.fn(tw.t));
    if (tw.t >= 1) {
      active.delete(tw);
      tw.done?.();
    }
  }
  return active.size > 0;
}

export const lerp = (a, b, t) => a + (b - a) * t;
