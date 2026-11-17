/*
 * 콘텐츠 스크립트 통합 진입점. 아래 모듈 뒤에 같은 ISOLATED world로 주입합니다.
 * rules.js → checkbox-detector.js → timer-detector.js → goal-navigator.js
 * → interference-detector.js → highlighter.js → content.js
 *
 * 팝업 → 현재 탭 메시지:
 *   { type: "ANALYZE_PAGE" }
 *     → { ok, isSubscriptionPage, results, context, notes, warnings }
 *   { type: "FIND_GOAL_CANDIDATES", goalId: "signup" | "subscribe" | "cancel" }
 *     → { ok, goalId, candidates }
 *   { type: "ACTIVATE_CANDIDATE", id: "gn-1" }
 *     → locate: 위치 표시 / navigate: URL 반환. 클릭·이동·결제를 실행하지 않습니다.
 *   { type: "CLEAR_HIGHLIGHTS" }
 *   { type: "START_INTERFERENCE_MONITORING" } / { type: "STOP_INTERFERENCE_MONITORING" }
 *
 * background.js 의존성:
 *   TIMER_GET / TIMER_SAVE: timer-detector.js가 직접 요청합니다.
 *   GOAL_STATE / POPUP_SHOWN / POPUP_REJECTED: interference-detector.js가 요청합니다.
 *   목표 추적 세션은 background.js에서 GOAL_START / GOAL_STOP으로 관리합니다.
 *   이 파일은 background의 상태 저장이나 반복 간섭 판정을 중복 구현하지 않습니다.
 */
