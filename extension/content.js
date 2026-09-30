(() => {
  if (globalThis.__autoScrollInstalled) return;
  globalThis.__autoScrollInstalled = true;
  let active = null;

  function chooseScroller(selector) {
    if (selector) {
      let element;
      try { element = document.querySelector(selector); }
      catch { throw new Error('滚动容器的 CSS 选择器格式无效。'); }
      if (!element) throw new Error(`找不到滚动容器：${selector}`);
      return element;
    }
    const root = document.scrollingElement ?? document.documentElement;
    if (root.scrollHeight > root.clientHeight + 2) return root;
    let best = root;
    let area = 0;
    for (const element of document.querySelectorAll('body *')) {
      if (element.scrollHeight <= element.clientHeight + 2 || element.clientHeight < 80) continue;
      const rect = element.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) continue;
      const style = getComputedStyle(element);
      if (!['auto', 'scroll', 'overlay'].includes(style.overflowY) || style.visibility === 'hidden' || style.display === 'none') continue;
      const visibleArea = Math.min(rect.width, innerWidth) * Math.min(rect.height, innerHeight);
      if (visibleArea > area) { best = element; area = visibleArea; }
    }
    return best;
  }

  function stop() {
    if (!active) return;
    cancelAnimationFrame(active.frame);
    clearTimeout(active.timer);
    clearInterval(active.heartbeat);
    for (const [key, value, priority] of active.styles) {
      if (value) active.element.style.setProperty(key, value, priority);
      else active.element.style.removeProperty(key);
    }
    active = null;
  }

  function metrics(task) {
    const max = Math.max(0, task.element.scrollHeight - task.element.clientHeight);
    const top = Math.max(0, Math.min(max, task.element.scrollTop));
    return {
      top, max, progress: max === 0 ? 0 : task.direction === 'down' ? top / max : 1 - top / max,
      resting: task.restUntil !== null,
      backtracking: Boolean(task.backtracking), recovering: Boolean(task.recovering),
      pauseRemaining: task.restUntil === null ? 0 : Math.max(0, task.restUntil - performance.now()),
    };
  }

  function beginBurst(task) {
    task.restUntil = null;
    task.backtracking = false;
    task.recovering = false;
    if (task.pauseMode === 'random') task.fraction = 0;
    task.scrollRemaining = task.scrollDuration;
    task.distanceRemaining = task.pauseMode === 'random' ? 1 + Math.floor(Math.random() * 600) : 0;
  }

  function beginBacktrack(task) {
    const { top, max } = metrics(task);
    const distance = task.reverseMin + Math.floor(Math.random() * (task.reverseMax - task.reverseMin + 1));
    task.restUntil = null;
    task.returnTop = top;
    task.motionFraction = 0;
    task.backtrackRemaining = Math.min(distance, task.direction === 'down' ? top : max - top);
    task.backtracking = task.backtrackRemaining > 0;
    task.recovering = false;
    if (!task.backtracking) beginBurst(task);
  }

  function cadenceSnapshot(task) {
    if (!task) return null;
    return {
      pauseMode: task.pauseMode, fraction: task.fraction,
      scrollRemaining: task.scrollRemaining, distanceRemaining: task.distanceRemaining,
      resting: task.restUntil !== null,
      restRemaining: task.restUntil === null ? 0 : Math.max(0, task.restUntil - performance.now()),
      motionTime: task.motionTime, motionFraction: task.motionFraction,
      backtracking: task.backtracking, backtrackRemaining: task.backtrackRemaining,
      recovering: task.recovering, returnTop: task.returnTop,
    };
  }

  function progress(task, now, force = false) {
    if (force || now - task.lastReport >= 400) {
      task.lastReport = now;
      report('SCROLL_PROGRESS', task);
    }
  }

  function report(type, task, extra = {}) {
    chrome.runtime.sendMessage({ type, step: task.step, ...metrics(task), ...extra }).then(response => {
      if (response?.cancelled && active === task) stop();
    }).catch(() => { if (active === task) stop(); });
  }

  function schedule(task) {
    if (task.restUntil !== null) task.timer = setTimeout(() => tick(performance.now()), Math.max(1, Math.min(100, task.restUntil - performance.now())));
    else if (document.hidden) task.timer = setTimeout(() => tick(performance.now()), 50);
    else task.frame = requestAnimationFrame(tick);
  }

  document.addEventListener('visibilitychange', () => {
    if (!active) return;
    // A pending animation frame will not fire once a tab is hidden.
    cancelAnimationFrame(active.frame);
    clearTimeout(active.timer);
    active.lastFrame = performance.now();
    schedule(active);
  });

  function tick(now) {
    const task = active;
    if (!task) return;
    if (!task.element.isConnected) {
      report('SCROLL_ERROR', task, { error: '滚动容器已被页面移除，请重新开始。' });
      stop();
      return;
    }
    let elapsed = Math.max(0, now - task.lastFrame);
    task.lastFrame = now;
    if (task.restUntil !== null) {
      if (now < task.restUntil) {
        progress(task, now);
        schedule(task);
        return;
      }
      beginBacktrack(task);
      elapsed = 0; // Rest time must never be converted into scrolling distance.
      progress(task, now, true);
    }
    const returning = task.backtracking || task.recovering;
    const movingTime = Math.min(elapsed, 100, !returning && task.pauseMode === 'timed' ? task.scrollRemaining : Infinity);
    // Smooth acceleration/deceleration around the user's baseline (60%–140%).
    const speedFactor = 1 + 0.4 * Math.sin((task.motionTime + movingTime / 2) * Math.PI * 2 / 1800);
    task.motionTime += movingTime;
    const fractionKey = returning ? 'motionFraction' : 'fraction';
    task[fractionKey] += task.speed * speedFactor * movingTime / 1000;
    const wholePixels = Math.floor(task[fractionKey]);
    task[fractionKey] -= wholePixels;
    const beforeMetrics = metrics(task);
    const before = beforeMetrics.top;
    const sign = task.direction === 'down' ? 1 : -1;
    const returnTarget = Math.min(beforeMetrics.max, task.returnTop ?? 0);
    const recoverRemaining = Math.max(0, (returnTarget - before) * sign);
    const limit = task.backtracking ? task.backtrackRemaining : task.recovering ? recoverRemaining : task.pauseMode === 'random' ? task.distanceRemaining : Infinity;
    const pixels = Math.min(wholePixels, limit);
    if (pixels) {
      const target = task.recovering && pixels >= recoverRemaining
        ? returnTarget : before + pixels * sign * (task.backtracking ? -1 : 1);
      task.element.scrollTo({ top: target, behavior: 'instant' });
    }
    const { top, max } = metrics(task);
    // Zoomed containers quantize scrollTop. A final subpixel request can round
    // to the current position; finish it only after actually attempting it.
    const quantizedEnd = pixels > 0 && pixels < 1 && Math.abs(top - before) < 0.001;
    if (returning) {
      if (task.backtracking) {
        task.backtrackRemaining = Math.max(0, task.backtrackRemaining - Math.abs(top - before));
        const reverseEdge = task.direction === 'down' ? top <= 0 : top >= max;
        if (task.backtrackRemaining <= 0.001 || reverseEdge || quantizedEnd) {
          task.backtracking = false;
          task.recovering = true;
          task.motionFraction = 0;
          progress(task, now, true);
        }
      } else if ((Math.min(max, task.returnTop) - top) * sign <= 0.001 || quantizedEnd) {
        // Retrace the backtrack before counting the next burst, so short bursts
        // always make forward progress instead of oscillating at the same spot.
        beginBurst(task);
        progress(task, now, true);
      }
      task.edgeSince = null;
      progress(task, now);
      schedule(task);
      return;
    }
    if (task.pauseMode === 'timed') task.scrollRemaining = Math.max(0, task.scrollRemaining - elapsed);
    if (task.pauseMode === 'random') task.distanceRemaining = quantizedEnd ? 0 : Math.max(0, task.distanceRemaining - Math.abs(top - before));
    const atEdge = task.direction === 'down' ? max - top <= 1 : top <= 1;
    if (!atEdge || max !== task.lastMax) task.edgeSince = null;
    task.lastMax = max;
    if (atEdge) {
      task.edgeSince ??= now;
      if (now - task.edgeSince >= task.edgeWait) {
        task.element.scrollTo({ top: task.direction === 'down' ? max : 0, behavior: 'instant' });
        report('SCROLL_EDGE', task);
        stop();
        return;
      }
    } else if ((task.pauseMode === 'timed' && task.scrollRemaining === 0) || (task.pauseMode === 'random' && task.distanceRemaining <= 0.001)) {
      const duration = task.pauseMode === 'random'
        ? (task.randomPauseMin + Math.floor(Math.random() * (task.randomPauseMax - task.randomPauseMin + 1))) * 1000
        : task.pauseDuration;
      task.restUntil = now + duration;
      progress(task, now, true);
    }
    progress(task, now);
    schedule(task);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'SCROLL_PAUSE') {
      const cadence = cadenceSnapshot(active);
      stop();
      sendResponse({ ok: true, cadence });
    }
    if (message.type === 'SCROLL_STOP') { stop(); sendResponse({ ok: true }); }
    if (message.type === 'SCROLL_STATUS') sendResponse({ active: Boolean(active) });
    if (message.type === 'SCROLL_SPEED') {
      if (active) active.speed = message.speed;
      sendResponse({ ok: true });
    }
    if (message.type === 'SCROLL_START') {
      try {
        stop();
        const element = chooseScroller(message.selector);
        const styles = ['scroll-behavior', 'scroll-snap-type', 'overflow-anchor'].map(key => [key, element.style.getPropertyValue(key), element.style.getPropertyPriority(key)]);
        element.style.setProperty('scroll-behavior', 'auto', 'important');
        element.style.setProperty('scroll-snap-type', 'none', 'important');
        element.style.setProperty('overflow-anchor', 'none', 'important');
        if (message.reset) element.scrollTo({ top: message.direction === 'down' ? 0 : element.scrollHeight, behavior: 'instant' });
        const now = performance.now();
        active = {
          pauseMode: 'continuous', scrollDuration: 5000, pauseDuration: 2000,
          randomPauseMin: 1, randomPauseMax: 20,
          reverseMin: 1, reverseMax: 100, motionTime: 0, motionFraction: 0,
          ...message, element, styles, lastFrame: now, lastReport: now, fraction: 0, edgeSince: null, lastMax: -1,
        };
        const task = active;
        if (!message.reset && message.cadence?.pauseMode === task.pauseMode) {
          Object.assign(task, message.cadence);
          task.restUntil = message.cadence.resting ? now + message.cadence.restRemaining : null;
        } else beginBurst(task);
        task.heartbeat = setInterval(() => report('SCROLL_PROGRESS', task), 3000);
        schedule(task);
        progress(task, now, true);
        sendResponse({ ok: true });
      } catch (error) {
        stop();
        sendResponse({ ok: false, error: error.message });
      }
    }
  });
})();
