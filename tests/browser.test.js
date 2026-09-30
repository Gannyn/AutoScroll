import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

let server, context, panel, origin, profile, extensionId;
const extensionPath = path.resolve('extension');

function fixture(url) {
  const nested = url.includes('nested');
  const short = url.includes('short');
  const dynamic = url.includes('dynamic');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Scroll fixture ${url}</title>
  <style>html{scroll-behavior:smooth}body{margin:0;font:20px sans-serif;background:#f0f4f8}.content{height:${short ? 100 : 2000}px;background:linear-gradient(#cbd5e1,#bef264)}.scroller{height:500px;overflow:auto;${url.includes('zoom') ? 'zoom:1.25;' : ''}}h1{margin:0;padding:20px}</style></head>
  <body>${nested ? '<main class="scroller">' : ''}<div class="content"><h1>${url}</h1></div>${nested ? '</main>' : ''}
  ${dynamic ? `<script>window.grown=false;addEventListener('scroll',()=>{if(!window.grown && scrollY+innerHeight>=document.documentElement.scrollHeight-3){window.grown=true;setTimeout(()=>document.querySelector('.content').style.height='3000px',150)}})</script>` : ''}</body></html>`;
}

async function command(type, data = {}) {
  return panel.evaluate(message => chrome.runtime.sendMessage(message), { type, ...data });
}
async function state() { return (await command('GET_STATE')).state; }
async function until(predicate, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const run = await state();
    if (predicate(run)) return run;
    if (run?.status === 'error') throw new Error(run.error);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${JSON.stringify(await state())}`);
}
async function start(paths, extra = {}) {
  const response = await command('START', { config: { urls: paths.map(p => `${origin}/${p}`), speed: 5000, edgeWait: 300, cycles: 1, ...extra } });
  assert.equal(response.ok, true, response.error);
}
async function position(tabId, selector = '') {
  return panel.evaluate(async ({ tabId, selector }) => {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: (selector) => {
      const el = selector ? document.querySelector(selector) : document.scrollingElement;
      return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
    }, args: [selector] });
    return result.result;
  }, { tabId, selector });
}

