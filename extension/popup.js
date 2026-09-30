import { DEFAULTS, normalizeConfig } from './model.js';

const $ = id => document.getElementById(id);
let run = null;
let busy = false;
let noticeTimer;

async function send(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...data });
  if (!response?.ok) throw new Error(response?.error ?? '扩展未响应，请重新打开控制面板。');
  return response;
}

function notice(text, error = false) {
  clearTimeout(noticeTimer);
  $('notice').textContent = text;
  $('notice').hidden = !text;
  $('notice').classList.toggle('error', error);
  if (!error) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 3500);
}

async function action(task) {
  if (busy) return;
  busy = true;
  try { await task(); }
  catch (error) { notice(error.message, true); }
  finally { busy = false; }
}

function readConfig() {
  const config = {
    urls: $('urls').value, speed: $('speed').value,
    cycles: $('infinite').checked ? 0 : $('cycles').value,
    edgeWait: $('edge-wait').value === '' ? '' : Number($('edge-wait').value) * 1000,
    selector: $('selector').value,
    pauseMode: $('pause-mode').value,
    randomPauseMin: $('random-pause-min').value, randomPauseMax: $('random-pause-max').value,
    scrollDuration: $('scroll-duration').value === '' ? '' : Number($('scroll-duration').value) * 1000,
    pauseDuration: $('pause-duration').value === '' ? '' : Number($('pause-duration').value) * 1000,
    reverseMin: $('reverse-min').value, reverseMax: $('reverse-max').value,
  };
  // Keep valid values for the next mode switch, but do not let hidden fields
  // block the currently selected mode.
  if (config.pauseMode !== 'timed') {
    for (const key of ['scrollDuration', 'pauseDuration']) {
      if (!Number.isFinite(config[key]) || config[key] < 100 || config[key] > 3600000) config[key] = DEFAULTS[key];
    }
  }
  if (config.pauseMode !== 'random') {
    const min = Number(config.randomPauseMin), max = Number(config.randomPauseMax);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 3600 || min > max) {
      config.randomPauseMin = DEFAULTS.randomPauseMin;
      config.randomPauseMax = DEFAULTS.randomPauseMax;
    }
  }
  if (config.pauseMode === 'continuous') {
    const min = Number(config.reverseMin), max = Number(config.reverseMax);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 600 || min > max) {
      config.reverseMin = DEFAULTS.reverseMin;
      config.reverseMax = DEFAULTS.reverseMax;
    }
  }
  return normalizeConfig(config);
}

function updateCount() {
  $('url-count').textContent = $('urls').value.split(/\r?\n/).filter(url => url.trim()).length;
}

function highlightSpeed() {
  for (const button of document.querySelectorAll('[data-speed]')) button.classList.toggle('selected', Number(button.dataset.speed) === Number($('speed').value));
}

function updatePauseSettings() {
  const mode = $('pause-mode').value;
  const locked = ['running', 'paused'].includes(run?.status);
  $('timed-settings').hidden = mode !== 'timed';
  $('pause-mode').disabled = locked;
  $('scroll-duration').disabled = locked || mode !== 'timed';
  $('pause-duration').disabled = locked || mode !== 'timed';
  $('random-settings').hidden = mode !== 'random';
  $('random-pause-min').disabled = locked || mode !== 'random';
  $('random-pause-max').disabled = locked || mode !== 'random';
  $('reverse-settings').hidden = mode === 'continuous';
  $('reverse-min').disabled = locked || mode === 'continuous';
  $('reverse-max').disabled = locked || mode === 'continuous';
  const min = Number($('random-pause-min').value), max = Number($('random-pause-max').value);
  const validRange = Number.isInteger(min) && Number.isInteger(max) && min >= 1 && max <= 3600 && min <= max;
  $('pause-hint').textContent = {
    continuous: '持续滚动，直到页面顶部或底部。',
    timed: '按设置的速度滑动，停顿结束后自动继续。',
    random: validRange ? `每段随机滑动 1–600 像素，再随机停顿 ${min}–${max} 秒。` : '每段随机滑动 1–600 像素；请设置 1–3600 秒内的有效停顿范围。',
  }[mode];
}

function fillConfig(config) {
  $('urls').value = config.urls.join('\n');
  $('speed').value = config.speed;
  $('infinite').checked = config.cycles === 0;
  $('cycles').value = config.cycles || 1;
  $('edge-wait').value = config.edgeWait / 1000;
  $('selector').value = config.selector ?? '';
  $('pause-mode').value = config.pauseMode ?? DEFAULTS.pauseMode;
  $('scroll-duration').value = (config.scrollDuration ?? DEFAULTS.scrollDuration) / 1000;
  $('pause-duration').value = (config.pauseDuration ?? DEFAULTS.pauseDuration) / 1000;
  $('random-pause-min').value = config.randomPauseMin ?? DEFAULTS.randomPauseMin;
  $('random-pause-max').value = config.randomPauseMax ?? DEFAULTS.randomPauseMax;
  $('reverse-min').value = config.reverseMin ?? DEFAULTS.reverseMin;
  $('reverse-max').value = config.reverseMax ?? DEFAULTS.reverseMax;
  updateCount();
  highlightSpeed();
  updatePauseSettings();
}

