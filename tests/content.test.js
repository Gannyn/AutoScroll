import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Simulates the browser rule that animation frames stop when a tab becomes hidden.
function page(randomValues = [], quantum = 0) {
  let now = 0, serial = 0, listener;
  const frames = new Map(), timers = new Map(), events = new Map(), styles = new Map();
  const messages = [];
  const math = Object.create(Math);
  math.random = () => randomValues.shift() ?? 0.5;
  const element = {
    isConnected: true, scrollTop: 0, scrollHeight: 3000, clientHeight: 500,
    style: { getPropertyValue: key => styles.get(key)?.[0] ?? '', getPropertyPriority: key => styles.get(key)?.[1] ?? '', setProperty: (key, value, priority) => styles.set(key, [value, priority]), removeProperty: key => styles.delete(key) },
    scrollBy({ top }) { this.scrollTo({ top: this.scrollTop + top }); },
    scrollTo({ top }) { this.scrollTop = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, quantum ? Math.round(top / quantum) * quantum : top)); },
  };
  const document = { hidden: false, scrollingElement: element, addEventListener: (type, callback) => events.set(type, callback) };
  function timer(callback, delay, repeat = false) {
    const id = ++serial;
    timers.set(id, { callback, at: now + delay, delay, repeat });
    return id;
  }
  const context = vm.createContext({
    document, Math: math, performance: { now: () => now },
    chrome: { runtime: { onMessage: { addListener: callback => { listener = callback; } }, sendMessage: async message => { messages.push(message); return { ok: true }; } } },
    requestAnimationFrame: callback => { const id = ++serial; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: (callback, delay) => timer(callback, delay), clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => timer(callback, delay, true), clearInterval: id => timers.delete(id),
  });
  vm.runInContext(readFileSync('extension/content.js', 'utf8'), context);
  return {
    element, messages,
    send(message) { let response; listener(message, {}, value => { response = value; }); return response; },
    hide(value) { document.hidden = value; events.get('visibilitychange')?.(); },
    until(predicate, timeout = 10000) {
      for (let elapsed = 0; elapsed < timeout; elapsed += 10) {
        if (predicate()) return;
        this.advance(10);
      }
      assert.fail('Scrolling condition was not reached');
    },
    advance(duration) {
      for (let elapsed = 0; elapsed < duration; elapsed += 10) {
        now += 10;
        if (!document.hidden) for (const [id, callback] of [...frames]) { frames.delete(id); callback(now); }
        for (const [id, task] of [...timers]) if (task.at <= now) {
          if (task.repeat) task.at += task.delay; else timers.delete(id);
          task.callback();
        }
      }
    },
  };
}

const start = speed => ({ type: 'SCROLL_START', step: 'test', direction: 'down', speed, edgeWait: 300, selector: '', reset: true });

test('scrolling continues when a visible page with a pending frame becomes hidden', () => {
  const browser = page();
  assert.equal(browser.send(start(100)).ok, true);
  browser.advance(100);
  const before = browser.element.scrollTop;
  browser.hide(true);
  browser.advance(500);
  assert.ok(browser.element.scrollTop >= before + 40, 'hidden-tab timers must replace the suspended animation frame');
  const hiddenTop = browser.element.scrollTop;
  browser.hide(false);
  browser.advance(100);
  assert.ok(browser.element.scrollTop > hiddenTop);
});

test('one pixel per second accumulates fractions without stalling, and stop restores styles', () => {
  const browser = page();
  browser.element.style.setProperty('scroll-snap-type', 'y mandatory', '');
  browser.send(start(1));
  browser.advance(2000);
  assert.equal(browser.element.scrollTop, 2);
  browser.send({ type: 'SCROLL_STOP' });
  browser.advance(2000);
  assert.equal(browser.element.scrollTop, 2);
  assert.equal(browser.element.style.getPropertyValue('scroll-snap-type'), 'y mandatory');
});