before(async () => {
  server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fixture(req.url)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  profile = await mkdtemp(path.join(tmpdir(), 'autoscroll-test-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 1100, height: 720 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 10000 });
  extensionId = new URL(worker.url()).host;
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/popup.html`);
});

beforeEach(async () => {
  await command('STOP');
  await panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) if (tab.url?.startsWith('http://127.0.0.1:')) await chrome.tabs.remove(tab.id);
    window.edges = [];
    window.motionSamples = [];
    if (!window.observing) {
      window.observing = true;
      chrome.storage.onChanged.addListener(changes => {
        const run = changes.run?.newValue;
        if (run?.phase === 'scrolling') window.motionSamples.push({ step: run.step, top: run.top, direction: run.direction, resting: run.resting, backtracking: run.backtracking, recovering: run.recovering });
        if (run?.phase === 'edge' && !window.edges.some(edge => edge.step === run.step)) {
          window.edges.push({ index: run.index, direction: run.direction, step: run.step, top: run.top, max: run.max });
        }
      });
    }
  });
});

after(async () => {
  await context?.close();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  if (profile) await rm(profile, { recursive: true, force: true });
});

test('real extension completes two three-page round trips and reuses tabs', async () => {
  await start(['a', 'b', 'c'], { cycles: 2 });
  const run = await until(s => s.status === 'completed', 25000);
  assert.equal(run.completedCycles, 2);
  assert.equal(new Set(run.tabs).size, 3);
  const edges = await panel.evaluate(() => window.edges);
  assert.deepEqual(edges.map(e => `${e.index}:${e.direction}`), Array(2).fill(['0:down', '1:down', '2:down', '2:up', '1:up', '0:up']).flat());
  for (const edge of edges) assert.ok(Math.abs(edge.top - (edge.direction === 'down' ? edge.max : 0)) <= 2, JSON.stringify(edge));
  for (const tabId of run.tabs) assert.equal((await position(tabId)).top, 0);
});

test('pause preserves position, changing speed applies immediately, stop cancels', async () => {
  await start(['slow'], { speed: 180, cycles: 0 });
  let run = await until(s => s.top > 50);
  await command('PAUSE');
  const first = (await position(run.tabs[0])).top;
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal((await position(run.tabs[0])).top, first);
  assert.equal((await command('SET_SPEED', { speed: 1000 })).ok, true);
  await command('RESUME');
  run = await until(s => s.top > first + 200);
  assert.equal(run.config.speed, 1000);
  await command('STOP');
  const stopped = (await position(run.tabs[0])).top;
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal((await position(run.tabs[0])).top, stopped);
  assert.equal((await state()).status, 'stopped');
});

test('one-page infinite mode keeps reversing until stopped', async () => {
  await start(['short'], { cycles: 0 });
  const run = await until(s => s.completedCycles >= 2);
  assert.equal(run.status, 'running');
  assert.equal(run.tabs.length, 1);
  await command('STOP');
});

test('rejecting a second start does not interrupt the current run', async () => {
  await start(['existing'], { speed: 100 });
  await until(s => s.top > 0);
  const rejected = await command('START', { config: { urls: [`${origin}/other`] } });
  assert.equal(rejected.ok, false);
  assert.equal((await state()).status, 'running');
  await command('STOP');
});

test('edge wait detects lazy-loaded extra height before moving on', async () => {
  await start(['dynamic'], { edgeWait: 500 });
  await until(s => s.status === 'completed');
  const edges = await panel.evaluate(() => window.edges);
  assert.equal(edges[0].max, 3000 - 720);
  assert.equal(edges[0].top, edges[0].max);
});

test('automatically scrolls the main nested container', async () => {
  await start(['nested']);
  const run = await until(s => s.status === 'completed');
  const edges = await panel.evaluate(() => window.edges);
  assert.equal(edges[0].top, 1500);
  assert.equal((await position(run.tabs[0], '.scroller')).top, 0);
});

test('closing a target tab reports an actionable error', async () => {
  await start(['close'], { speed: 100 });
  const run = await until(s => s.top > 0);
  await panel.evaluate(id => chrome.tabs.remove(id), run.tabs[0]);
  const failed = await until(s => s.status === 'error');
  assert.match(failed.error, /关闭/);
});

test('a missing custom scroll container reports an error', async () => {
  await start(['custom'], { selector: '.not-found' });
  const run = await until(s => s.status === 'error');
  assert.match(run.error, /滚动容器/);
});

test('reloading a target reports the navigation instead of leaving a stale run', async () => {
  await start(['reload'], { speed: 100 });
  const run = await until(s => s.top > 0);
  await panel.evaluate(id => chrome.tabs.reload(id), run.tabs[0]);
  const failed = await until(s => s.status === 'error');
  assert.match(failed.error, /刷新|跳转/);
});

test('closing and reopening the control panel does not interrupt a run', async () => {
  await start(['panel-close'], { speed: 250 });
  let run = await until(s => s.top > 50);
  const oldTop = run.top;
  await panel.close();
  await new Promise(resolve => setTimeout(resolve, 800));
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/popup.html`);
  run = await state();
  assert.equal(run.status, 'running');
  assert.ok(run.top > oldTop);
  await command('STOP');
});

test('service worker restart preserves cursor and lets scrolling continue', async () => {
  await start(['worker-restart'], { speed: 220 });
  const run = await until(s => s.top > 40);
  const devtools = await context.newCDPSession(panel);
  const versions = new Map();
  devtools.on('ServiceWorker.workerVersionUpdated', event => {
    for (const version of event.versions) versions.set(version.versionId, version);
  });
  await devtools.send('ServiceWorker.enable');
  for (let attempts = 0; ![...versions.values()].some(v => v.scriptURL.includes(extensionId)); attempts++) {
    if (attempts > 40) throw new Error('Extension worker was not exposed by CDP');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const version = [...versions.values()].find(v => v.scriptURL.includes(extensionId) && v.runningStatus === 'running');
  await devtools.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  const resumed = await until(s => s.top > run.top + 100);
  assert.equal(resumed.step, run.step);
  assert.deepEqual(resumed.tabs, run.tabs);
  await devtools.detach();
  await command('STOP');
});

test('timed pauses stop real scrolling and manual pause freezes the remaining rest', async () => {
  await start(['timed-pause'], { speed: 1000, pauseMode: 'timed', scrollDuration: 200, pauseDuration: 1200 });
  const resting = await until(s => s.resting);
  const top = (await position(resting.tabs[0])).top;
  assert.ok(top >= 120 && top <= 280, `expected variable-speed movement around a 200 px baseline, got ${top}`);
  assert.equal(await panel.locator('#status').textContent(), '停顿中');
  await command('PAUSE');
  const paused = await state();
  assert.ok(paused.cadence.restRemaining > 800);
  await new Promise(resolve => setTimeout(resolve, 1300));
  assert.equal((await position(resting.tabs[0])).top, top);
  await command('RESUME');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await position(resting.tabs[0])).top, top);
  await until(s => s.top > top);
  await command('STOP');
});

