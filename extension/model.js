export const DEFAULTS = Object.freeze({
  urls: [], speed: 160, cycles: 1, edgeWait: 1500, selector: '',
  pauseMode: 'continuous', scrollDuration: 5000, pauseDuration: 2000,
  randomPauseMin: 1, randomPauseMax: 20,
  reverseMin: 1, reverseMax: 100,
});

function numberInRange(value, fallback, min, max, label, integer = false) {
  const number = value === undefined ? fallback : Number(value);
  if (value === '' || value === null || !Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    throw new Error(`${label}必须是 ${min}–${max} 之间的${integer ? '整数' : '数值'}。`);
  }
  return number;
}

export function normalizeConfig(input = {}) {
  const entries = Array.isArray(input.urls) ? input.urls : String(input.urls ?? '').split(/\r?\n/);
  const urls = entries.map(url => String(url).trim()).filter(Boolean).map((value, index) => {
    let url;
    try { url = new URL(value); } catch { throw new Error(`第 ${index + 1} 个地址无效，请填写完整的 http:// 或 https:// 地址。`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error(`第 ${index + 1} 个地址须为不含账号密码的 HTTP/HTTPS 网页。`);
    }
    return url.href;
  });
  if (!urls.length) throw new Error('请至少添加一个页面地址。');
  if (urls.length > 100) throw new Error('一次最多配置 100 个页面。');
  const pauseMode = input.pauseMode ?? DEFAULTS.pauseMode;
  if (!['continuous', 'timed', 'random'].includes(pauseMode)) throw new Error('请选择连续滚动、定时停顿或随机停顿。');
  const randomPauseMin = numberInRange(input.randomPauseMin, DEFAULTS.randomPauseMin, 1, 3600, '随机停顿最短时间（秒）', true);
  const randomPauseMax = numberInRange(input.randomPauseMax, DEFAULTS.randomPauseMax, 1, 3600, '随机停顿最长时间（秒）', true);
  if (randomPauseMin > randomPauseMax) throw new Error('随机停顿最短时间不能大于最长时间。');
  const reverseMin = numberInRange(input.reverseMin, DEFAULTS.reverseMin, 1, 600, '反向回滑最小距离', true);
  const reverseMax = numberInRange(input.reverseMax, DEFAULTS.reverseMax, 1, 600, '反向回滑最大距离', true);
  if (reverseMin > reverseMax) throw new Error('反向回滑最小距离不能大于最大距离。');
  return {
    urls,
    speed: numberInRange(input.speed, DEFAULTS.speed, 1, 5000, '滚动速度'),
    cycles: numberInRange(input.cycles, DEFAULTS.cycles, 0, 10000, '循环次数', true),
    edgeWait: numberInRange(input.edgeWait, DEFAULTS.edgeWait, 300, 10000, '边缘等待时间'),
    selector: String(input.selector ?? '').trim(),
    pauseMode,
    randomPauseMin, randomPauseMax,
    scrollDuration: numberInRange(input.scrollDuration, DEFAULTS.scrollDuration, 100, 3600000, '每段滚动时间（毫秒）'),
    pauseDuration: numberInRange(input.pauseDuration, DEFAULTS.pauseDuration, 100, 3600000, '每次停顿时间（毫秒）'),
    reverseMin, reverseMax,
  };
}

export function createRun(config) {
  return { config, status: 'running', index: 0, direction: 'down', completedCycles: 0, tabs: [], progress: 0 };
}

export function advance(run) {
  if (run.status !== 'running') return run;
  const next = { ...run, progress: 0 };
  if (run.direction === 'down') {
    if (run.index < run.config.urls.length - 1) next.index++;
    else next.direction = 'up';
  } else if (run.index > 0) {
    next.index--;
  } else {
    next.completedCycles++;
    if (run.config.cycles > 0 && next.completedCycles >= run.config.cycles) {
      next.status = 'completed';
      next.progress = 1;
    } else next.direction = 'down';
  }
  return next;
}
