/*
 * 팝업: 분석 요청 → content.js의 응답 확인 → 유형별 건수와 근거 표시.
 * 탐지와 하이라이트 실행, 결과 저장은 content.js / background.js에서 담당합니다.
 *
 * 연결 규약 — 계획서에 메시지 이름이 없어 이 파일에서 정한 형식입니다.
 * 요청: { type: "ANALYZE_PAGE" }
 * 성공 응답:
 * {
 *   ok: true,
 *   isSubscriptionPage: true,
 *   results: [{
 *     type: "PRESELECTED_OPTION", // 또는 "RESET_TIMER"
 *     level: "HIGH",
 *     message: "유료 부가서비스가 선택되어 있습니다.",
 *     evidence: ["최초 관찰 시 선택되어 있음", "보험", "월 4,900원"],
 *     selector: "#insurance-option"
 *   }]
 * }
 * 분석 대상 아님: { ok: true, isSubscriptionPage: false, results: [] }
 * 분석 실패: { ok: false, message: "사용자에게 보여줄 오류 설명" }
 *
 * content.js는 요청을 받았을 때만 분석하고 sendResponse로 응답합니다.
 * 비동기로 sendResponse를 호출하면 onMessage 리스너에서 return true가 필요합니다.
 * 중복 주입에 대비해 각 콘텐츠 스크립트의 초기화와 리스너 등록을 보호해 주세요.
 * 모든 탐지가 끝난 뒤 응답하며, 일부 탐지 실패를 빈 results로 반환하지 마세요.
 *
 * 필요한 권한: activeTab, scripting. 별도 빌드 과정이나 외부 라이브러리는 없습니다.
 */