test('random mode scrolls 1–600 px and waits at least one second before moving again', async () => {
  await start(['random-pause'], { pauseMode: 'random' });
  const resting = await until(s => s.resting);
  assert.ok(resting.top >= 1 && resting.top <= 600);
  assert.ok(resting.pauseRemaining >= 900 && resting.pauseRemaining <= 20000);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal((await position(resting.tabs[0])).top, resting.top);
  await command('STOP');
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal((await position(resting.tabs[0])).top, resting.top);
});

test('custom random pause bounds reach the page and control the actual wait', async () => {
  await start(['configured-random-pause'], { pauseMode: 'random', randomPauseMin: 2, randomPauseMax: 2 });
  const resting = await until(s => s.resting);
  const began = Date.now();
  assert.ok(resting.pauseRemaining >= 1900 && resting.pauseRemaining <= 2000);
  await panel.reload();
  await panel.waitForFunction(() => document.getElementById('random-pause-min').value === '2');
  assert.equal(await panel.locator('#random-pause-min').isDisabled(), true);
  assert.equal(await panel.locator('#random-pause-max').inputValue(), '2');
  assert.equal(await panel.locator('#random-pause-max').isDisabled(), true);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal((await position(resting.tabs[0])).top, resting.top);
  await until(s => !s.resting || s.top > resting.top, 4000);
  assert.ok(Date.now() - began >= 1800, 'custom two-second pause must not end early');
  await command('STOP');
});

test('timed mode still completes a round trip across multiple pages', async () => {
  await start(['timed-a', 'timed-b'], { pauseMode: 'timed', scrollDuration: 100, pauseDuration: 100, reverseMin: 40, reverseMax: 40 });
  const run = await until(s => s.status === 'completed');
  const edges = await panel.evaluate(() => window.edges);
  assert.deepEqual(edges.map(e => `${e.index}:${e.direction}`), ['0:down', '1:down', '1:up', '0:up']);
  for (const tabId of run.tabs) assert.equal((await position(tabId)).top, 0);
  const samples = await panel.evaluate(() => window.motionSamples);
  const anchors = new Map();
  const reversedDirections = new Set();
  for (const sample of samples) {
    if (sample.resting) anchors.set(sample.step, sample.top);
    if (sample.recovering && anchors.has(sample.step)) {
      const anchor = anchors.get(sample.step);
      assert.equal(sample.top, anchor + (sample.direction === 'down' ? -40 : 40));
      reversedDirections.add(sample.direction);
      anchors.delete(sample.step);
    }
  }
  assert.deepEqual([...reversedDirections].sort(), ['down', 'up']);
});