function render(state) {
  run = state;
  const status = run?.status ?? 'idle';
  const running = status === 'running';
  const paused = status === 'paused';
  const locked = running || paused;
  const resting = running && run.phase === 'scrolling' && run.resting;
  const labels = { idle: '就绪', running: '运行中', paused: '已暂停', stopped: '已停止', completed: '已完成', error: '需处理' };
  $('status').textContent = resting ? '停顿中' : labels[status];
  $('status').dataset.status = status;
  for (const id of ['urls', 'cycles', 'infinite', 'edge-wait', 'selector', 'add-current', 'save']) $(id).disabled = locked;
  $('cycles').disabled = locked || $('infinite').checked;
  updatePauseSettings();
  $('start').hidden = locked;
  $('pause').hidden = !locked;
  $('pause').textContent = paused ? '▶ 继续滚动' : 'Ⅱ 暂停';
  $('stop').hidden = !locked;
  $('save').hidden = locked;
  const percent = Math.round(Math.max(0, Math.min(1, run?.progress ?? 0)) * 100);
  $('progress').style.width = `${percent}%`;
  document.querySelector('[role="progressbar"]').setAttribute('aria-valuenow', percent);
  $('cycle-progress').textContent = `已完成 ${run?.completedCycles ?? 0} ${run?.config.cycles ? `/ ${run.config.cycles} ` : ''}轮`;
  if (run) {
    const down = run.direction === 'down';
    $('direction').textContent = running && run.backtracking ? (down ? '↑' : '↓') : down ? '↓' : '↑';
    $('run-title').textContent = running ? (run.phase === 'loading' || run.phase === 'starting' ? '正在打开页面…' : down ? '向下，依次探索。' : '向上，沿途返回。') : paused ? '稍作停留，随时继续。' : status === 'completed' ? '往返完成，回到起点。' : status === 'error' ? '任务中断，请检查页面。' : '滚动已停止。';
    if (resting) $('run-title').textContent = `停顿中，${Math.max(1, Math.ceil(run.pauseRemaining / 1000))} 秒后继续。`;
    else if (running && run.backtracking) $('run-title').textContent = '正在随机反向回滑…';
    else if (running && run.recovering) $('run-title').textContent = '恢复原方向，继续前进。';
    $('run-detail').textContent = run.config.urls[run.index];
    $('run-detail').title = run.config.urls[run.index];
    $('page-progress').textContent = `页面 ${run.index + 1} / ${run.config.urls.length} · ${down ? '下滚' : '回顶'} ${percent}%`;
    if (status === 'error') notice(run.error, true);
  }
}

$('config-form').addEventListener('submit', event => {
  event.preventDefault();
  action(async () => {
    const config = readConfig();
    notice('');
    await send('START', { config });
    render((await send('GET_STATE')).state);
  });
});
$('save').addEventListener('click', () => action(async () => {
  const { config } = await send('SAVE_CONFIG', { config: readConfig() });
  fillConfig(config);
  notice('配置已保存。');
}));
$('pause').addEventListener('click', () => action(async () => {
  await send(run?.status === 'paused' ? 'RESUME' : 'PAUSE');
  render((await send('GET_STATE')).state);
}));
$('stop').addEventListener('click', () => action(async () => {
  await send('STOP');
  render((await send('GET_STATE')).state);
}));
$('add-current').addEventListener('click', () => action(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:\/\//i.test(tab.url)) throw new Error('当前页面不是可滚动的 HTTP/HTTPS 网页。');
  $('urls').value = [$('urls').value.trim(), tab.url].filter(Boolean).join('\n');
  updateCount();
}));
$('urls').addEventListener('input', updateCount);
$('infinite').addEventListener('change', () => { $('cycles').disabled = $('infinite').checked; });
$('pause-mode').addEventListener('change', () => { updatePauseSettings(); notice(''); });
for (const id of ['random-pause-min', 'random-pause-max']) $(id).addEventListener('input', updatePauseSettings);

async function updateSpeed() {
  highlightSpeed();
  if (['running', 'paused'].includes(run?.status)) {
    await send('SET_SPEED', { speed: $('speed').value });
    notice('滚动速度已更新。');
  }
}
$('speed').addEventListener('change', () => action(updateSpeed));
for (const button of document.querySelectorAll('[data-speed]')) button.addEventListener('click', () => action(async () => {
  $('speed').value = button.dataset.speed;
  await updateSpeed();
}));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.run) render(changes.run.newValue);
});

action(async () => {
  const { config, state } = await send('GET_STATE');
  fillConfig(['running', 'paused'].includes(state?.status) ? state.config : { ...DEFAULTS, ...config });
  render(state);
});
