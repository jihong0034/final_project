document.addEventListener("DOMContentLoaded", function () {
  const navLinks = document.querySelectorAll(".page-nav a");
  const header = document.querySelector(".site-header");
  let lastScrollTop = 0;

  // ── TTS & lecture mode globals ──────────────────────────
  let lectureMode = false;
  let lecturePaused = false;
  let currentUtterance = null;
  let lectureItems = [];
  let currentLectureIndex = 0;
  let lectureInitialized = false;
  let speakerMode = false;
  let speakerRunId = 0;

  let manualReadEnabled = true;
  let lastManualReadKey = '';
  let manualReadTimer = null;

  const SPEAKER_STEP_FINISH_DURATION = 2600;
  const LECTURE_STEP_FINISH_DURATION = 2200;

  function speakText(text) {
    if (!text || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    currentUtterance = utterance;
    utterance.lang = 'ko-KR';
    utterance.rate = 1.0;
    utterance.onend = () => { currentUtterance = null; };
    utterance.onerror = () => { currentUtterance = null; };
    window.speechSynthesis.speak(utterance);
  }

  function speakTextAsync(text) {
    return new Promise(resolve => {
      if (!text || !('speechSynthesis' in window)) { resolve(); return; }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      currentUtterance = utterance;
      let resolved = false;
      function finish() {
        if (resolved) return;
        resolved = true;
        currentUtterance = null;
        resolve();
      }
      utterance.lang = 'ko-KR';
      utterance.rate = 1.0;
      utterance.onend = finish;
      utterance.onerror = finish;
      window.speechSynthesis.speak(utterance);
    });
  }

  function stopSpeech() {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    currentUtterance = null;
  }

  function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function cleanText(text) {
    return (text || '')
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.!?])/g, '$1')
      .trim();
  }

  function clearTtsHighlight() {
    document.querySelectorAll('.tts-current').forEach(el => el.classList.remove('tts-current'));
  }

  function highlightTtsElement(element) {
    clearTtsHighlight();
    if (element) element.classList.add('tts-current');
  }

  function buildLectureItems() {
    const items = [];

    function push(el) {
      if (!el) return;
      const t = el.textContent.trim();
      if (t) items.push({ type: 'normal', element: el, text: t });
    }

    push(document.querySelector('#hero-title'));
    push(document.querySelector('.hero-text'));

    document.querySelectorAll([
      '.concept-block h3',
      '.concept-block p',
      '.quick-summary',
      '#conclusion .text-panel h2',
      '#conclusion .text-panel p',
      '#conclusion .text-panel li'
    ].join(',')).forEach(el => push(el));

    document.querySelectorAll('.scroll-scene').forEach(scene => {
      scene.querySelectorAll('.step-text').forEach(step => {
        const si = Number(step.dataset.step || 0);
        const children = Array.from(step.children).filter(c =>
          ['H2','H3','P','DIV','OL','UL','LI'].includes(c.tagName)
        );
        if (!children.length) {
          const t = step.textContent.trim();
          if (t) items.push({ type:'step', scene, step, stepIndex:si, element:step, text:t });
          return;
        }
        children.forEach(child => {
          const t = child.textContent.trim();
          if (t) items.push({ type:'step', scene, step, stepIndex:si, element:child, text:t });
        });
      });
    });

    items.sort((a, b) => {
      if (a.element === b.element) return 0;
      const p = a.element.compareDocumentPosition(b.element);
      if (p & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (p & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    return items;
  }

  function scrollToElementForReading(element) {
    if (!element) return;
    element.scrollIntoView({ behavior:'smooth', block:'center' });
  }

  function scrollToSceneStep(scene, stepIndex) {
    if (!scene) return;
    const total = Number(scene.dataset.steps || 1);
    const scrollable = Math.max(scene.offsetHeight - window.innerHeight, 1);
    const progress = Math.min(0.98, Math.max(0, (stepIndex + 0.55) / total));
    const top = window.scrollY + scene.getBoundingClientRect().top + scrollable * progress;
    window.scrollTo({ top, behavior:'smooth' });
  }

  function getSceneStepTargetY(scene, stepIndex, localProgress) {
    if (!scene) return window.scrollY;
    const total = Number(scene.dataset.steps || 1);
    const scrollable = Math.max(scene.offsetHeight - window.innerHeight, 1);
    const progress = Math.min(0.98, Math.max(0, (stepIndex + localProgress) / total));
    return window.scrollY + scene.getBoundingClientRect().top + scrollable * progress;
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function animateSceneStepProgress(scene, stepIndex, fromLocalProgress, toLocalProgress, duration) {
    return new Promise(resolve => {
      if (!scene) { resolve(); return; }
      const startY = getSceneStepTargetY(scene, stepIndex, fromLocalProgress);
      const endY = getSceneStepTargetY(scene, stepIndex, toLocalProgress);
      const startTime = performance.now();
      function frame(now) {
        const elapsed = now - startTime;
        const t = Math.min(1, elapsed / duration);
        const eased = easeInOutCubic(t);
        window.scrollTo({ top: startY + (endY - startY) * eased, behavior: 'auto' });
        updateAllScenes();
        if (t < 1) {
          requestAnimationFrame(frame);
        } else {
          updateAllScenes();
          resolve();
        }
      }
      requestAnimationFrame(frame);
    });
  }

  async function finishStepAnimation(scene, stepIndex, duration = SPEAKER_STEP_FINISH_DURATION) {
    if (!scene) return;
    await animateSceneStepProgress(scene, stepIndex, 0.58, 0.90, duration);
    await wait(250);
    updateAllScenes();
  }

  async function playLectureItem(item) {
    if (!item || !item.text) return;

    if (item.type === 'step') {
      scrollToSceneStep(item.scene, item.stepIndex);
      await wait(900);
      updateAllScenes();
      await wait(300);
      if (item.step && item.step.classList.contains('active')) {
        Array.from(item.step.children).forEach(c => c.classList.add('text-visible'));
      }
      scrollToElementForReading(item.element);
      await wait(400);
    } else {
      scrollToElementForReading(item.element);
      await wait(700);
    }

    highlightTtsElement(item.element);
    await speakTextAsync(cleanText(item.text));
    clearTtsHighlight();
    await wait(250);
  }

  function isLastItemOfStep(currentIndex) {
    const current = lectureItems[currentIndex];
    const next = lectureItems[currentIndex + 1];
    if (!current || current.type !== 'step') return false;
    if (!next) return true;
    return next.type !== 'step' || next.scene !== current.scene || next.stepIndex !== current.stepIndex;
  }
  async function startLectureMode() {
    if (lectureMode || speakerMode) return;

    lectureMode = true;
    lecturePaused = false;
    manualReadEnabled = false;

    const wasFreshStart = !lectureInitialized && lectureItems.length === 0 && currentLectureIndex === 0;

    prepareLectureItemsForPlayback();

    if (wasFreshStart) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      await wait(800);
      updateAllScenes();
    } else if (lectureItems[currentLectureIndex]) {
      const item = lectureItems[currentLectureIndex];
      if (item.type === 'step') {
        scrollToSceneStep(item.scene, item.stepIndex);
        await wait(700);
        updateAllScenes();
      } else {
        scrollToElementForReading(item.element);
        await wait(500);
      }
    }

    while (lectureMode && currentLectureIndex < lectureItems.length) {
      const item = lectureItems[currentLectureIndex];
      if (!item || !item.text) { currentLectureIndex++; continue; }
      if (!lectureMode) break;
      await playLectureItem(item);
      if (!lectureMode) break;
      if (item.type === 'step' && isLastItemOfStep(currentLectureIndex)) {
        await finishStepAnimation(item.scene, item.stepIndex, LECTURE_STEP_FINISH_DURATION);
        if (!lectureMode) break;
      }
      currentLectureIndex++;
    }

    if (currentLectureIndex >= lectureItems.length) resetLectureMode();
  }

  function pauseLectureMode() {
    lectureMode = false;
    speakerMode = false;
    speakerRunId += 1;
    lecturePaused = true;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    currentUtterance = null;
    clearTtsHighlight();
    const btn = document.querySelector('[data-cmd="lecture-stop"], [data-cmd="scroll"]');
    if (btn) {
      btn.textContent = '▶';
      btn.dataset.cmd = 'scroll';
      btn.setAttribute('aria-label', '강의 모드 다시 재생');
    }
    setTimeout(() => {
      manualReadEnabled = true;
      const cur = getCurrentReadableItem();
      lastManualReadKey = cur ? cur.key : '';
    }, 500);
  }

  function resetLectureMode() {
    lectureMode = false;
    speakerMode = false;
    speakerRunId += 1;
    lecturePaused = false;
    lectureInitialized = false;
    currentLectureIndex = 0;
    lectureItems = [];
    currentUtterance = null;
    clearTtsHighlight();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    const btn = document.querySelector('[data-cmd="lecture-stop"], [data-cmd="scroll"]');
    if (btn) {
      btn.textContent = '▶';
      btn.dataset.cmd = 'scroll';
      btn.setAttribute('aria-label', '강의 모드 시작');
    }
    setTimeout(() => {
      manualReadEnabled = true;
      const cur = getCurrentReadableItem();
      lastManualReadKey = cur ? cur.key : '';
    }, 500);
  }

  function getCurrentReadableItem() {
    const vhCenter = window.innerHeight / 2;

    function isVisible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.bottom > 0 && r.top < window.innerHeight &&
        s.opacity !== '0' && s.visibility !== 'hidden' && s.display !== 'none';
    }

    function distFromCenter(el) {
      const r = el.getBoundingClientRect();
      return Math.abs((r.top + r.height / 2) - vhCenter);
    }

    const candidates = [];

    document.querySelectorAll('.scroll-scene').forEach(scene => {
      const sr = scene.getBoundingClientRect();
      if (sr.bottom < 0 || sr.top > window.innerHeight) return;
      const active = scene.querySelector('.step-text.active');
      if (!active) return;
      const children = Array.from(active.querySelectorAll('h2, h3, p, div, ol, ul, li'))
        .filter(el => el.textContent.trim() && isVisible(el));
      children.forEach((el, i) => {
        candidates.push({
          key: `${scene.id}-${active.dataset.step}-${i}`,
          element: el,
          text: el.textContent.trim(),
          distance: distFromCenter(el)
        });
      });
    });

    const normals = Array.from(document.querySelectorAll(
      '#hero-title, .hero-text, .concept-block h3, .concept-block p, .quick-summary, #conclusion h2, #conclusion p, #conclusion li'
    ));
    normals.forEach((el, i) => {
      const t = el.textContent.trim();
      if (!t || !isVisible(el)) return;
      candidates.push({ key: `normal-${i}`, element: el, text: t, distance: distFromCenter(el) });
    });

    if (!candidates.length) return null;
    candidates.sort((a, b) => a.distance - b.distance);
    return candidates[0];
  }

  function ensureLectureItems() {
    if (!lectureInitialized || lectureItems.length === 0) {
      lectureItems = buildLectureItems();
      lectureInitialized = true;
    }
  }

  function prepareLectureItemsForPlayback() {
    const hadItems = lectureItems.length > 0;
    const savedIndex = currentLectureIndex;
    if (!hadItems) lectureItems = buildLectureItems();
    lectureInitialized = true;
    if (!lectureItems.length) { currentLectureIndex = 0; return; }
    currentLectureIndex = Math.min(Math.max(savedIndex, 0), lectureItems.length);
  }

  function findNextLectureIndexAfterSpeakerRange(range) {
    if (!range) return currentLectureIndex;
    ensureLectureItems();
    if (range.type === 'step') {
      const nextStepIndex = range.stepIndex + 1;
      const nextStepItemIndex = lectureItems.findIndex(item =>
        item && item.type === 'step' && item.scene === range.scene && item.stepIndex === nextStepIndex
      );
      if (nextStepItemIndex !== -1) return nextStepItemIndex;
      const afterRangeIndex = lectureItems.findIndex((item, index) => index > range.endIndex);
      if (afterRangeIndex !== -1) return afterRangeIndex;
      return lectureItems.length;
    }
    return Math.min(range.endIndex + 1, lectureItems.length);
  }

  function findLectureIndexByElement(targetElement) {
    if (!targetElement) return -1;
    ensureLectureItems();
    let idx = lectureItems.findIndex(item => item.element === targetElement);
    if (idx !== -1) return idx;
    idx = lectureItems.findIndex(item =>
      item.element && (item.element.contains(targetElement) || targetElement.contains(item.element))
    );
    return idx;
  }

  function getSpeakerLectureRangeFromElement(element) {
    if (!element) return null;
    ensureLectureItems();

    const hero = element.closest('#hero');
    if (hero) {
      const startEl = hero.querySelector('#hero-title');
      const endEl = hero.querySelector('.hero-text');
      const startIndex = findLectureIndexByElement(startEl);
      const endIndex = findLectureIndexByElement(endEl);
      if (startIndex !== -1 && endIndex !== -1) {
        return { type: 'hero', startIndex, endIndex, highlightElement: startEl || hero };
      }
    }

    const conceptBlock = element.closest('.concept-block');
    if (conceptBlock) {
      const els = Array.from(conceptBlock.querySelectorAll('h3, p'));
      if (els.length) {
        const startIndex = findLectureIndexByElement(els[0]);
        const endIndex = findLectureIndexByElement(els[els.length - 1]);
        if (startIndex !== -1 && endIndex !== -1) {
          return { type: 'concept', startIndex, endIndex, highlightElement: conceptBlock };
        }
      }
    }

    const conclusion = element.closest('#conclusion');
    if (conclusion) {
      const textPanel = conclusion.querySelector('.text-panel');
      if (textPanel) {
        const els = Array.from(textPanel.querySelectorAll('h2, p, li'));
        if (els.length) {
          const startIndex = findLectureIndexByElement(els[0]);
          const endIndex = findLectureIndexByElement(els[els.length - 1]);
          if (startIndex !== -1 && endIndex !== -1) {
            return { type: 'conclusion', startIndex, endIndex, highlightElement: textPanel };
          }
        }
      }
    }

    const step = element.closest('.step-text');
    if (step) {
      const scene = step.closest('.scroll-scene');
      const activeStep = scene ? scene.querySelector('.step-text.active') : step;
      const targetStep = activeStep || step;
      const stepIndex = Number(targetStep.dataset.step || 0);
      const els = Array.from(targetStep.children).filter(c => ['H2','H3','P','DIV','OL','UL','LI'].includes(c.tagName));
      if (els.length) {
        const startIndex = findLectureIndexByElement(els[0]);
        const endIndex = findLectureIndexByElement(els[els.length - 1]);
        if (startIndex !== -1 && endIndex !== -1) {
          return { type: 'step', scene, step: targetStep, stepIndex, startIndex, endIndex, highlightElement: targetStep };
        }
      }
    }

    if (element.classList.contains('quick-summary')) {
      const index = findLectureIndexByElement(element);
      if (index !== -1) return { type: 'summary', startIndex: index, endIndex: index, highlightElement: element };
    }

    const index = findLectureIndexByElement(element);
    if (index !== -1) return { type: 'single', startIndex: index, endIndex: index, highlightElement: element };

    return null;
  }

  async function speakCurrentParagraphOnly() {
    if (speakerMode) return;
    if (lectureMode) { pauseLectureMode(); } else { stopSpeech(); }
    ensureLectureItems();
    const currentItem = getCurrentReadableItem();
    if (!currentItem || !currentItem.element) return;
    const range = getSpeakerLectureRangeFromElement(currentItem.element);
    if (!range) return;

    speakerMode = true;
    manualReadEnabled = false;
    const runId = ++speakerRunId;

    currentLectureIndex = Math.min(Math.max(range.startIndex, 0), lectureItems.length);
    lectureInitialized = true;
    lecturePaused = true;

    let index = range.startIndex;
    let completed = true;

    while (speakerMode && speakerRunId === runId && index <= range.endIndex && index < lectureItems.length) {
      const item = lectureItems[index];
      if (!item || !item.text) { index++; continue; }
      currentLectureIndex = Math.min(Math.max(index, 0), lectureItems.length);
      await playLectureItem(item);
      if (!speakerMode || speakerRunId !== runId) { completed = false; break; }
      currentLectureIndex = Math.min(Math.max(index + 1, 0), lectureItems.length);
      index++;
    }

    if (completed && speakerMode && speakerRunId === runId && range.type === 'step') {
      await finishStepAnimation(range.scene, range.stepIndex, SPEAKER_STEP_FINISH_DURATION);
      if (!speakerMode || speakerRunId !== runId) completed = false;
    }

    if (speakerRunId !== runId) { speakerMode = false; return; }

    if (completed) {
      currentLectureIndex = Math.min(Math.max(findNextLectureIndexAfterSpeakerRange(range), 0), lectureItems.length);
    }

    speakerMode = false;
    setTimeout(() => { if (speakerRunId === runId) manualReadEnabled = true; }, 500);
    const btn = document.querySelector('[data-cmd="lecture-stop"], [data-cmd="scroll"]');
    if (btn) {
      btn.textContent = '▶';
      btn.dataset.cmd = 'scroll';
      btn.setAttribute('aria-label', '강의 모드 다시 재생');
    }
  }

  // 1. Navigation click
  navLinks.forEach((link) => {
    link.addEventListener("click", function (event) {
      event.preventDefault();
      const targetId = this.getAttribute("href").slice(1);
      const targetElement = document.getElementById(targetId);

      if (targetElement) {
        targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });

  // 2. Header shrink on scroll (window standard)
  window.addEventListener("scroll", function () {
    const currentScrollTop = window.scrollY || document.documentElement.scrollTop;
    if (currentScrollTop > lastScrollTop && currentScrollTop > 40) {
      header.classList.add("shrink");
    } else if (currentScrollTop < lastScrollTop) {
      header.classList.remove("shrink");
    }
    lastScrollTop = currentScrollTop;
  }, { passive: true });

  // 3. Simple fade-in IntersectionObserver (Only for Hero/Conclusion non-step elements)
  const observerOptions = {
    root: null,
    threshold: 0.1,
    rootMargin: "0px 0px -10% 0px"
  };

  const fadeObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
      } else {
        entry.target.classList.remove("visible");
      }
    });
  }, observerOptions);

  // Observe non-interactive simple documents
  document.querySelectorAll("#hero .hero-visual-card, #conclusion .summary-card").forEach((el) => {
    fadeObserver.observe(el);
  });

  // 4. Scroll Progress Engine
  function getSceneProgress(section) {
    const rect = section.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const totalScrollable = rect.height - viewportHeight;

    if (totalScrollable <= 0) {
      // Sticky is released in mobile layout
      const totalDist = rect.height + viewportHeight;
      const currentDist = viewportHeight - rect.top;
      let progress = currentDist / totalDist;
      return Math.max(0, Math.min(1, progress));
    }

    // Normal sticky desktop layout
    const scrolled = -rect.top;
    let progress = scrolled / totalScrollable;
    return Math.max(0, Math.min(1, progress));
  }

  // getStepState with clamp(0, 1) mapping and hold ratio
  function getStepState(progress, stepCount, options = {}) {
    const holdRatio = options.holdRatio ?? 0;
    const animationRatio = 1 - holdRatio;
    const clampedProgress = Math.min(Math.max(progress, 0), 1);
    const raw = clampedProgress * stepCount;
    const stepIndex = Math.min(stepCount - 1, Math.floor(raw));
    const localProgress = raw - stepIndex;
    const animatedProgress = Math.min(localProgress / animationRatio, 1);
    return {
      stepIndex,
      stepProgress: Math.min(Math.max(animatedProgress, 0), 1),
      rawStepProgress: localProgress
    };
  }

  // 5. Dynamic Step Text Switcher (with aria-hidden & Dynamic height setting)
  // Store height mapping to optimize reflow triggers
  const heightCache = new Map();

  function updateSceneText(section, stepIndex, rawStepProgress) {
    const stepCopy = section.querySelector(".step-copy");
    if (!stepCopy) return;

    const steps = stepCopy.querySelectorAll(".step-text");
    let activeText = null;

    steps.forEach((step, idx) => {
      if (idx === stepIndex) {
        if (!step.classList.contains("active")) {
          step.classList.add("active");
          step.setAttribute("aria-hidden", "false");
          // Reset child visibility on step transition
          Array.from(step.children).forEach(child => {
            child.classList.remove("text-visible");
          });
        }
        activeText = step;
      } else {
        if (step.classList.contains("active")) {
          step.classList.remove("active");
          step.setAttribute("aria-hidden", "true");
          // Clean up visibility when leaving step
          Array.from(step.children).forEach(child => {
            child.classList.remove("text-visible");
          });
        }
      }
    });

    if (activeText) {
      // Sequential reveal of children
      const revealables = Array.from(activeText.children).filter(child => {
        const tag = child.tagName;
        return tag === 'P' || tag === 'H2' || tag === 'H3' || tag === 'DIV' || tag === 'OL';
      });

      const revealProgress = mapProgress(rawStepProgress, 0, 0.45);
      const visibleCount = Math.max(1, Math.ceil(revealProgress * revealables.length));

      revealables.forEach((child, idx) => {
        if (idx < visibleCount) {
          child.classList.add("text-visible");
        } else {
          child.classList.remove("text-visible");
        }
      });

      // Utilize cache or query height on change
      const sectionId = section.id;
      const cacheKey = `${sectionId}-${stepIndex}-${window.innerWidth}`;
      
      if (heightCache.has(cacheKey)) {
        stepCopy.style.height = `${heightCache.get(cacheKey)}px`;
      } else {
        const height = activeText.offsetHeight;
        if (height > 0) {
          heightCache.set(cacheKey, height);
          stepCopy.style.height = `${height}px`;
        }
      }
    }
  }

  // updateSceneVisual: manages .visual-step active state and visual-stage height
  function updateSceneVisual(section, stepIndex) {
    const visualStage = section.querySelector(".visual-stage");
    if (!visualStage) return;

    const visualSteps = visualStage.querySelectorAll(".visual-step");
    let activeVisual = null;

    visualSteps.forEach((step) => {
      if (Number(step.dataset.step) === stepIndex) {
        if (!step.classList.contains("active")) {
          step.classList.add("active");
          step.setAttribute("aria-hidden", "false");
        }
        activeVisual = step;
      } else {
        if (step.classList.contains("active")) {
          step.classList.remove("active");
          step.setAttribute("aria-hidden", "true");
        }
      }
    });

    if (activeVisual) {
      const sectionId = section.id;
      const cacheKey = `${sectionId}-visual-${stepIndex}-${window.innerWidth}`;

      if (heightCache.has(cacheKey)) {
        visualStage.style.height = `${heightCache.get(cacheKey)}px`;
      } else {
        const height = activeVisual.offsetHeight;
        if (height > 0) {
          heightCache.set(cacheKey, height);
          visualStage.style.height = `${height}px`;
        }
      }
    }
  }

  // ResizeObserver to handle dynamically updating height on step-text and visual-step content size adjustments
  const stepResizeObserver = new ResizeObserver((entries) => {
    for (let entry of entries) {
      const el = entry.target;

      if (el.classList.contains("active") && el.classList.contains("step-text")) {
        const stepCopy = el.parentElement;
        if (stepCopy && stepCopy.classList.contains("step-copy")) {
          const height = el.offsetHeight;
          stepCopy.style.height = `${height}px`;

          const section = stepCopy.closest(".scroll-scene");
          if (section) {
            const stepIndex = parseInt(el.dataset.step, 10);
            const cacheKey = `${section.id}-${stepIndex}-${window.innerWidth}`;
            heightCache.set(cacheKey, height);
          }
        }
      }

      if (el.classList.contains("active") && el.classList.contains("visual-step")) {
        const visualStage = el.parentElement;
        if (visualStage && visualStage.classList.contains("visual-stage")) {
          const height = el.offsetHeight;
          visualStage.style.height = `${height}px`;

          const section = visualStage.closest(".scroll-scene");
          if (section) {
            const stepIndex = parseInt(el.dataset.step, 10);
            const cacheKey = `${section.id}-visual-${stepIndex}-${window.innerWidth}`;
            heightCache.set(cacheKey, height);
          }
        }
      }
    }
  });

  document.querySelectorAll(".step-text").forEach((text) => {
    stepResizeObserver.observe(text);
  });

  document.querySelectorAll(".visual-step").forEach((step) => {
    stepResizeObserver.observe(step);
  });

  // 6. Pre-render constructors
  const INTEGER_COUNT_ORDER = ["0", "1", "-1", "2", "-2", "3", "-3"];

  buildRationalGrid();
  initCountableStaticTags();
  initUncountableStaticTags();

  const setSizeSection = document.querySelector("#set-size");
  if (setSizeSection) {
    drawConnections(setSizeSection);
  }

  // Helper: Linear interpolation mapping
  function mapProgress(progress, start, end) {
    if (progress <= start) return 0;
    if (progress >= end) return 1;
    return (progress - start) / (end - start);
  }

  // --- Animations mapping with State Machine configuration ---

  // Section 1: Set Size
  function updateSetSizeScene(stepIndex, stepProgress, totalProgress) {
    const section = document.querySelector("#set-size");
    if (!section) return;

    const itemsA = section.querySelectorAll(".set-a .item");
    const itemsB = section.querySelectorAll(".set-b .item");
    const lines = section.querySelectorAll(".connection-line");
    const conclusion = section.querySelector(".set-conclusion");

    // Line connection thickness adjustment
    if (stepIndex >= 2) {
      lines.forEach(l => l.style.strokeWidth = "5");
    } else {
      lines.forEach(l => l.style.strokeWidth = "3");
    }

    // Step 0: Items appear (● 4, then ▲ 4)
    if (stepIndex === 0) {
      // Left elements (●)
      itemsA.forEach((item, idx) => {
        const start = 0.1 + idx * 0.15;
        const end = start + 0.15;
        const p = mapProgress(stepProgress, start, end);
        item.style.opacity = p;
        item.style.transform = `scale(${0.5 + 0.5 * p})`;
        if (p > 0) item.classList.add("show");
        else item.classList.remove("show");
      });
      // Right elements (▲)
      itemsB.forEach((item, idx) => {
        const start = 0.7 + idx * 0.15;
        const end = start + 0.15;
        const p = mapProgress(stepProgress, start, end);
        item.style.opacity = p;
        item.style.transform = `scale(${0.5 + 0.5 * p})`;
        item.textContent = "▲";
        if (p > 0) item.classList.add("show");
        else item.classList.remove("show");
      });
      // Clear next steps
      lines.forEach(l => {
        l.style.strokeDashoffset = 300;
        l.classList.remove("show");
      });
      conclusion.style.opacity = 0;
      conclusion.classList.remove("show");
    }
    // Step 1: Draw connection lines
    else if (stepIndex === 1) {
      // Force step 0 elements to complete state
      itemsA.forEach(item => {
        item.style.opacity = 1;
        item.style.transform = "scale(1)";
        item.classList.add("show");
      });
      itemsB.forEach(item => {
        item.style.opacity = 1;
        item.style.transform = "scale(1)";
        item.classList.add("show");
        item.textContent = "▲";
      });

      // Connections progressive drawing
      lines.forEach((line, idx) => {
        const start = 0.1 + idx * 0.2;
        const end = start + 0.2;
        const p = mapProgress(stepProgress, start, end);
        line.style.strokeDashoffset = 300 - (300 * p);
        if (p > 0) line.classList.add("show");
        else line.classList.remove("show");
      });

      conclusion.style.opacity = 0;
      conclusion.classList.remove("show");
    }
    // Step 2: Swap ▲ to numbers (1, 2, 3, 4)
    else if (stepIndex === 2) {
      // Force previous states
      itemsA.forEach(item => {
        item.style.opacity = 1;
        item.style.transform = "scale(1)";
        item.classList.add("show");
      });
      lines.forEach(line => {
        line.style.strokeDashoffset = 0;
        line.classList.add("show");
      });

      const numbers = ["1", "2", "3", "4"];
      itemsB.forEach((item, idx) => {
        const start = 0.1 + idx * 0.2;
        const end = start + 0.2;
        const p = mapProgress(stepProgress, start, end);
        
        item.style.opacity = 1;
        item.classList.add("show");

        if (p >= 0.5) {
          item.textContent = numbers[idx];
        } else {
          item.textContent = "▲";
        }

        // Add bounce scale
        let scale = 1.0;
        if (p > 0 && p < 1.0) {
          scale = 1.0 + 0.25 * Math.sin(p * Math.PI);
        }
        item.style.transform = `scale(${scale})`;
      });

      conclusion.style.opacity = 0;
      conclusion.classList.remove("show");
    }
    // Step 3: Display conclusion text
    else if (stepIndex === 3) {
      // Force all previous states
      itemsA.forEach(item => {
        item.style.opacity = 1;
        item.style.transform = "scale(1)";
        item.classList.add("show");
      });
      itemsB.forEach((item, idx) => {
        item.style.opacity = 1;
        item.style.transform = "scale(1)";
        item.classList.add("show");
        item.textContent = (idx + 1).toString();
      });
      lines.forEach(line => {
        line.style.strokeDashoffset = 0;
        line.classList.add("show");
      });

      conclusion.style.opacity = 0;
      conclusion.classList.remove("show");
    }
    // Step 4: Animation fully shown, no separate conclusion diagram
    else if (stepIndex === 4) {
      itemsA.forEach(item => {
        item.style.opacity = 1;
        item.style.transform = "scale(1)";
        item.classList.add("show");
      });
      itemsB.forEach((item, idx) => {
        item.style.opacity = 1;
        item.style.transform = "scale(1)";
        item.classList.add("show");
        item.textContent = (idx + 1).toString();
      });
      lines.forEach(line => {
        line.style.strokeDashoffset = 0;
        line.classList.add("show");
      });
      conclusion.innerHTML = "";
      conclusion.style.opacity = 0;
      conclusion.classList.remove("show");
      conclusion.classList.add("is-empty");
    }
  }

  // Section 2: Countable
  function updateIntegerOrderPath(section) {
    const axis = section.querySelector(".integers .number-line-axis");
    const svg = section.querySelector(".integer-order-svg");
    const path = section.querySelector(".integer-order-path");
    if (!axis || !svg || !path) return null;

    const width = axis.offsetWidth;
    const height = axis.offsetHeight;
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    const axisRect = axis.getBoundingClientRect();
    const points = INTEGER_COUNT_ORDER.map((val) => {
      const point = section.querySelector(`.integers .point[data-value="${val}"]`);
      if (!point) return null;
      const rect = point.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2 - axisRect.left,
        y: rect.top + 6 - axisRect.top
      };
    }).filter(Boolean);

    const pathD = points.reduce((acc, point, idx) => {
      const cmd = idx === 0 ? "M" : "L";
      return `${acc} ${cmd} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
    }, "").trim();

    path.setAttribute("d", pathD);
    const length = path.getTotalLength();
    return { path, length };
  }

  function setIntegerOrderPathStroke(path, length, drawProgress, opacity) {
    const clampedDraw = Math.min(Math.max(drawProgress, 0), 1);
    const clampedOpacity = Math.min(Math.max(opacity, 0), 1);
    path.style.opacity = String(clampedOpacity);
    path.setAttribute("stroke-dasharray", String(length));
    path.setAttribute("stroke-dashoffset", String(length * (1 - clampedDraw)));
  }

  function updateCountableScene(stepIndex, stepProgress, totalProgress) {
    const section = document.querySelector("#countable");
    if (!section) return;

    const activeVisual = section.querySelector(".visual-stage .visual-step.active");
    const naturalPoints = section.querySelectorAll(".naturals .point");
    const integerPoints = section.querySelectorAll(".integers .point");
    const rationalPoints = section.querySelectorAll(".rational-point");
    const rationalPath = (activeVisual && activeVisual.querySelector(".rational-path")) || section.querySelector(".rational-path");
    const conclusion = (activeVisual && activeVisual.querySelector(".countable-conclusion")) || section.querySelector(".countable-conclusion");

    function resetIntegerOrderPath() {
      const path = section.querySelector(".integer-order-path");
      if (!path) return;
      const length = path.getTotalLength() || 0;
      setIntegerOrderPathStroke(path, length, 0, 0);
    }

    function resetRationalVisual() {
      rationalPoints.forEach((point) => {
        point.classList.remove("active");
        const tag = point.querySelector(".grid-order");
        if (tag) tag.style.opacity = "0";
      });
      if (rationalPath) {
        const length = rationalPath.getTotalLength();
        rationalPath.setAttribute("stroke-dasharray", String(length));
        rationalPath.setAttribute("stroke-dashoffset", String(length));
        rationalPath.style.opacity = "0";
      }
    }

    // visual-step switching is handled by updateSceneVisual() called from updateAllScenes

    // Step 0: Cell Countable intro
    if (stepIndex === 0) {
      // Initial states
      naturalPoints.forEach(p => {
        p.classList.remove("active");
        const tag = p.querySelector(".tag");
        if (tag) tag.style.opacity = "0";
      });
      integerPoints.forEach(p => {
        p.classList.remove("active");
        const tag = p.querySelector(".tag");
        if (tag) tag.style.opacity = "0";
      });
      resetRationalVisual();
      resetIntegerOrderPath();
      conclusion.style.opacity = 0;
      conclusion.classList.remove("show");
    }
    // Step 1: Natural number line active points
    else if (stepIndex === 1) {
      naturalPoints.forEach((point, idx) => {
        const start = 0.02 + idx * 0.19;
        const end = start + 0.16;
        const p = mapProgress(stepProgress, start, end);
        const tag = point.querySelector(".tag");

        if (p >= 0.5) {
          point.classList.add("active");
          if (tag) tag.style.opacity = "1";
        } else {
          point.classList.remove("active");
          if (tag) tag.style.opacity = "0";
        }
      });

      // Clear subsequent steps
      integerPoints.forEach(p => {
        p.classList.remove("active");
        const tag = p.querySelector(".tag");
        if (tag) tag.style.opacity = "0";
      });
      resetRationalVisual();
      resetIntegerOrderPath();
      conclusion.style.opacity = 0;
      conclusion.classList.remove("show");
    }
    // Step 2: Integer line active points (0, 1, -1, 2, -2, 3, -3)
    else if (stepIndex === 2) {
      // Force step 1 completed state
      naturalPoints.forEach(point => {
        point.classList.add("active");
        const tag = point.querySelector(".tag");
        if (tag) tag.style.opacity = "1";
      });

      const integerOrder = INTEGER_COUNT_ORDER;
      integerOrder.forEach((val, idx) => {
        const start = 0.02 + idx * 0.13;
        const end = start + 0.1;
        const p = mapProgress(stepProgress, start, end);
        const point = section.querySelector(`.integers .point[data-value="${val}"]`);
        if (!point) return;

        const tag = point.querySelector(".tag");
        if (p >= 0.5) {
          point.classList.add("active");
          if (tag) tag.style.opacity = "1";
        } else {
          point.classList.remove("active");
          if (tag) tag.style.opacity = "0";
        }
      });

      // Clear subsequent steps
      resetRationalVisual();
      conclusion.style.opacity = 0;
      conclusion.classList.remove("show");

      const orderPathData = updateIntegerOrderPath(section);
      if (orderPathData) {
        const pathProgress = mapProgress(stepProgress, 0.15, 0.95);
        setIntegerOrderPathStroke(orderPathData.path, orderPathData.length, pathProgress, pathProgress > 0 ? 1 : 0);
      }
    }
    // Step 3: Rational plane diagonal path + countable conclusion
    else if (stepIndex === 3) {
      // Force all previous completed states
      naturalPoints.forEach(point => {
        point.classList.add("active");
        const tag = point.querySelector(".tag");
        if (tag) tag.style.opacity = "1";
      });
      integerPoints.forEach(point => {
        point.classList.add("active");
        const tag = point.querySelector(".tag");
        if (tag) tag.style.opacity = "1";
      });

      const orderPathData = updateIntegerOrderPath(section);
      if (orderPathData) {
        setIntegerOrderPathStroke(orderPathData.path, orderPathData.length, 1, 1);
      }

      const order = diagonalOrder(5);

      // path draw phase (0.2 to 0.95 stepProgress) - slower start and longer duration
      const gridProgress = mapProgress(stepProgress, 0.2, 0.95);
      if (rationalPath) {
        const pathLength = rationalPath.getTotalLength();
        rationalPath.setAttribute("stroke-dasharray", String(pathLength));
        rationalPath.setAttribute("stroke-dashoffset", String(pathLength * (1 - gridProgress)));
        rationalPath.style.opacity = gridProgress > 0 ? "1" : "0";
      }

      order.forEach((coord, idx) => {
        const [row, col] = coord;
        const point = section.querySelector(`.rational-point[data-row="${row}"][data-col="${col}"]`);
        if (!point) return;

        const start = idx * 0.035;
        const end = start + 0.03;
        const p = mapProgress(gridProgress, start, end);
        const tag = point.querySelector(".grid-order");

        if (p >= 0.5) {
          point.classList.add("active");
          if (tag) tag.style.opacity = "1";
        } else {
          point.classList.remove("active");
          if (tag) tag.style.opacity = "0";
        }
      });

      conclusion.style.opacity = 0;
      conclusion.classList.remove("show");
    }
    // Step 4: Show countable conclusion
    else if (stepIndex === 4) {
      // Force all previous completed states
      naturalPoints.forEach(point => {
        point.classList.add("active");
        const tag = point.querySelector(".tag");
        if (tag) tag.style.opacity = "1";
      });
      integerPoints.forEach(point => {
        point.classList.add("active");
        const tag = point.querySelector(".tag");
        if (tag) tag.style.opacity = "1";
      });

      const orderPathData = updateIntegerOrderPath(section);
      if (orderPathData) {
        setIntegerOrderPathStroke(orderPathData.path, orderPathData.length, 1, 1);
      }

      const order = diagonalOrder(5);

      // Force rational path completed
      if (rationalPath) {
        const pathLength = rationalPath.getTotalLength();
        rationalPath.setAttribute("stroke-dasharray", String(pathLength));
        rationalPath.setAttribute("stroke-dashoffset", "0");
        rationalPath.style.opacity = "1";
      }

      order.forEach((coord, idx) => {
        const [row, col] = coord;
        const point = section.querySelector(`.rational-point[data-row="${row}"][data-col="${col}"]`);
        if (!point) return;
        point.classList.add("active");
        const tag = point.querySelector(".grid-order");
        if (tag) tag.style.opacity = "1";
      });

      // conclusion display phase
      const conclusionProgress = mapProgress(stepProgress, 0.05, 0.95);
      conclusion.style.opacity = conclusionProgress;
      conclusion.style.transform = `translateY(${20 - (20 * conclusionProgress)}px)`;
      if (conclusionProgress > 0) {
        conclusion.classList.add("show");
      } else {
        conclusion.classList.remove("show");
      }
    }
  }

  // Section 3: Uncountable
  function ensureDiagonalGuideSvg(realList) {
    let svg = realList.querySelector(".diagonal-guide-svg");
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "diagonal-guide-svg");
      svg.setAttribute("aria-hidden", "true");

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", "diagonal-guide-path");
      svg.appendChild(path);
      realList.appendChild(svg);
    }
    return {
      svg,
      path: svg.querySelector(".diagonal-guide-path")
    };
  }

  function updateDiagonalGuidePath(realList) {
    const { svg, path } = ensureDiagonalGuideSvg(realList);
    const diagDigits = realList.querySelectorAll(".digit.diag");
    if (!diagDigits.length) return null;

    const listRect = realList.getBoundingClientRect();
    const width = Math.max(realList.scrollWidth, realList.offsetWidth);
    const height = realList.offsetHeight;

    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.style.width = `${width}px`;
    svg.style.height = `${height}px`;

    const points = [...diagDigits].map((digit) => {
      const rect = digit.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2 - listRect.left + realList.scrollLeft,
        y: rect.top + rect.height / 2 - listRect.top + realList.scrollTop
      };
    });

    const pathD = points.reduce((acc, point, idx) => {
      const cmd = idx === 0 ? "M" : "L";
      return `${acc} ${cmd} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
    }, "").trim();

    path.setAttribute("d", pathD);
    const length = path.getTotalLength();
    path.dataset.length = String(length);
    return { path, length };
  }

  function setDiagonalGuideStroke(path, length, drawProgress, opacity) {
    const clampedDraw = Math.min(Math.max(drawProgress, 0), 1);
    const clampedOpacity = Math.min(Math.max(opacity, 0), 1);
    path.style.opacity = String(clampedOpacity);
    path.setAttribute("stroke-dasharray", String(length));
    path.setAttribute("stroke-dashoffset", String(length * (1 - clampedDraw)));
  }

  function ensureConstructedRow(realList) {
    const constructedRow = realList.querySelector(".constructed-number-row");
    return constructedRow;
  }

  function clearRowComparisons(section) {
    const rows = section.querySelectorAll(".real-row");
    rows.forEach(row => {
      row.classList.remove("comparing", "compared");
      const digits = row.querySelectorAll(".digit");
      digits.forEach(d => d.classList.remove("diff-active"));
    });

    const constructedDigits = section.querySelectorAll(".constructed-digit");
    constructedDigits.forEach(d => d.classList.remove("diff-active"));

    section.classList.remove("comparison-mode");
  }

  function highlightComparison(section, rowIndex, newDigits) {
    const rows = section.querySelectorAll(".real-row");
    const constructedRow = section.querySelector(".constructed-number-row");
    if (!constructedRow) return;

    // Clear previous highlights
    rows.forEach(row => {
      row.classList.remove("comparing", "compared");
      const digits = row.querySelectorAll(".digit");
      digits.forEach(d => d.classList.remove("diff-active"));
    });

    const constructedDigits = section.querySelectorAll(".constructed-digit");
    constructedDigits.forEach(d => d.classList.remove("diff-active"));

    // Mark compared rows (before current)
    for (let i = 0; i < rowIndex; i++) {
      if (rows[i]) rows[i].classList.add("compared");
    }

    // Highlight current comparison row
    if (rows[rowIndex]) {
      rows[rowIndex].classList.add("comparing");
      const currentRowDigits = rows[rowIndex].querySelectorAll(".digit");
      if (currentRowDigits[rowIndex]) {
        currentRowDigits[rowIndex].classList.add("diff-active");
      }
    }

    // Highlight corresponding constructed digit
    const targetConstructedDigit = constructedRow.querySelector(`.constructed-digit[data-index="${rowIndex}"]`);
    if (targetConstructedDigit) {
      targetConstructedDigit.classList.add("diff-active");
    }
  }

  function updateUncountableScene(stepIndex, stepProgress, totalProgress) {
    const section = document.querySelector("#uncountable");
    if (!section) return;

    const realList = section.querySelector(".real-list");
    const diagDigits = section.querySelectorAll(".digit.diag");
    const generatedNumber = document.getElementById("generatedNumber");
    const comparisonText = document.getElementById("comparisonText");
    const comparisonVisual = document.getElementById("comparisonVisual");
    const conclusion = document.getElementById("uncountableConclusion");
    const conclusionLines = conclusion.querySelectorAll(".conclusion-line");

    const originalVals = [3, 1, 5, 1, 2];
    const newVals = originalVals.map(v => v === 9 ? 0 : v + 1);
    const fullGeneratedHtml = `0.${newVals.map(v => `<span class="generated-digit">${v}</span>`).join("")}...`;

    // Helper: lock diag digits as selected
    function lockDiag() { diagDigits.forEach(d => d.classList.add("selected")); }
    // Helper: clear comparison panels
    function clearComparison() {
      comparisonText.innerHTML = "";
      comparisonVisual.innerHTML = "";
    }
    // Helper: hide conclusion lines
    function hideConclusion() { conclusionLines.forEach(l => l.classList.remove("show")); }

    // Ensure constructed row exists
    const constructedRow = ensureConstructedRow(realList);

    // ── Step 0: 실수 목록 등장 (대각선 없음) ──────────────────────────
    if (stepIndex === 0) {
      diagDigits.forEach(d => d.classList.remove("selected"));
      generatedNumber.innerHTML = "0.";
      clearComparison();
      hideConclusion();
      clearRowComparisons(section);
      constructedRow.classList.remove("visible");
    }
    // ── Step 1: 대각선 숫자 선택 하이라이트 ──────────────────────────
    else if (stepIndex === 1) {
      const sProgress = mapProgress(stepProgress, 0.1, 0.95);
      diagDigits.forEach((digit, idx) => {
        const start = idx * 0.18;
        const end = start + 0.16;
        const p = mapProgress(sProgress, start, end);
        if (p >= 0.5) digit.classList.add("selected");
        else digit.classList.remove("selected");
      });
      generatedNumber.innerHTML = "0.";
      clearComparison();
      hideConclusion();
      clearRowComparisons(section);
      constructedRow.classList.remove("visible");
    }
    // ── Step 2: 변경 규칙 — constructed row에 원래 대각선 숫자 표시 ─────────
    else if (stepIndex === 2) {
      lockDiag();
      generatedNumber.innerHTML = "0.";
      clearComparison();
      hideConclusion();
      clearRowComparisons(section);

      // Show constructed row with original diagonal values
      constructedRow.classList.add("visible");
      const constructedDigits = constructedRow.querySelectorAll(".constructed-digit");
      constructedDigits.forEach((digit, idx) => {
        digit.textContent = originalVals[idx];
      });
    }
    // ── Step 3: 새 수 생성 — constructed row 숫자들 +1로 변경 ───────────
    else if (stepIndex === 3) {
      lockDiag();
      const stepRange = 0.18;
      let html = "0.";
      for (let i = 0; i < 5; i++) {
        if (stepProgress >= i * stepRange) {
          html += `<span class="generated-digit">${newVals[i]}</span>`;
        }
      }
      if (stepProgress >= 0.95) html += "...";
      generatedNumber.innerHTML = html;
      clearComparison();
      hideConclusion();
      clearRowComparisons(section);

      // Keep constructed row visible, animate digit changes
      constructedRow.classList.add("visible");
      const constructedDigits = constructedRow.querySelectorAll(".constructed-digit");
      constructedDigits.forEach((digit, idx) => {
        const changeStart = 0.05 + idx * 0.18;
        const changeEnd = changeStart + 0.14;
        const changeProgress = mapProgress(stepProgress, changeStart, changeEnd);
        if (changeProgress >= 0.5) {
          digit.textContent = newVals[idx];
        } else {
          digit.textContent = originalVals[idx];
        }
      });
    }
    // ── Step 4: 1번 수와 비교 ─────────────────────────────────────────
    else if (stepIndex === 4) {
      lockDiag();
      generatedNumber.innerHTML = fullGeneratedHtml;
      clearComparison();
      hideConclusion();

      // Enable comparison mode
      section.classList.add("comparison-mode");
      constructedRow.classList.add("visible");

      // Ensure constructed row shows final values
      const constructedDigits = constructedRow.querySelectorAll(".constructed-digit");
      constructedDigits.forEach((digit, idx) => {
        digit.textContent = newVals[idx];
      });

      highlightComparison(section, 0, newVals);
      comparisonText.innerHTML = `<strong>1번 수와는 1번째 자리에서 다르다</strong>`;
    }
    // ── Step 5: 2번 수와 비교 ─────────────────────────────────────────
    else if (stepIndex === 5) {
      lockDiag();
      generatedNumber.innerHTML = fullGeneratedHtml;
      clearComparison();
      hideConclusion();

      section.classList.add("comparison-mode");
      constructedRow.classList.add("visible");

      highlightComparison(section, 1, newVals);
      comparisonText.innerHTML = `<strong>2번 수와는 2번째 자리에서 다르다</strong>`;
    }
    // ── Step 6: 모든 행과 다름 (3번→4번→5번 순차 비교) ──────────────
    else if (stepIndex === 6) {
      lockDiag();
      generatedNumber.innerHTML = fullGeneratedHtml;
      clearComparison();
      hideConclusion();

      section.classList.add("comparison-mode");
      constructedRow.classList.add("visible");

      // Map stepProgress to row index (2-4 for step 6)
      const rowProgress = stepProgress * 3;
      const currentRowIndex = Math.min(4, Math.max(2, Math.floor(rowProgress + 2)));

      highlightComparison(section, currentRowIndex, newVals);

      const rowLabels = ["3번", "4번", "5번"];
      const currentLabel = rowLabels[currentRowIndex - 2] || "마지막";
      comparisonText.innerHTML = `<strong>${currentLabel} 수와는 ${currentRowIndex + 1}번째 자리에서 다르다</strong>`;
    }
    // ── Step 7: 목록 밖의 수 존재 ────────────────────────────────────
    else if (stepIndex === 7) {
      lockDiag();
      generatedNumber.innerHTML = fullGeneratedHtml;
      clearComparison();
      constructedRow.classList.add("visible");

      // Keep all rows marked as compared
      const rows = section.querySelectorAll(".real-row");
      rows.forEach(row => row.classList.add("compared"));
      rows.forEach(row => row.classList.remove("comparing"));

      const constructedDigits = section.querySelectorAll(".constructed-digit");
      constructedDigits.forEach(d => d.classList.remove("diff-active"));

      conclusionLines.forEach((line, idx) => {
        if (idx < 2) {
          const start = 0.05 + idx * 0.3;
          const end = start + 0.25;
          const p = mapProgress(stepProgress, start, end);
          if (p >= 0.5) line.classList.add("show");
          else line.classList.remove("show");
        } else {
          line.classList.remove("show");
        }
      });
    }
    // ── Step 8: 실수는 셀 수 없음 — 전체 결론 ──────────────────────
    else if (stepIndex === 8) {
      lockDiag();
      generatedNumber.innerHTML = fullGeneratedHtml;
      clearComparison();
      constructedRow.classList.add("visible");

      // Keep comparison state
      const rows = section.querySelectorAll(".real-row");
      rows.forEach(row => row.classList.add("compared"));
      rows.forEach(row => row.classList.remove("comparing"));

      const constructedDigits = section.querySelectorAll(".constructed-digit");
      constructedDigits.forEach(d => d.classList.remove("diff-active"));

      conclusionLines.forEach((line, idx) => {
        const start = 0.02 + idx * 0.2;
        const end = start + 0.18;
        const p = mapProgress(stepProgress, start, end);
        if (p >= 0.5) line.classList.add("show");
        else line.classList.remove("show");
      });
    }

    // 대각선 SVG path 제어 (step 0: 숨김, step 1: 그리기, step 2+: 완성)
    if (realList) {
      const guideData = updateDiagonalGuidePath(realList);
      if (guideData) {
        const { path, length } = guideData;
        if (stepIndex === 0) {
          setDiagonalGuideStroke(path, length, 0, 0);
        } else if (stepIndex === 1) {
          const gProgress = mapProgress(stepProgress, 0.0, 0.25);
          setDiagonalGuideStroke(path, length, gProgress, gProgress);
        } else {
          setDiagonalGuideStroke(path, length, 1, 1);
        }
      }
    }
  }

  // 7. Global Update Loop
  function updateAllScenes() {
    const scene1 = document.querySelector("#set-size");
    const scene2 = document.querySelector("#countable");
    const scene3 = document.querySelector("#uncountable");

    if (scene1) {
      const stepsCount = parseInt(scene1.dataset.steps, 10) || 4;
      const progress = getSceneProgress(scene1);
      const { stepIndex, rawStepProgress } = getStepState(progress, stepsCount);
      const animationProgress = mapProgress(rawStepProgress, 0.45, 0.80);
      updateSceneText(scene1, stepIndex, rawStepProgress);
      updateSetSizeScene(stepIndex, animationProgress, progress);
    }
    if (scene2) {
      const stepsCount = parseInt(scene2.dataset.steps, 10) || 4;
      const progress = getSceneProgress(scene2);
      const { stepIndex, rawStepProgress } = getStepState(progress, stepsCount);
      const animationProgress = mapProgress(rawStepProgress, 0.45, 0.80);
      updateSceneText(scene2, stepIndex, rawStepProgress);
      updateSceneVisual(scene2, stepIndex);
      updateCountableScene(stepIndex, animationProgress, progress);
    }
    if (scene3) {
      const stepsCount = parseInt(scene3.dataset.steps, 10) || 9;
      const progress = getSceneProgress(scene3);
      const { stepIndex, rawStepProgress } = getStepState(progress, stepsCount);
      const animationProgress = mapProgress(rawStepProgress, 0.45, 0.80);
      updateSceneText(scene3, stepIndex, rawStepProgress);
      updateUncountableScene(stepIndex, animationProgress, progress);
    }
  }

  // 8. Event Bindings
  let ticking = false;
  function onScroll() {
    if (!ticking) {
      window.requestAnimationFrame(() => {
        updateAllScenes();
        ticking = false;
      });
      ticking = true;
    }
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", () => {
    // Clear height cache on resize to fetch correct heights
    heightCache.clear();
    
    if (setSizeSection) {
      drawConnections(setSizeSection);
    }
    updateAllScenes();
  });

  // Initial trigger to draw the current scroll state
  updateAllScenes();
  setTimeout(() => {
    if (setSizeSection) {
      drawConnections(setSizeSection);
    }
    updateAllScenes();
  }, 100);

  // --- Helpers for pre-rendered elements ---

  // Connection line drawer (Set Size SVG)
  function drawConnections(section) {
    const svg = section.querySelector(".connections");
    const leftItems = section.querySelectorAll(".set-a .item");
    const rightItems = section.querySelectorAll(".set-b .item");

    if (!svg) return [];
    svg.innerHTML = "";

    const svgRect = svg.getBoundingClientRect();

    leftItems.forEach((left, index) => {
      const right = rightItems[index];
      if (!right) return;

      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();

      const x1 = (leftRect.right - svgRect.left);
      const y1 = (leftRect.top + leftRect.height / 2 - svgRect.top);
      const x2 = (rightRect.left - svgRect.left);
      const y2 = (rightRect.top + rightRect.height / 2 - svgRect.top);

      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", x1);
      line.setAttribute("y1", y1);
      line.setAttribute("x2", x2);
      line.setAttribute("y2", y2);
      line.classList.add("connection-line");
      svg.appendChild(line);
    });

    return svg.querySelectorAll(".connection-line");
  }

  // Countable Set Grid Constructor
  function rationalPlaneCoords(q, p, size, cell, pad) {
    return {
      x: pad.l + q * cell,
      y: pad.t + (size - p) * cell
    };
  }

  function buildRationalGridPath(section) {
    const paths = section.querySelectorAll(".rational-path");
    if (!paths.length) return 0;

    const order = diagonalOrder(5);
    const points = order.map(([row, col]) => {
      const point = section.querySelector(`.rational-point[data-row="${row}"][data-col="${col}"]`);
      if (!point) return null;
      const x = Number(point.dataset.x);
      const y = Number(point.dataset.y);
      if (Number.isNaN(x) || Number.isNaN(y)) return null;
      return { x, y };
    }).filter(Boolean);

    const pathD = points.reduce((acc, point, idx) => {
      const cmd = idx === 0 ? "M" : "L";
      return `${acc} ${cmd} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
    }, "").trim();

    let length = 0;
    paths.forEach(path => {
      path.setAttribute("d", pathD);
      if (length === 0) length = path.getTotalLength();
    });
    return length;
  }

  function buildRationalGrid() {
    const containers = document.querySelectorAll(".rational-grid");
    if (!containers.length) return;

    containers.forEach(container => {
      const size = 5;
      const cell = 56;
      const pad = { l: 52, r: 24, t: 32, b: 48 };
      const width = pad.l + size * cell + pad.r;
      const height = pad.t + size * cell + pad.b;
      const originX = pad.l;
      const originY = pad.t + size * cell;

      let gridLines = "";
      for (let i = 0; i <= size; i++) {
        const x = pad.l + i * cell;
        const y = pad.t + i * cell;
        gridLines += `<line class="rational-grid-line" x1="${x}" y1="${pad.t}" x2="${x}" y2="${originY}" />`;
        gridLines += `<line class="rational-grid-line" x1="${originX}" y1="${y}" x2="${pad.l + size * cell}" y2="${y}" />`;
      }

      let qTicks = "";
      for (let q = 1; q <= size; q++) {
        const x = pad.l + q * cell;
        qTicks += `<text class="rational-axis-tick" x="${x}" y="${originY + 22}" text-anchor="middle">${q}</text>`;
      }

      let pTicks = "";
      for (let p = 1; p <= size; p++) {
        const y = pad.t + (size - p) * cell;
        pTicks += `<text class="rational-axis-tick" x="${originX - 14}" y="${y + 4}" text-anchor="end">${p}</text>`;
      }

      let pointsMarkup = "";
      for (let p = 1; p <= size; p++) {
        for (let q = 1; q <= size; q++) {
          const { x, y } = rationalPlaneCoords(q, p, size, cell, pad);
          pointsMarkup += `
            <g class="rational-point" data-row="${p}" data-col="${q}" data-x="${x}" data-y="${y}">
              <circle class="rational-point-dot" cx="${x}" cy="${y}" r="6" />
              <text class="rational-point-label" x="${x}" y="${y - 12}" text-anchor="middle">${p}/${q}</text>
              <text class="rational-point-order grid-order" x="${x}" y="${y + 22}" text-anchor="middle"></text>
            </g>`;
        }
      }

      container.innerHTML = `
        <div class="rational-plane-viewport">
          <svg class="rational-plane-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
            ${gridLines}
            <line class="rational-axis rational-axis-q" x1="${originX}" y1="${originY}" x2="${pad.l + size * cell + 12}" y2="${originY}" />
            <line class="rational-axis rational-axis-p" x1="${originX}" y1="${originY}" x2="${originX}" y2="${pad.t - 8}" />
            <text class="rational-axis-name" x="${pad.l + size * cell + 16}" y="${originY + 5}">q</text>
            <text class="rational-axis-name" x="${originX - 6}" y="${pad.t - 12}" text-anchor="end">p</text>
            ${qTicks}
            ${pTicks}
            <path class="rational-path" fill="none" stroke="#ff6b35" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
            ${pointsMarkup}
          </svg>
        </div>
      `;

      const section = container.closest("#countable");
      if (section) {
        const length = buildRationalGridPath(section);
        const path = section.querySelector(".rational-path");
        if (path && length > 0) {
          path.setAttribute("stroke-dasharray", String(length));
          path.setAttribute("stroke-dashoffset", String(length));
          path.style.opacity = "0";
        }
      }
    });
  }

  function diagonalOrder(size = 5) {
    const result = [];
    for (let sum = 2; sum <= size * 2; sum++) {
      for (let row = 1; row <= size; row++) {
        const col = sum - row;
        if (col >= 1 && col <= size) {
          result.push([row, col]);
        }
      }
    }
    return result;
  }

  // Countable Set Tag pre-constructor
  function initCountableStaticTags() {
    // 1. Naturals tags
    const circled = ["①", "②", "③", "④", "⑤"];
    const naturalPoints = document.querySelectorAll(".naturals .point");
    naturalPoints.forEach((point, idx) => {
      const tag = point.querySelector(".tag");
      if (tag) {
        tag.textContent = circled[idx];
        tag.style.opacity = "0";
        tag.style.transition = "opacity 0.2s ease";
      }
    });

    // 2. Integers tags (0, 1, -1, 2, -2, 3, -3)
    INTEGER_COUNT_ORDER.forEach((val, idx) => {
      const point = document.querySelector(`.integers .point[data-value="${val}"]`);
      if (!point) return;
      
      const existing = point.querySelector(".tag");
      if (existing) existing.remove();

      const tag = document.createElement("div");
      tag.className = "tag";
      tag.textContent = idx + 1;
      tag.style.opacity = "0";
      tag.style.transition = "opacity 0.2s ease";
      point.appendChild(tag);
    });

    // 3. Rationals plane order labels
    const order = diagonalOrder(5);
    order.forEach((coord, idx) => {
      const [row, col] = coord;
      const orderEls = document.querySelectorAll(`.rational-point[data-row="${row}"][data-col="${col}"] .grid-order`);
      orderEls.forEach(orderEl => {
        orderEl.textContent = idx + 1;
        orderEl.style.opacity = "0";
        orderEl.style.transition = "opacity 0.2s ease";
      });
    });
  }

  // Uncountable static conclusion pre-populator
  function initUncountableStaticTags() {
    const conclusion = document.getElementById("uncountableConclusion");
    if (!conclusion) return;

    conclusion.innerHTML = "";
    conclusion.classList.add("is-empty");
  }

  // ── 9. Lecture mode & control panel ──────────────────────────
  const ctrlPanel = document.getElementById('ctrlPanel');
  if (ctrlPanel) {
    ctrlPanel.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cmd]');
      if (!btn) return;
      switch (btn.dataset.cmd) {
        case 'scroll':
          btn.textContent = '⏸';
          btn.dataset.cmd = 'lecture-stop';
          btn.setAttribute('aria-label', '강의 모드 일시정지');
          startLectureMode();
          break;
        case 'lecture-stop':
          pauseLectureMode();
          break;
        case 'speak':
          speakCurrentParagraphOnly();
          break;
        case 'reset':
          resetLectureMode();
          stopSpeech();
          clearTtsHighlight();
          break;
      }
    });
  }
});
