/*
 * 탐지 결과를 페이지 위에 표시하는 Chrome 콘텐츠 스크립트입니다.
 * content.js보다 먼저 같은 프레임 / ISOLATED world에 주입해 주세요.
 *
 * content.js에서의 사용:
 *   const summary = globalThis.DarkPatternHighlighter.highlight(results);
 *   // summary: { matched: 등록된 요소 수, skipped: [{ index, reason }] }
 *   globalThis.DarkPatternHighlighter.clear();   // 모든 표시와 위치 추적 해제
 *   globalThis.DarkPatternHighlighter.refresh(); // 위치 갱신 요청 (보통 자동 처리)
 *
 * results는 계획서의 공통 결과 배열입니다. type과 selector를 사용합니다.
 *   { type: "PRESELECTED_OPTION", selector: "#insurance-option", ... }
 *   { type: "RESET_TIMER", selector: ".sale-timer", ... }
 * selector는 현재 document에서 정확히 한 요소를 가리켜야 합니다.
 * 잘못된 / 없는 / 여러 요소를 가리키는 selector는 skipped로 돌려줍니다.
 * matched는 화면 밖의 요소를 포함한 등록 수이며, 현재 보이는 개수가 아닙니다.
 *
 * 사전 선택은 실선, 타이머는 점선이며 라벨로 유형을 구분합니다.
 * 원래 요소를 감싸거나 스타일·선택 상태를 변경하지 않습니다.
 * 필요한 스타일은 이 파일 안에 있어 별도 CSS를 작성할 필요가 없습니다.
 *
 * 범위: 현재 프레임의 일반 DOM. iframe / Shadow DOM 내부에는 별도 연결이
 * 필요합니다. native dialog 등 최상위 레이어와 루트 transform / zoom을 쓰는
 * 페이지는 추가 확인이 필요합니다. DOM 교체나 URL 변경 후에는 재분석하세요.
 */
