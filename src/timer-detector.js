(() => {
  const DP = (window.DP = window.DP || {});

  // ───────── 설정값 ─────────
  const WAIT_TIME = 2000; // 2초
  const ALLOWED_GAP = 3; // 허용 오차 3초
  const GOOD_WORDS = ["할인", "종료", "남은", "마감", "특가", "까지", "한정"];
  const BAD_WORDS = ["영업", "운영", "고객센터", "평일", "주말", "오전", "오후"];
  const LOAD_ID = String(performance.timeOrigin);

  // ───────── 1. 글자 → 초 ─────────
  function toSeconds(text) {
    text = text.replace(/\s+/g, " ").trim();

    let m = text.match(/^(?:.*?\D)?(\d{1,2}):(\d{2}):(\d{2})(?!\d)/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);

    m = text.match(/^(?:.*?\D)?(\d{1,2}):(\d{2})(?![\d:])/);
    if (m) return Number(m[1]) * 60 + Number(m[2]);

    m = text.match(/(?:(\d+)\s*분)?\s*(?:(\d+)\s*초)?/);
    if (m && (m[1] || m[2])) return Number(m[1] || 0) * 60 + Number(m[2] || 0);

    return null;
  }

  function toText(sec) {
    sec = Math.max(0, Math.round(sec));
    const mm = String(Math.floor(sec / 60)).padStart(2, "0");
    const ss = String(sec % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }

  // ───────── 2. 페이지에서 타이머 후보 찾기 ─────────
  function findTimers() {
    const candidates = [];
    for (const el of document.querySelectorAll("span, div, p, b, strong, time")) {
      if (el.children.length > 0) continue; // 자식이 있는 바깥 요소는 건너뜀 (중복 방지)

      const text = el.textContent.trim();
      if (text.length === 0 || text.length > 40) continue;

      const seconds = toSeconds(text);
      if (seconds === null) continue;

      const around = el.parentElement ? el.parentElement.textContent : text;
      const hasGood = GOOD_WORDS.some((w) => around.includes(w));
      const hasBad = BAD_WORDS.some((w) => around.includes(w));
      if (!hasGood || hasBad) continue;

      candidates.push({ el, seconds, around: around.trim().slice(0, 60), selector: getSelector(el) });
    }
    return candidates;
  }

  function getSelector(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    if (el.classList.length > 0) {
      const sel = "." + [...el.classList].map((c) => CSS.escape(c)).join(".");
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    const path = [];
    while (el && el !== document.body) {
      const index = [...el.parentElement.children].indexOf(el) + 1;
      path.unshift(`${el.localName}:nth-child(${index})`);
      el = el.parentElement;
    }
    return "body > " + path.join(" > ");
  }

  // ───────── 3. background.js 에 상태 저장/불러오기 ─────────
  function makeKey(selector) {
    return location.origin + location.pathname + "|" + selector;
  }

  async function loadState(key) {
    return (await chrome.runtime.sendMessage({ type: "TIMER_GET", key })).state;
  }

  async function saveState(key, state) {
    return chrome.runtime.sendMessage({ type: "TIMER_SAVE", key, state });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ───────── 4. 메인: 타이머 검사 ─────────
  async function detectTimers() {
    const timers = findTimers();
    if (timers.length === 0) return { findings: [], notes: ["타이머 후보를 찾지 못했습니다."] };

    for (const t of timers) {
      t.key = makeKey(t.selector);
      t.startTime = Date.now();
      t.saved = await loadState(t.key);
    }

    await sleep(WAIT_TIME);
    for (const t of timers) {
      const el = document.querySelector(t.selector);
      t.after = el ? toSeconds(el.textContent) : null;
    }

    const findings = [];
    for (const t of timers) {
      let finding = null;
      const saved = t.saved;

      if (saved && saved.loadId === LOAD_ID) {
        finding = saved.finding;
      } else if (t.after !== null && t.after >= t.seconds && t.seconds > 0) {
        finding = {
          type: "STATIC_TIMER",
          level: "MEDIUM",
          message: "타이머가 줄어들지 않습니다. 확인이 필요합니다.",
          evidence: [`${toText(t.seconds)} -> ${toText(t.after)} (2초 지났는데 그대로)`, `주변 문구: "${t.around}"`],
          selector: t.selector,
        };
      } else if (saved) {
        const passed = (t.startTime - saved.lastTime) / 1000;
        const expected = Math.max(0, saved.lastSeconds - passed);

        if (t.seconds > expected + ALLOWED_GAP) {
          finding = {
            type: "RESET_TIMER",
            level: "HIGH",
            message: "새로고침 후 할인 시간이 초기화되었습니다.",
            evidence: [
              `예상 남은 시간 ${toText(expected)}`,
              `실제 표시 시간 ${toText(t.seconds)}`,
              `주변 문구: "${t.around}"`,
            ],
            selector: t.selector,
          };
        }
      }

      if (finding) findings.push(finding);

      await saveState(t.key, {
        lastSeconds: t.after !== null ? t.after : t.seconds,
        lastTime: Date.now(),
        loadId: LOAD_ID,
        finding: finding,
      });
    }

    return { findings, notes: [`타이머 후보 ${timers.length}개를 확인했습니다.`] };
  }

  DP.detectTimers = detectTimers;
})();