test('timed mode alternates configured scrolling and resting without a catch-up jump', () => {
  const browser = page();
  browser.send({ ...start(100), pauseMode: 'timed', scrollDuration: 200, pauseDuration: 500 });
  browser.advance(200);
  const first = browser.element.scrollTop;
  assert.ok(first >= 12 && first <= 28);
  browser.advance(400);
  assert.equal(browser.element.scrollTop, first);
  assert.equal(browser.messages.at(-1).resting, true);
  browser.until(() => browser.element.scrollTop > first);
  const stopped = browser.element.scrollTop;
  browser.send({ type: 'SCROLL_STOP' });
  browser.advance(1000);
  assert.equal(browser.element.scrollTop, stopped);
});

test('random mode samples each burst independently and honors 1 px/1 s and 600 px/20 s endpoints', () => {
  const browser = page([0, 0, 0, 0.999999, 0.999999, 0, 0, 0]);
  browser.send({ ...start(5000), pauseMode: 'random', reverseMin: 1, reverseMax: 1 });
  browser.advance(10);
  assert.equal(browser.element.scrollTop, 1, 'high speed must not overshoot a 1 px burst');
  browser.advance(990);
  assert.equal(browser.element.scrollTop, 1);
  browser.until(() => browser.messages.at(-1).resting && browser.element.scrollTop === 601);
  assert.equal(browser.element.scrollTop, 601);
  assert.equal(browser.messages.at(-1).pauseRemaining, 20000);
  browser.advance(19990);
  assert.equal(browser.element.scrollTop, 601);
  browser.until(() => browser.messages.at(-1).resting && browser.element.scrollTop > 601);
  assert.equal(browser.element.scrollTop, 602);
});

test('random pauses use custom minimum and maximum durations, resampled after each burst', () => {
  const browser = page([0, 0, 0, 0, 0.999999]);
  browser.send({ ...start(5000), pauseMode: 'random', randomPauseMin: 5, randomPauseMax: 30, reverseMin: 1, reverseMax: 1 });
  browser.advance(10);
  assert.equal(browser.messages.at(-1).pauseRemaining, 5000);
  browser.advance(4990);
  assert.equal(browser.element.scrollTop, 1);
  browser.until(() => browser.messages.at(-1).resting && browser.element.scrollTop === 2);
  assert.equal(browser.messages.at(-1).pauseRemaining, 30000);
  browser.advance(29000);
  assert.equal(browser.element.scrollTop, 2);
});

test('equal random pause bounds produce a fixed duration for any random sample', () => {
  for (const value of [0, 0.5, 0.999999]) {
    const browser = page([0, value]);
    browser.send({ ...start(5000), pauseMode: 'random', randomPauseMin: 3, randomPauseMax: 3 });
    browser.advance(10);
    assert.equal(browser.messages.at(-1).pauseRemaining, 3000);
  }
});

test('random pauses work upward and preserve the remaining rest across manual pause', () => {
  const browser = page([0, 0.05]); // 1 px, 2 seconds.
  const config = { ...start(5000), direction: 'up', pauseMode: 'random' };
  browser.send(config);
  browser.advance(10);
  assert.equal(browser.element.scrollTop, 2499);
  browser.advance(500);
  const paused = browser.send({ type: 'SCROLL_PAUSE' });
  assert.equal(paused.cadence.restRemaining, 1500);
  browser.advance(5000);
  assert.equal(browser.element.scrollTop, 2499);
  browser.send({ ...config, step: 'resume', reset: false, cadence: paused.cadence });
  browser.advance(1490);
  assert.equal(browser.element.scrollTop, 2499);
  browser.until(() => browser.element.scrollTop < 2499);
  assert.ok(browser.element.scrollTop < 2499);
});

test('stable page edges complete without waiting for an extra in-page rest', () => {
  const browser = page([0.999999, 0.999999]);
  browser.element.scrollHeight = 550;
  browser.send({ ...start(5000), pauseMode: 'random' });
  browser.advance(320);
  assert.equal(browser.element.scrollTop, 50);
  assert.equal(browser.messages.at(-1).type, 'SCROLL_EDGE');
  assert.equal(browser.send({ type: 'SCROLL_STATUS' }).active, false);
});