(() => {
  "use strict";

  // 같은 페이지에 재주입되어도 표시와 이벤트 리스너를 중복 생성하지 않습니다.
  if (globalThis.DarkPatternHighlighter) return;

  const TYPE_LABELS = new Map([
    ["PRESELECTED_OPTION", "사전 선택 의심"],
    ["RESET_TIMER", "허위 타이머 의심"],
  ]);
  const PADDING = 3;
  const EDGE = 4;
  const POSITION_INTERVAL_MS = 250;
  const STYLES = `
    *, *::before, *::after {
      box-sizing: border-box;
      pointer-events: none !important;
    }
    [hidden] { display: none !important; }
    .mark { position: absolute; inset: 0; }
    .outline {
      position: absolute;
      border: 1px solid #222;
      outline: 1px solid #fff;
      background: transparent;
    }
    .label {
      position: absolute;
      max-width: calc(100% - 8px);
      margin: 0;
      padding: 3px 6px;
      border: 1px solid #555;
      background: #fff;
      color: #222;
      font: 500 12px/1.4 system-ui, -apple-system, "Segoe UI",
        "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
      letter-spacing: normal;
      text-align: left;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `;

  let host = null;
  let shadow = null;
  let entries = [];
  let frameId = null;
  let intervalId = null;
  let analyzedUrl = "";

  function createLayer() {
    host = document.createElement("div");
    host.setAttribute("data-dp-highlighter-root", "true");
    // 화면 낭독기에 제공할 설명은 팝업의 결과 목록에 있습니다.
    host.setAttribute("aria-hidden", "true");
    const styles = {
      all: "initial",
      position: "fixed",
      inset: "0",
      display: "block",
      margin: "0",
      padding: "0",
      border: "0",
      width: "auto",
      height: "auto",
      "min-width": "0",
      "min-height": "0",
      "max-width": "none",
      "max-height": "none",
      background: "transparent",
      opacity: "1",
      visibility: "visible",
      "pointer-events": "none",
      "z-index": "2147483647",
      overflow: "hidden",
      contain: "strict",
    };
    for (const [property, value] of Object.entries(styles)) {
      host.style.setProperty(property, value, "important");
    }

    shadow = host.attachShadow({ mode: "closed" });
    // 스타일을 Shadow DOM 안에 두어 페이지의 CSS와 섞이지 않게 합니다.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(STYLES);
    shadow.adoptedStyleSheets = [sheet];
    document.documentElement.append(host);
  }

  function createMark(types) {
    const mark = document.createElement("div");
    mark.className = "mark";
    mark.hidden = true;

    const outline = document.createElement("div");
    outline.className = "outline";
    outline.style.borderStyle = types.has("PRESELECTED_OPTION") ? "solid" : "dashed";

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = [...TYPE_LABELS]
      .filter(([type]) => types.has(type))
      .map(([, text]) => text)
      .join(" · ");

    mark.append(outline, label);
    shadow.append(mark);
    return { mark, outline, label };
  }

  // 요소와 연결된 label만 포함합니다. 무관한 큰 부모 영역은 추측하지 않습니다.
  function getAreas(entry) {
    const areas = [entry.element];
    if (entry.types.has("PRESELECTED_OPTION")
        && entry.element.matches('input[type="checkbox"], input[type="radio"]')) {
      areas.push(...(entry.element.labels ?? []));
    }
    return [...new Set(areas)];
  }

  function getVisibleRect(element, width, height) {
    if (!element.isConnected || element.ownerDocument !== document) return null;
    if (element.checkVisibility && !element.checkVisibility({
      checkOpacity: true,
      checkVisibilityCSS: true,
      contentVisibilityAuto: true,
    })) return null;

    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden"
        || style.visibility === "collapse" || Number(style.opacity) === 0) return null;

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    let left = Math.max(0, rect.left);
    let top = Math.max(0, rect.top);
    let right = Math.min(width, rect.right);
    let bottom = Math.min(height, rect.bottom);

    // 일반 스크롤 영역 밖으로 잘려 나간 부분에 표시가 남지 않게 합니다.
    if (style.position !== "fixed") {
      for (let parent = element.parentElement;
           parent && parent !== document.body && parent !== document.documentElement;
           parent = parent.parentElement) {
        const parentStyle = getComputedStyle(parent);
        const clipX = /^(auto|scroll|hidden|clip)$/.test(parentStyle.overflowX);
        const clipY = /^(auto|scroll|hidden|clip)$/.test(parentStyle.overflowY);
        if (!clipX && !clipY) continue;
        const bounds = parent.getBoundingClientRect();
        if (clipX) {
          left = Math.max(left, bounds.left);
          right = Math.min(right, bounds.right);
        }
        if (clipY) {
          top = Math.max(top, bounds.top);
          bottom = Math.min(bottom, bounds.bottom);
        }
      }
    }

    if (right <= left || bottom <= top) return null;
    return { left, top, right, bottom };
  }

  const clamp = (value, min, max) => Math.max(min, Math.min(value, Math.max(min, max)));

  function updatePositions() {
    frameId = null;
    if (!host) return;
    if (!host.isConnected || location.href !== analyzedUrl) {
      clear();
      return;
    }

    entries = entries.filter(entry => {
      if (entry.element.isConnected) return true;
      entry.mark.remove();
      return false;
    });
    if (entries.length === 0) {
      clear();
      return;
    }

    const width = document.documentElement.clientWidth || innerWidth;
    const height = document.documentElement.clientHeight || innerHeight;
    const occupiedLabels = [];

    for (const entry of entries) {
      const rectangles = getAreas(entry)
        .map(element => getVisibleRect(element, width, height))
        .filter(Boolean);
      if (rectangles.length === 0) {
        entry.mark.hidden = true;
        continue;
      }

      const left = Math.max(0, Math.min(...rectangles.map(rect => rect.left)) - PADDING);
      const top = Math.max(0, Math.min(...rectangles.map(rect => rect.top)) - PADDING);
      const right = Math.min(width, Math.max(...rectangles.map(rect => rect.right)) + PADDING);
      const bottom = Math.min(height, Math.max(...rectangles.map(rect => rect.bottom)) + PADDING);
      Object.assign(entry.outline.style, {
        left: `${left}px`, top: `${top}px`,
        width: `${right - left}px`, height: `${bottom - top}px`,
      });
      entry.mark.hidden = false;
      entry.label.hidden = false;

      const labelWidth = entry.label.offsetWidth;
      const labelHeight = entry.label.offsetHeight;
      const labelLeft = clamp(left, EDGE, width - labelWidth - EDGE);
      const candidates = [top - labelHeight - EDGE, bottom + EDGE, top + EDGE]
        .map(y => clamp(y, EDGE, height - labelHeight - EDGE));
      const labelTop = candidates.find(y => occupiedLabels.every(box =>
        labelLeft + labelWidth + EDGE <= box.left || labelLeft >= box.right + EDGE
        || y + labelHeight + EDGE <= box.top || y >= box.bottom + EDGE));

      // 가까운 항목의 라벨이 겹치면 테두리를 유지하고 중복 위치의 라벨만 숨깁니다.
      if (labelTop === undefined) {
        entry.label.hidden = true;
      } else {
        entry.label.style.left = `${labelLeft}px`;
        entry.label.style.top = `${labelTop}px`;
        occupiedLabels.push({
          left: labelLeft, top: labelTop,
          right: labelLeft + labelWidth, bottom: labelTop + labelHeight,
        });
      }
    }
  }

  function refresh() {
    if (!host || document.hidden || frameId !== null) return;
    frameId = requestAnimationFrame(updatePositions);
  }

  function clear() {
    if (frameId !== null) cancelAnimationFrame(frameId);
    if (intervalId !== null) clearInterval(intervalId);
    frameId = null;
    intervalId = null;
    window.removeEventListener("scroll", refresh, true);
    window.removeEventListener("resize", refresh);
    window.removeEventListener("popstate", refresh);
    window.removeEventListener("hashchange", refresh);
    document.removeEventListener("visibilitychange", refresh);
    host?.remove();
    host = null;
    shadow = null;
    entries = [];
    analyzedUrl = "";
  }

  function highlight(results) {
    if (!Array.isArray(results)) {
      throw new TypeError("highlight에는 탐지 결과 배열을 전달해 주세요.");
    }
    clear();
    const groups = new Map();
    const skipped = [];

    results.forEach((result, index) => {
      if (!result || !TYPE_LABELS.has(result.type)) {
        skipped.push({ index, reason: "지원하지 않는 탐지 유형" });
        return;
      }
      if (typeof result.selector !== "string" || !result.selector.trim()) {
        skipped.push({ index, reason: "selector 누락" });
        return;
      }

      let matches;
      try {
        matches = document.querySelectorAll(result.selector);
      } catch {
        skipped.push({ index, reason: "잘못된 CSS selector" });
        return;
      }
      if (matches.length !== 1) {
        skipped.push({ index, reason: matches.length === 0 ? "대상 요소 없음" : "selector가 여러 요소와 일치" });
        return;
      }
      const element = matches[0];
      if (element === document.documentElement || element === document.body) {
        skipped.push({ index, reason: "페이지 전체는 표시 대상에서 제외" });
        return;
      }
      if (!groups.has(element)) groups.set(element, new Set());
      groups.get(element).add(result.type);
    });

    if (groups.size === 0) return { matched: 0, skipped };

    try {
      createLayer();
      for (const [element, types] of groups) {
        entries.push({ element, types, ...createMark(types) });
      }
      analyzedUrl = location.href;
      window.addEventListener("scroll", refresh, { capture: true, passive: true });
      window.addEventListener("resize", refresh, { passive: true });
      window.addEventListener("popstate", refresh);
      window.addEventListener("hashchange", refresh);
      document.addEventListener("visibilitychange", refresh);
      // DOM 변경·이미지 로딩 등에 따른 위치 이동도 보정합니다. clear에서 해제합니다.
      intervalId = setInterval(refresh, POSITION_INTERVAL_MS);
      updatePositions();
      return { matched: groups.size, skipped };
    } catch (error) {
      clear();
      throw error;
    }
  }

  globalThis.DarkPatternHighlighter = Object.freeze({ highlight, clear, refresh });
})();