(() => {
  "use strict";
  const root = globalThis;
  if (root.TeamContent) return;
  if (!root.chrome?.runtime?.onMessage) return;

  const INITIAL_URL = location.href;
  const MESSAGE_TYPES = new Set([
    "ANALYZE_PAGE", "FIND_GOAL_CANDIDATES", "ACTIVATE_CANDIDATE",
    "CLEAR_HIGHLIGHTS", "START_INTERFERENCE_MONITORING", "STOP_INTERFERENCE_MONITORING",
  ]);
  const RESULT_TYPES = new Set(["PRESELECTED_OPTION", "RESET_TIMER", "STATIC_TIMER"]);
  const CONTEXT_THRESHOLD = 4;
  let analysisTask = null;
  let lastResults = [];
  let lastResultsUrl = null;
  let candidateUrl = null;
  let displayVersion = 0;

  class ContentError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  const text = value => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  const compact = value => text(value).toLowerCase().replace(/\s/g, "");

  function requireModule(object, method, filename) {
    if (typeof object?.[method] !== "function") {
      throw new ContentError("MODULE_MISSING", `${filename} 연결을 확인해 주세요. 확장 프로그램을 다시 로드한 뒤 페이지를 새로고침해 주세요.`);
    }
    return object;
  }

  function ensurePage(url) {
    if (location.href !== url) {
      throw new ContentError("PAGE_CHANGED", "페이지가 변경되었습니다. 페이지를 새로고침한 뒤 다시 분석해 주세요.");
    }
  }

  // DOM 텍스트는 이 함수 안에서만 사용합니다. 입력값이나 본문 전체를 보내지 않습니다.
  function getPageText() {
    if (!document.body) return "";
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const chunks = [];
    let length = 0;
    let node;
    while ((node = walker.nextNode()) && length < 60_000) {
      const parent = node.parentElement;
      if (!parent || parent.closest(
        'script, style, noscript, template, input, textarea, select, [contenteditable]:not([contenteditable="false"]), [hidden], [aria-hidden="true"], [data-dp-highlighter-root]'
      )) continue;
      if (parent.checkVisibility && !parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const part = text(node.textContent).slice(0, 60_000 - length);
      if (part) { chunks.push(part); length += part.length; }
    }
    return chunks.join(" ");
  }

  // 구독 페이지 선별용 규칙입니다. 법률 위반이나 다크패턴 위험도 점수가 아닙니다.
  function detectSubscriptionContext() {
    const bodyText = getPageText();
    const pageText = `${document.title || ""} ${bodyText}`;
    const normalized = compact(pageText);
    const evidence = [];
    let score = 0;
    const add = (points, reason) => { score += points; evidence.push(reason); };
    const url = new URL(location.href);
    if (/(subscription|billing|membership)/i.test(url.pathname)) add(1, "URL에 구독·결제 관련 경로가 있음");
    if (["구독", "멤버십", "요금제", "무료체험", "정기결제", "자동결제", "자동갱신", "월간", "연간", "해지", "subscription", "membership", "freetrial", "auto-renew", "monthly", "yearly"].some(word => normalized.includes(word))) {
      add(2, "페이지 제목 또는 본문에 구독 관련 표현이 있음");
    }
    const pricePatterns = [
      /(?:매월|월간|월|매년|연간|연)\s*(?:₩|\$|€)?\s*\d[\d,.]*\s*(?:원|달러|krw|usd)/i,
      /(?:₩|\$|€)\s*\d[\d,.]*\s*(?:\/|per)?\s*(?:월|개월|년|month|year)/i,
      /\d[\d,.]*\s*(?:원|krw|usd)\s*(?:\/|당|per)?\s*(?:월|개월|년|month|year)/i,
    ];
    if (pricePatterns.some(pattern => pattern.test(pageText))) add(3, "결제주기와 금액이 함께 표시됨");
    if (["자동갱신", "자동결제", "정기결제", "무료체험", "유료전환", "auto-renew", "autorenew", "freetrial"].some(word => normalized.includes(word))) {
      add(3, "자동갱신·정기결제 또는 무료체험 관련 표현이 있음");
    }
    const controls = document.querySelectorAll('button, a[href], [role="button"], input[type="button"], input[type="submit"]');
    const hasSubscribeButton = Array.from(controls).some(element => {
      if (element.disabled || element.closest('[hidden], [aria-hidden="true"], [data-dp-highlighter-root]')) return false;
      if (element.checkVisibility && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      const label = compact(element.tagName === "INPUT" ? element.value : element.textContent);
      return ["구독하기", "구독신청", "요금제선택", "무료체험시작", "구독해지", "subscribe", "chooseplan", "startfreetrial"].some(word => label.includes(word));
    });
    if (hasSubscribeButton) add(2, "구독·요금제 관련 동작 버튼이 있음");
    return { isSubscriptionPage: score >= CONTEXT_THRESHOLD, score, threshold: CONTEXT_THRESHOLD, evidence };
  }

  function adaptCheckboxes(rawResults, warnings) {
    if (!Array.isArray(rawResults)) throw new ContentError("CHECKBOX_RESPONSE_INVALID", "체크박스 분석 결과 형식이 올바르지 않습니다.");
    const results = [];
    for (const item of rawResults) {
      if (item?.type !== "PRESELECTED_OPTION" || typeof item.selector !== "string" || typeof item.label !== "string") {
        throw new ContentError("CHECKBOX_RESPONSE_INVALID", "체크박스 분석 결과 형식이 올바르지 않습니다.");
      }
      let matches;
      try { matches = document.querySelectorAll(item.selector); } catch { matches = []; }
      if (matches.length !== 1 || !matches[0].matches('input[type="checkbox"]')) {
        warnings.push("일부 최초 관찰 항목의 위치가 변경되어 표시하지 못했습니다. 새로고침 후 다시 분석해 주세요.");
        continue;
      }
      // 최초 관찰 후 해제된 항목이나 새로 선택한 항목을 현재 의심 항목에 추가하지 않습니다.
      if (item.checked !== true || !matches[0].checked) continue;
      results.push({
        type: "PRESELECTED_OPTION", level: "MEDIUM",
        message: "최초 관찰 시 선택되어 있던 선택 항목입니다.",
        evidence: ["탐지기 최초 로드 시점에 선택되어 있었음", `주변 문구: ${text(item.label).slice(0, 240) || "설명 없음"}`],
        selector: item.selector,
      });
    }
    return results;
  }

  function adaptTimers(response) {
    if (!response || !Array.isArray(response.findings) || !Array.isArray(response.notes)) {
      throw new ContentError("TIMER_RESPONSE_INVALID", "타이머 분석 결과 형식이 올바르지 않습니다.");
    }
    return response.findings.map(item => {
      if (!item || !["RESET_TIMER", "STATIC_TIMER"].includes(item.type)
          || typeof item.message !== "string" || !item.message.trim()
          || typeof item.selector !== "string" || !item.selector.trim()
          || !Array.isArray(item.evidence)
          || !item.evidence.every(value => typeof value === "string" && value.trim())) {
        throw new ContentError("TIMER_RESPONSE_INVALID", "타이머 분석 결과 형식이 올바르지 않습니다.");
      }
      return { type: item.type, level: item.level || "MEDIUM", message: item.message, evidence: [...item.evidence], selector: item.selector };
    });
  }

  function applyHighlights(results, warnings) {
    try {
      const summary = requireModule(root.DarkPatternHighlighter, "highlight", "highlighter.js").highlight(results);
      if (summary?.skipped?.length) warnings.push(`${summary.skipped.length}개 항목은 현재 페이지에서 위치를 표시하지 못했습니다.`);
      return summary;
    } catch {
      warnings.push("탐지 결과의 페이지 표시를 완료하지 못했습니다.");
      return null;
    }
  }

  async function runAnalysis() {
    const url = location.href;
    const version = ++displayVersion;
    const warnings = [];
    const notes = ["사전 선택 여부는 탐지기 최초 관찰 시점을 기준으로 합니다. 그 이전의 사용자 조작은 알 수 없습니다."];
    root.DarkPatternHighlighter?.clear();
    lastResults = [];
    lastResultsUrl = null;
    const context = detectSubscriptionContext();
    if (!context.isSubscriptionPage) return { ok: true, isSubscriptionPage: false, results: [], context, notes: [], warnings: [] };

    const checkbox = requireModule(root.checkboxDetector, "getInitialResults", "checkbox-detector.js");
    const timer = requireModule(root.DP, "detectTimers", "timer-detector.js");
    const observationUrl = checkbox.getObservationInfo?.().url ?? INITIAL_URL;
    ensurePage(observationUrl);
    const checkboxResults = adaptCheckboxes(checkbox.getInitialResults(), warnings);
    let timerResponse;
    try { timerResponse = await timer.detectTimers(); }
    catch (error) {
      console.warn("[content] timer detection failed", error);
      throw new ContentError("TIMER_ANALYSIS_FAILED", "타이머 분석을 완료하지 못했습니다. background.js의 TIMER_GET·TIMER_SAVE 연결을 확인해 주세요.");
    }
    ensurePage(url);
    const seen = new Set();
    const results = [...checkboxResults, ...adaptTimers(timerResponse)].filter(item => {
      const key = `${item.type}\n${item.selector}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return RESULT_TYPES.has(item.type);
    });
    notes.push(...timerResponse.notes.filter(value => typeof value === "string").map(value => text(value).slice(0, 300)));
    if (root.TeamInterferenceDetector) {
      notes.push("반복 간섭은 목표 추적 중 별도로 기록합니다. 이번 체크박스·타이머 건수에는 포함하지 않습니다.");
    } else {
      warnings.push("반복 간섭 감시 모듈이 연결되지 않았습니다.");
    }
    let highlighting = null;
    if (version === displayVersion) {
      lastResults = results;
      lastResultsUrl = url;
      highlighting = applyHighlights(results, warnings);
    }
    return { ok: true, isSubscriptionPage: true, results, context, notes, warnings: [...new Set(warnings)], highlighting };
  }

  // 팝업을 다시 열어 눌러도 같은 탭의 진행 중 분석을 중복 실행하지 않습니다.
  function analyze() {
    if (!analysisTask) analysisTask = runAnalysis().finally(() => { analysisTask = null; });
    return analysisTask;
  }

  function findGoalCandidates(goalId) {
    if (!Object.prototype.hasOwnProperty.call(root.TeamRules?.GOALS ?? {}, goalId)) {
      throw new ContentError("INVALID_GOAL", "가입·구독·해지 중 지원하는 목표를 선택해 주세요.");
    }
    const navigator = requireModule(root.TeamGoalNavigator, "findCandidates", "goal-navigator.js");
    const candidates = navigator.findCandidates(goalId);
    candidateUrl = location.href;
    return { ok: true, goalId, candidates };
  }

  function selectorFor(element) {
    if (element.id) {
      const selector = `#${CSS.escape(element.id)}`;
      if (document.querySelectorAll(selector).length === 1) return selector;
    }
    const parts = [];
    for (let current = element; current && current !== document.documentElement; current = current.parentElement) {
      const siblings = Array.from(current.parentElement?.children ?? []).filter(node => node.localName === current.localName);
      parts.unshift(`${current.localName}:nth-of-type(${siblings.indexOf(current) + 1})`);
    }
    return `html > ${parts.join(" > ")}`;
  }

  function activateGoalCandidate(id) {
    if (typeof id !== "string" || candidateUrl !== location.href) throw new ContentError("STALE_CANDIDATE", "목표에 맞는 후보를 다시 찾아주세요.");
    const navigator = requireModule(root.TeamGoalNavigator, "activate", "goal-navigator.js");
    const result = navigator.activate(id);
    if (!result?.ok) throw new ContentError("CANDIDATE_UNAVAILABLE", result?.error || "이 후보를 더 이상 찾을 수 없습니다.");
    if (result.action === "navigate") {
      const url = new URL(result.url, location.href);
      if (!/^https?:$/.test(url.protocol)) throw new ContentError("UNSUPPORTED_URL", "지원하지 않는 주소입니다.");
      // URL만 반환합니다. 실제 링크 선택은 사용자가 수행합니다.
      return { ok: true, action: "navigate", url: url.href, label: text(result.label), isFinalAction: Boolean(result.isFinalAction), requiresUserAction: true };
    }
    const element = result.element;
    if (result.action !== "locate" || !(element instanceof Element) || !element.isConnected || element.ownerDocument !== document) {
      throw new ContentError("CANDIDATE_UNAVAILABLE", "이 후보의 위치를 찾을 수 없습니다.");
    }
    ++displayVersion;
    element.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
    const selector = selectorFor(element);
    const warnings = [];
    const currentResults = lastResultsUrl === location.href ? lastResults : [];
    const highlighting = applyHighlights([...currentResults, { type: "GOAL_TARGET", selector }], warnings);
    // DOM 요소는 응답에 넣지 않습니다. 최종 가입·결제·해지 버튼도 클릭하지 않습니다.
    return { ok: true, action: "locate", label: text(result.label), selector, isFinalAction: Boolean(result.isFinalAction), requiresUserAction: true, highlighting, warnings };
  }

  async function handleMessage(message) {
    switch (message.type) {
      case "ANALYZE_PAGE": return analyze();
      case "FIND_GOAL_CANDIDATES": return findGoalCandidates(message.goalId);
      case "ACTIVATE_CANDIDATE": return activateGoalCandidate(message.id);
      case "CLEAR_HIGHLIGHTS":
        ++displayVersion;
        lastResults = [];
        lastResultsUrl = null;
        root.DarkPatternHighlighter?.clear();
        return { ok: true };
      case "START_INTERFERENCE_MONITORING": {
        const detector = requireModule(root.TeamInterferenceDetector, "start", "interference-detector.js");
        // 새 목표 세션에서 이전 세션의 DOM 표시 이력을 재사용하지 않습니다.
        detector.stop();
        detector.start();
        await detector.scan();
        return { ok: true, monitoring: true, requiresGoalTracking: true };
      }
      case "STOP_INTERFERENCE_MONITORING":
        requireModule(root.TeamInterferenceDetector, "stop", "interference-detector.js").stop();
        return { ok: true, monitoring: false };
    }
  }

  function onMessage(message, sender, sendResponse) {
    if (!MESSAGE_TYPES.has(message?.type)) return false;
    if (sender?.id !== chrome.runtime.id) return false;
    Promise.resolve().then(() => handleMessage(message)).then(
      response => sendResponse(response),
      error => sendResponse({ ok: false, code: error.code || "CONTENT_ERROR", message: error instanceof ContentError ? error.message : "페이지 분석 기능을 실행하지 못했습니다. 확장 프로그램 연결을 확인해 주세요." }),
    );
    return true;
  }

  chrome.runtime.onMessage.addListener(onMessage);
  root.TeamContent = Object.freeze({ analyze, findGoalCandidates, activateGoalCandidate });
})();