test('changing speed during a rest preserves the rest, then uses the new speed', () => {
  const browser = page();
  browser.send({ ...start(100), pauseMode: 'timed', scrollDuration: 200, pauseDuration: 500 });
  browser.advance(300);
  const first = browser.element.scrollTop;
  browser.send({ type: 'SCROLL_SPEED', speed: 200 });
  browser.advance(400);
  assert.equal(browser.element.scrollTop, first);
  browser.until(() => browser.element.scrollTop > first);
  browser.until(() => browser.messages.at(-1).resting);
  assert.ok(browser.element.scrollTop - first >= 24);
});

test('short timed bursts retain fractional pixels at the lowest speed', () => {
  const browser = page();
  browser.send({ ...start(1), pauseMode: 'timed', scrollDuration: 100, pauseDuration: 100, reverseMin: 1, reverseMax: 1 });
  browser.until(() => browser.element.scrollTop >= 3, 120000);
});

test('equal time windows have different distances because scrolling accelerates and decelerates', () => {
  const browser = page();
  browser.send(start(200));
  const distances = [];
  for (let i = 0; i < 10; i++) {
    const top = browser.element.scrollTop;
    browser.advance(200);
    distances.push(browser.element.scrollTop - top);
  }
  assert.ok(Math.max(...distances) - Math.min(...distances) > 15, JSON.stringify(distances));
  assert.ok(distances.every(distance => distance >= 23 && distance <= 57));
});

test('every timed rest reverses a random distance then recovers and continues in both directions', () => {
  for (const direction of ['down', 'up']) {
    const browser = page([0, 0.999999]);
    browser.send({ ...start(1000), direction, pauseMode: 'timed', scrollDuration: 200, pauseDuration: 100, reverseMin: 20, reverseMax: 40 });
    const sign = direction === 'down' ? 1 : -1;
    for (const distance of [20, 40]) {
      browser.until(() => browser.messages.at(-1).resting);
      const anchor = browser.element.scrollTop;
      browser.until(() => browser.element.scrollTop === anchor - sign * distance);
      assert.equal(browser.messages.some(message => message.type === 'SCROLL_EDGE'), false);
      browser.until(() => (browser.element.scrollTop - anchor) * sign > 0);
    }
  }
});

test('manual pause preserves a partially completed reverse movement', () => {
  const browser = page();
  const config = { ...start(100), pauseMode: 'timed', scrollDuration: 200, pauseDuration: 100, reverseMin: 20, reverseMax: 20 };
  browser.send(config);
  browser.until(() => browser.messages.at(-1).resting);
  const anchor = browser.element.scrollTop;
  browser.until(() => browser.element.scrollTop < anchor);
  const top = browser.element.scrollTop;
  const paused = browser.send({ type: 'SCROLL_PAUSE' });
  assert.ok(paused.cadence.backtrackRemaining > 0 && paused.cadence.backtrackRemaining < 20);
  browser.advance(1000);
  assert.equal(browser.element.scrollTop, top);
  browser.send({ ...config, step: 'resume', reset: false, cadence: paused.cadence });
  browser.until(() => browser.element.scrollTop === anchor - 20);
  browser.until(() => browser.element.scrollTop > anchor);
});

test('quantized scrolling finishes fractional reverse remainders and recovers the actual anchor', () => {
  for (const direction of ['down', 'up']) {
    const browser = page([], 0.8);
    browser.send({ ...start(1000), direction, pauseMode: 'timed', scrollDuration: 100, pauseDuration: 100, reverseMin: 1, reverseMax: 1 });
    browser.until(() => browser.messages.at(-1).resting);
    const anchor = browser.element.scrollTop;
    browser.until(() => (browser.element.scrollTop - anchor) * (direction === 'down' ? 1 : -1) > 1);
  }
});

test('one-pixel random bursts continue on a zoomed page with fractional scroll positions', () => {
  const browser = page(Array(30).fill(0), 0.8);
  browser.send({ ...start(1000), pauseMode: 'random', reverseMin: 1, reverseMax: 1 });
  browser.until(() => browser.messages.at(-1).resting);
  browser.until(() => browser.element.scrollTop > 1.5);
});