(() => {
  "use strict";

  const api = globalThis.chrome;
  const REQUEST_TYPE = "ANALYZE_PAGE";
  const RESPONSE_TIMEOUT_MS = 20_000;
  const SCRIPT_FILES = [
    "src/rules.js",
    "src/checkbox-detector.js",
    "src/timer-detector.js",
    "src/highlighter.js",
    "src/content.js",
  ];
  const TYPE_LABELS = new Map([
    ["PRESELECTED_OPTION", "사전 선택 의심"],
    ["RESET_TIMER", "허위 타이머 의심"],
  ]);
  const ui = {
    button: document.getElementById("analyze-button"),
    status: document.getElementById("status-message"),
    results: document.getElementById("results-section"),
    preselectedCount: document.getElementById("preselected-count"),
    timerCount: document.getElementById("timer-count"),
    emptyMessage: document.getElementById("empty-message"),
    list: document.getElementById("findings-list"),
    template: document.getElementById("finding-template"),
  };
  let isAnalyzing = false;

  class DisplayError extends Error {}

  function setStatus(message, state = "idle") {
    ui.status.textContent = message;
    ui.status.dataset.state = state;
  }

  function setBusy(busy) {
    isAnalyzing = busy;
    ui.button.disabled = busy;
    ui.button.textContent = busy ? "분석 중…" : "현재 페이지 분석";
  }

  function clearResults() {
    ui.results.hidden = true;
    ui.emptyMessage.hidden = true;
    ui.list.replaceChildren();
    ui.preselectedCount.textContent = "0";
    ui.timerCount.textContent = "0";
  }

  async function getCurrentTab() {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!Number.isInteger(tab?.id) || !tab.url) {
      throw new DisplayError("현재 페이지를 찾을 수 없습니다. 웹페이지를 연 뒤 다시 실행해 주세요.");
    }

    const { protocol } = new URL(tab.url);
    if (!["http:", "https:", "file:"].includes(protocol)) {
      throw new DisplayError("이 페이지는 분석할 수 없습니다. 일반 웹페이지나 테스트 페이지에서 실행해 주세요.");
    }
    return tab;
  }

  // 응답 대기만 제한합니다. 콘텐츠 스크립트의 실행 자체를 취소하지는 않습니다.
  async function sendAnalysisRequest(tabId) {
    let timer;
    try {
      return await Promise.race([
        api.tabs.sendMessage(tabId, { type: REQUEST_TYPE }, { frameId: 0 }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new DisplayError("분석 응답이 지연되고 있습니다. 잠시 후 다시 실행해 주세요."));
          }, RESPONSE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function analyzeTab(tab) {
    try {
      // 이미 연결된 content.js를 재사용해 리스너와 탐지기의 중복 등록을 줄입니다.
      return await sendAnalysisRequest(tab.id);
    } catch (error) {
      // 응답 지연이나 분석 오류에는 재주입하지 않습니다.
      if (!/Receiving end does not exist/i.test(error?.message ?? "")) {
        throw error;
      }
    }

    const currentTab = await api.tabs.get(tab.id);
    if (currentTab.url !== tab.url) {
      throw new DisplayError("페이지가 변경되었습니다. 현재 페이지에서 다시 분석해 주세요.");
    }

    const target = { tabId: tab.id, frameIds: [0] };
    await api.scripting.insertCSS({ target, files: ["src/content.css"] });
    await api.scripting.executeScript({ target, files: SCRIPT_FILES });
    return sendAnalysisRequest(tab.id);
  }

  function validateResponse(response) {
    const invalid = () => new DisplayError("분석 결과를 읽을 수 없습니다. 탐지 기능의 연결 상태를 확인해 주세요.");
    if (!response || typeof response !== "object") {
      throw invalid();
    }
    if (response.ok === false) {
      const message = typeof response.message === "string" && response.message.trim()
        ? response.message
        : "페이지 분석을 완료하지 못했습니다. 다시 실행해 주세요.";
      throw new DisplayError(message);
    }
    if (response.ok !== true || typeof response.isSubscriptionPage !== "boolean"
        || !Array.isArray(response.results)) {
      throw invalid();
    }
    if (!response.isSubscriptionPage && response.results.length > 0) {
      throw invalid();
    }

    // 화면에 쓰는 필드를 검증합니다. 잘못된 응답을 '탐지 0건'으로 표시하지 않습니다.
    for (const item of response.results) {
      if (!item || !TYPE_LABELS.has(item.type)
          || typeof item.message !== "string" || !item.message.trim()
          || !Array.isArray(item.evidence)
          || !item.evidence.every(text => typeof text === "string" && text.trim())) {
        throw invalid();
      }
    }
    return response;
  }

  function renderResults(results) {
    const fragment = document.createDocumentFragment();
    let preselectedCount = 0;
    let timerCount = 0;

    for (const result of results) {
      if (result.type === "PRESELECTED_OPTION") preselectedCount += 1;
      if (result.type === "RESET_TIMER") timerCount += 1;

      const item = ui.template.content.cloneNode(true);
      item.querySelector(".finding").dataset.type = result.type;
      item.querySelector(".finding-type").textContent = TYPE_LABELS.get(result.type);
      item.querySelector(".finding-message").textContent = result.message;

      const evidenceList = item.querySelector(".finding-evidence");
      const evidence = result.evidence.length > 0
        ? result.evidence
        : ["제공된 판단 근거가 없습니다."];
      for (const text of evidence) {
        const li = document.createElement("li");
        // 페이지에서 가져온 문구를 HTML로 실행하지 않고 텍스트로만 표시합니다.
        li.textContent = text;
        evidenceList.append(li);
      }
      fragment.append(item);
    }

    ui.list.replaceChildren(fragment);
    ui.preselectedCount.textContent = String(preselectedCount);
    ui.timerCount.textContent = String(timerCount);
    ui.emptyMessage.hidden = results.length !== 0;
    ui.results.hidden = false;
  }

  function getErrorMessage(error) {
    if (error instanceof DisplayError) return error.message;
    const message = error?.message ?? "";
    if (/Cannot access|cannot be scripted|Missing host permission/i.test(message)) {
      return "이 페이지에 접근할 수 없습니다. 로컬 테스트 파일은 확장 프로그램 설정에서 파일 URL 접근을 허용해 주세요.";
    }
    if (/Could not load|Failed to load/i.test(message)) {
      return "분석에 필요한 파일을 불러오지 못했습니다. 확장 프로그램 파일을 확인한 뒤 다시 로드해 주세요.";
    }
    if (/Receiving end does not exist|message port closed|message channel closed|No tab with id/i.test(message)) {
      return "페이지 분석 기능에 연결하지 못했습니다. 페이지 로딩이 끝난 뒤 다시 실행해 주세요.";
    }
    return "분석 중 오류가 발생했습니다. 페이지를 새로고침한 뒤 다시 실행해 주세요.";
  }

  async function handleAnalyze() {
    if (isAnalyzing) return;
    setBusy(true);
    clearResults();
    setStatus("현재 페이지를 분석하고 있습니다.", "loading");

    try {
      const tab = await getCurrentTab();
      const response = validateResponse(await analyzeTab(tab));
      const currentTab = await api.tabs.get(tab.id);
      if (currentTab.url !== tab.url) {
        throw new DisplayError("페이지가 변경되었습니다. 현재 페이지에서 다시 분석해 주세요.");
      }

      if (!response.isSubscriptionPage) {
        setStatus("현재 페이지는 구독 관련 페이지로 판단되지 않아 분석하지 않았습니다.", "excluded");
        return;
      }

      renderResults(response.results);
      setStatus(response.results.length > 0
        ? `분석 완료 · 의심 항목 ${response.results.length}건`
        : "분석을 완료했습니다.", "success");
    } catch (error) {
      clearResults();
      setStatus(getErrorMessage(error), "error");
      console.warn("[Dark Pattern Popup]", error);
    } finally {
      setBusy(false);
    }
  }

  // popup.html을 일반 탭에서 열었을 때 실제 분석이 되는 것처럼 표시하지 않습니다.
  if (!api?.runtime?.id || !api?.tabs?.query || !api?.scripting?.executeScript) {
    ui.button.disabled = true;
    setStatus("분석 기능은 Chrome 확장 프로그램 팝업에서 사용할 수 있습니다.");
    return;
  }
  ui.button.addEventListener("click", handleAnalyze);
})();
