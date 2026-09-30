import { DEFAULTS, normalizeConfig, createRun, advance } from './model.js';

let run = null;
let queue = Promise.resolve();
const ready = chrome.storage.session.get('run').then(data => { run = data.run ?? null; });

function enqueue(task) {
  const result = queue.then(() => ready).then(task);
  queue = result.catch(() => {});
  return result;
}

function event(task) {
  enqueue(task).catch(error => enqueue(() => fail(error.message)).catch(console.error));
}

async function persist() {
  await chrome.storage.session.set({ run });
}

async function badge() {
  const text = run?.status === 'running' ? (run.direction === 'down' ? '↓' : '↑') : run?.status === 'paused' ? 'Ⅱ' : run?.status === 'error' ? '!' : '';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: run?.status === 'error' ? '#dc6262' : '#43735b' });
}

async function stopContent(preserveCadence = false) {
  const tabId = run?.tabs[run.index];
  if (tabId !== undefined) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: preserveCadence ? 'SCROLL_PAUSE' : 'SCROLL_STOP' });
      if (preserveCadence) run.cadence = response?.cadence ?? null;
    } catch { /* Page may be loading or closed. */ }
  }
}

async function fail(message) {
  if (!run || !['running', 'paused'].includes(run.status)) return;
  run.status = 'error';
  run.error = message;
  await stopContent();
  await persist();
  await badge();
  await chrome.alarms.clear('run-watchdog');
}

async function startContent() {
  if (run?.status !== 'running' || run.phase !== 'loading') return;
  const tabId = run.tabs[run.index];
  const tab = await chrome.tabs.get(tabId);
  if (tab.status !== 'complete' || tab.pendingUrl || !/^https?:\/\//i.test(tab.url ?? '')) return;
  run.phase = 'starting';
  await persist();
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'], injectImmediately: true });
    run.phase = 'scrolling';
    await persist();
    const result = await chrome.tabs.sendMessage(tabId, {
      type: 'SCROLL_START', step: run.step, direction: run.direction,
      speed: run.config.speed, edgeWait: run.config.edgeWait,
      selector: run.config.selector, reset: run.reset,
      pauseMode: run.config.pauseMode ?? DEFAULTS.pauseMode,
      scrollDuration: run.config.scrollDuration ?? DEFAULTS.scrollDuration,
      pauseDuration: run.config.pauseDuration ?? DEFAULTS.pauseDuration,
      randomPauseMin: run.config.randomPauseMin ?? DEFAULTS.randomPauseMin,
      randomPauseMax: run.config.randomPauseMax ?? DEFAULTS.randomPauseMax,
      reverseMin: run.config.reverseMin ?? DEFAULTS.reverseMin,
      reverseMax: run.config.reverseMax ?? DEFAULTS.reverseMax,
      cadence: run.cadence,
    });
    if (!result?.ok) throw new Error(result?.error ?? '页面未响应滚动指令。');
  } catch (error) {
    await fail(`第 ${run.index + 1} 个页面无法滚动：${error.message}`);
  }
}

async function beginSegment(reset = true) {
  run.step = crypto.randomUUID();
  run.phase = 'loading';
  run.progress = 0;
  run.reset = reset;
  run.resting = false;
  run.backtracking = false;
  run.recovering = false;
  run.pauseRemaining = 0;
  if (reset) run.cadence = null;
  run.segmentStarted = Date.now();
  run.error = '';
  await persist();
  await badge();
  const tabId = run.tabs[run.index];
  if (tabId === undefined) {
    const tab = await chrome.tabs.create({ url: run.config.urls[run.index], active: true, windowId: run.windowId });
    run.tabs[run.index] = tab.id;
    await persist();
    if (tab.status === 'complete') await startContent();
  } else {
    let tab;
    try { tab = await chrome.tabs.update(tabId, { active: true }); }
    catch { await fail(`第 ${run.index + 1} 个页面已关闭，请重新开始。`); return; }
    if (tab.status === 'complete') await startContent();
  }
}

function matchesSegment(message, sender) {
  return run?.status === 'running' && run.phase === 'scrolling' &&
    message.step === run.step && sender.tab?.id === run.tabs[run.index] && sender.frameId === 0;
}

