import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, createRun, advance } from '../extension/model.js';

const urls = ['https://a.example/', 'https://b.example/', 'https://c.example/'];

test('normalizes multiline URLs, preserves order and duplicates', () => {
  const config = normalizeConfig({ urls: ' https://a.example \n\nhttp://localhost:8000/path\nhttps://a.example' });
  assert.deepEqual(config.urls, ['https://a.example/', 'http://localhost:8000/path', 'https://a.example/']);
  assert.equal(config.speed, 160);
  assert.equal(config.cycles, 1);
  assert.equal(config.pauseMode, 'continuous');
  assert.equal(config.scrollDuration, 5000);
  assert.equal(config.pauseDuration, 2000);
  assert.equal(config.randomPauseMin, 1);
  assert.equal(config.randomPauseMax, 20);
});

test('validates configurable random pause bounds in integer seconds', () => {
  const config = normalizeConfig({ urls, pauseMode: 'random', randomPauseMin: '5', randomPauseMax: '30' });
  assert.equal(config.randomPauseMin, 5);
  assert.equal(config.randomPauseMax, 30);
  assert.equal(normalizeConfig({ urls, randomPauseMin: 3, randomPauseMax: 3 }).randomPauseMax, 3);
  for (const patch of [
    { randomPauseMin: '' }, { randomPauseMax: '' }, { randomPauseMin: 0 }, { randomPauseMin: -1 },
    { randomPauseMin: 1.5 }, { randomPauseMax: 3601 }, { randomPauseMax: Infinity },
    { randomPauseMax: 'invalid' }, { randomPauseMin: 30, randomPauseMax: 5 },
  ]) assert.throws(() => normalizeConfig({ urls, pauseMode: 'random', ...patch }));
});

test('validates timed pause mode and duration ranges', () => {
  const config = normalizeConfig({ urls, pauseMode: 'timed', scrollDuration: '200', pauseDuration: '500' });
  assert.equal(config.pauseMode, 'timed');
  assert.equal(config.scrollDuration, 200);
  assert.equal(config.pauseDuration, 500);
  for (const patch of [{ pauseMode: 'unknown' }, { scrollDuration: 0 }, { scrollDuration: '' }, { pauseDuration: -1 }, { pauseDuration: NaN }, { pauseDuration: 3600001 }]) {
    assert.throws(() => normalizeConfig({ urls, pauseMode: 'timed', ...patch }));
  }
  assert.equal(normalizeConfig({ urls, pauseMode: 'random' }).pauseMode, 'random');
});

test('validates a configurable integer reverse distance range', () => {
  assert.equal(normalizeConfig({ urls }).reverseMin, 1);
  assert.equal(normalizeConfig({ urls }).reverseMax, 100);
  for (const patch of [{ reverseMin: 0 }, { reverseMax: 601 }, { reverseMin: 2.5 }, { reverseMin: 80, reverseMax: 40 }]) {
    assert.throws(() => normalizeConfig({ urls, ...patch }));
  }
  assert.equal(normalizeConfig({ urls, reverseMin: '20', reverseMax: '20' }).reverseMax, 20);
});

test('rejects empty, invalid, privileged and credential-bearing URLs', () => {
  for (const url of ['', 'not a url', 'chrome://settings', 'file:///tmp/test', 'javascript:alert(1)', 'https://user:pass@example.com']) {
    assert.throws(() => normalizeConfig({ urls: url }));
  }
});

test('validates numeric limits without coercing empty fields to zero', () => {
  for (const patch of [{ speed: 0 }, { speed: 5001 }, { speed: 'abc' }, { speed: '' }, { cycles: -1 }, { cycles: 1.5 }, { cycles: '' }, { edgeWait: 299 }, { edgeWait: Infinity }]) {
    assert.throws(() => normalizeConfig({ urls, ...patch }));
  }
  assert.equal(normalizeConfig({ urls, speed: '1', cycles: '0', edgeWait: '300' }).cycles, 0);
});

test('three pages scroll down in order then up in reverse, ending at A top', () => {
  let run = createRun(normalizeConfig({ urls }));
  const visited = [];
  while (run.status === 'running') {
    visited.push(`${run.index}:${run.direction}`);
    run = advance(run);
  }
  assert.deepEqual(visited, ['0:down', '1:down', '2:down', '2:up', '1:up', '0:up']);
  assert.equal(run.status, 'completed');
  assert.equal(run.completedCycles, 1);
});

test('finite cycles reuse the same cursor pattern and count complete round trips', () => {
  let run = createRun(normalizeConfig({ urls, cycles: 2 }));
  for (let i = 0; i < 6; i++) run = advance(run);
  assert.equal(run.status, 'running');
  assert.equal(run.completedCycles, 1);
  assert.equal(run.index, 0);
  assert.equal(run.direction, 'down');
  for (let i = 0; i < 6; i++) run = advance(run);
  assert.equal(run.status, 'completed');
  assert.equal(run.completedCycles, 2);
});

test('one-page runs reverse on the same page and unlimited runs do not complete', () => {
  let run = createRun(normalizeConfig({ urls: [urls[0]], cycles: 0 }));
  run = advance(run);
  assert.equal(run.direction, 'up');
  assert.equal(run.completedCycles, 0);
  for (let i = 0; i < 99; i++) run = advance(run);
  assert.equal(run.index, 0);
  assert.equal(run.completedCycles, 50);
  assert.equal(run.status, 'running');
});

test('paused and stopped states cannot accidentally advance', () => {
  for (const status of ['paused', 'stopped', 'completed', 'error']) {
    const run = { ...createRun(normalizeConfig({ urls })), status };
    assert.deepEqual(advance(run), run);
  }
});