test('switching modes ignores invalid values in hidden, unused controls', async () => {
  await panel.reload();
  await panel.locator('#urls').fill(`${origin}/unused-fields`);
  await panel.locator('#pause-mode').selectOption('timed');
  await panel.locator('#scroll-duration').fill('');
  await panel.locator('#pause-mode').selectOption('random');
  assert.equal(await panel.locator('#scroll-duration').inputValue(), '');
  await panel.locator('#save').click();
  await panel.locator('#notice').filter({ hasText: '配置已保存' }).waitFor({ timeout: 1500 });
  assert.equal((await command('GET_STATE')).config.pauseMode, 'random');
  await panel.locator('#reverse-min').fill('200');
  await panel.locator('#reverse-max').fill('20');
  await panel.locator('#random-pause-min').fill('30');
  await panel.locator('#random-pause-max').fill('5');
  await panel.locator('#save').click();
  await panel.locator('#notice').filter({ hasText: '最短时间不能大于最长时间' }).waitFor({ timeout: 1500 });
  await panel.locator('#pause-mode').selectOption('continuous');
  await panel.locator('#save').click();
  await panel.locator('#notice').filter({ hasText: '配置已保存' }).waitFor({ timeout: 1500 });
  assert.equal((await command('GET_STATE')).config.pauseMode, 'continuous');
});

test('one-pixel reversals complete on a real zoomed scroll container', async () => {
  await start(['nested-zoom'], { pauseMode: 'timed', scrollDuration: 100, pauseDuration: 100, reverseMin: 1, reverseMax: 1 });
  const run = await until(s => s.status === 'completed');
  assert.equal((await position(run.tabs[0], '.scroller')).top, 0);
});

test('popup validates input, saves configuration and renders controls', async () => {
  await panel.reload();
  await panel.locator('#urls').fill('chrome://settings');
  await panel.locator('#start').click();
  await panel.locator('#notice').filter({ hasText: 'HTTP/HTTPS' }).waitFor();
  await panel.locator('#urls').fill(`${origin}/ui-a\n${origin}/ui-b`);
  await panel.locator('#speed').fill('220');
  await panel.locator('#pause-mode').selectOption('timed');
  await panel.locator('#scroll-duration').fill('1.2');
  await panel.locator('#pause-duration').fill('3.4');
  await panel.locator('#reverse-min').fill('12');
  await panel.locator('#reverse-max').fill('65');
  await panel.locator('#save').click();
  await panel.reload();
  await panel.waitForFunction(() => document.getElementById('speed').value === '220');
  assert.equal(await panel.locator('#speed').inputValue(), '220');
  assert.match(await panel.locator('#urls').inputValue(), /ui-b/);
  assert.equal(await panel.locator('#pause-mode').inputValue(), 'timed');
  assert.equal(await panel.locator('#scroll-duration').inputValue(), '1.2');
  assert.equal(await panel.locator('#pause-duration').inputValue(), '3.4');
  assert.equal(await panel.locator('#reverse-min').inputValue(), '12');
  assert.equal(await panel.locator('#reverse-max').inputValue(), '65');
  await panel.locator('#pause-mode').selectOption('random');
  assert.equal(await panel.locator('#timed-settings').isVisible(), false);
  assert.match(await panel.locator('#pause-hint').textContent(), /1–600.*1–20/);
  await panel.locator('#random-pause-min').fill('5');
  await panel.locator('#random-pause-max').fill('30');
  assert.match(await panel.locator('#pause-hint').textContent(), /5–30/);
  await panel.locator('#save').click();
  await panel.locator('#notice').filter({ hasText: '配置已保存' }).waitFor();
  await panel.reload();
  await panel.waitForFunction(() => document.getElementById('pause-mode').value === 'random');
  assert.equal(await panel.locator('#random-pause-min').inputValue(), '5');
  assert.equal(await panel.locator('#random-pause-max').inputValue(), '30');
  assert.match(await panel.locator('#pause-hint').textContent(), /5–30/);
  await mkdir('artifacts', { recursive: true });
  await panel.setViewportSize({ width: 420, height: 600 });
  await panel.evaluate(() => window.scrollTo(0, 0));
  const startButton = await panel.locator('#start').boundingBox();
  assert.ok(startButton.y + startButton.height <= 600, 'Start control must fit within Chrome popup height');
  await panel.screenshot({ path: 'artifacts/control-panel.png', fullPage: true });
});