async function handleContent(message, sender) {
  if (!matchesSegment(message, sender)) return { ok: true, cancelled: true };
  if (message.type === 'SCROLL_ERROR') {
    await fail(`第 ${run.index + 1} 个页面：${message.error}`);
    return { ok: true };
  }
  run.top = message.top;
  run.max = message.max;
  run.resting = Boolean(message.resting);
  run.backtracking = Boolean(message.backtracking);
  run.recovering = Boolean(message.recovering);
  run.pauseRemaining = message.pauseRemaining ?? 0;
  run.progress = message.type === 'SCROLL_EDGE' ? 1 : message.progress;
  if (message.type === 'SCROLL_EDGE') run.phase = 'edge';
  run.lastSeen = Date.now();
  await persist();
  if (message.type === 'SCROLL_EDGE') {
    run = advance(run);
    if (run.status === 'completed') {
      run.phase = 'done';
      await persist();
      await badge();
      await chrome.alarms.clear('run-watchdog');
    } else await beginSegment();
  }
  return { ok: true };
}

async function command(message, sender) {
  if (['SCROLL_PROGRESS', 'SCROLL_EDGE', 'SCROLL_ERROR'].includes(message.type)) return handleContent(message, sender);
  // Only our own extension UI can control a run. Content scripts can report progress only.
  if (sender.tab || !sender.url?.startsWith(chrome.runtime.getURL(''))) {
    // Extension pages opened in a tab also have sender.tab.
    if (!sender.url?.startsWith(chrome.runtime.getURL(''))) throw new Error('不允许来自网页的控制指令。');
  }
  switch (message.type) {
    case 'GET_STATE': {
      const { config = DEFAULTS } = await chrome.storage.local.get('config');
      return { ok: true, state: run, config };
    }
    case 'SAVE_CONFIG': {
      const config = normalizeConfig(message.config);
      await chrome.storage.local.set({ config });
      return { ok: true, config };
    }
    case 'START': {
      const config = normalizeConfig(message.config);
      if (['running', 'paused'].includes(run?.status)) throw new Error('请先停止当前任务，再开始新的任务。');
      await chrome.storage.local.set({ config });
      run = createRun(config);
      run.windowId = (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id;
      await chrome.alarms.create('run-watchdog', { periodInMinutes: 0.5 });
      try { await beginSegment(); }
      catch (error) { await fail(error.message); }
      return { ok: true };
    }
    case 'PAUSE':
      if (run?.status === 'running') {
        run.status = 'paused';
        await stopContent(true);
        await persist();
        await badge();
      }
      return { ok: true };
    case 'RESUME':
      if (run?.status === 'paused') {
        const reset = run.phase === 'scrolling' ? false : run.reset;
        run.status = 'running';
        await beginSegment(reset);
      }
      return { ok: true };
    case 'STOP':
      if (run && ['running', 'paused'].includes(run.status)) {
        run.status = 'stopped';
        await stopContent();
        await persist();
        await badge();
      }
      await chrome.alarms.clear('run-watchdog');
      return { ok: true };
    case 'SET_SPEED': {
      const { config: stored = DEFAULTS } = await chrome.storage.local.get('config');
      const config = normalizeConfig({ ...(run?.config ?? stored), speed: message.speed });
      if (run && ['running', 'paused'].includes(run.status)) {
        run.config.speed = config.speed;
        if (run.status === 'running' && run.phase === 'scrolling') {
          await chrome.tabs.sendMessage(run.tabs[run.index], { type: 'SCROLL_SPEED', speed: config.speed });
        }
        await persist();
      }
      await chrome.storage.local.set({ config: { ...stored, speed: config.speed } });
      return { ok: true };
    }
    default: throw new Error('未知操作。');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  enqueue(() => command(message, sender)).then(sendResponse, async error => {
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, change) => event(async () => {
  if (!run || !['running', 'paused'].includes(run.status)) return;
  const index = run.tabs.indexOf(tabId);
  if (index === -1) return;
  if (change.status === 'loading' && !(index === run.index && run.phase === 'loading')) {
    await fail(`第 ${index + 1} 个页面发生刷新或跳转，请等待加载完成后重新开始。`);
  } else if (index === run.index && change.status === 'complete' && run.status === 'running') {
    await startContent();
  }
}));

chrome.tabs.onRemoved.addListener(tabId => event(async () => {
  if (run?.tabs.includes(tabId)) await fail(`第 ${run.tabs.indexOf(tabId) + 1} 个页面已关闭，请重新开始。`);
}));

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'run-watchdog') return;
  event(async () => {
    if (run?.status !== 'running') return;
    if (run.phase === 'loading' || run.phase === 'starting') {
      const tab = await chrome.tabs.get(run.tabs[run.index]);
      if (tab.status === 'complete') {
        run.phase = 'loading';
        await startContent();
      } else if (Date.now() - run.segmentStarted > 30000) {
        await fail(`第 ${run.index + 1} 个页面加载超时，请检查地址和网络后重新开始。`);
      }
    } else {
      const status = await chrome.tabs.sendMessage(run.tabs[run.index], { type: 'SCROLL_STATUS' });
      if (!status?.active) await beginSegment(false);
    }
  });
});
