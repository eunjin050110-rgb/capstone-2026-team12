(() => {
  "use strict";

  const api = globalThis.chrome;

  const MESSAGE = {
    GET_STATE: "GOAL_STATE",
    GOAL_START: "GOAL_START",
    GOAL_STOP: "GOAL_STOP",
    FIND_CANDIDATES: "FIND_GOAL_CANDIDATES",
    ACTIVATE_CANDIDATE: "ACTIVATE_CANDIDATE",
    START_MONITORING: "START_INTERFERENCE_MONITORING",
    STOP_MONITORING: "STOP_INTERFERENCE_MONITORING",
    NAV_RECORD: "NAV_RECORD"
  };

  const ui = {
    goalSelect: document.getElementById("goal-select"),
    startButton: document.getElementById("goal-start-button"),
    stopButton: document.getElementById("goal-stop-button"),
    status: document.getElementById("goal-status-message"),

    summary: document.getElementById("tracking-summary"),
    goal: document.getElementById("tracking-goal"),
    pageCount: document.getElementById("visited-page-count"),
    interferenceCount: document.getElementById("interference-count"),
    notice: document.getElementById("tracking-notice"),

    findButton: document.getElementById("find-goal-button"),
    candidatesSection: document.getElementById("goal-candidates-section"),
    candidatesEmpty: document.getElementById("goal-candidates-empty"),
    candidatesList: document.getElementById("goal-candidates-list"),
    candidateTemplate: document.getElementById("goal-candidate-template"),

    interferenceSection: document.getElementById("interference-section"),
    interferenceEmpty: document.getElementById("interference-empty"),
    interferenceList: document.getElementById("interference-list"),
    interferenceTemplate: document.getElementById("interference-template")
  };

  function setStatus(message) {
    ui.status.textContent = message;
  }

  async function getCurrentTab() {
    const [tab] = await api.tabs.query({
      active: true,
      currentWindow: true
    });

    if (!Number.isInteger(tab?.id) || !tab.url) {
      throw new Error("현재 페이지를 찾을 수 없습니다.");
    }

    const protocol = new URL(tab.url).protocol;

    if (!["http:", "https:", "file:"].includes(protocol)) {
      throw new Error("이 페이지에서는 목표 추적을 사용할 수 없습니다.");
    }

    return tab;
  }

  async function sendToTab(tabId, message) {
    return api.tabs.sendMessage(
      tabId,
      message,
      { frameId: 0 }
    );
  }

  function renderInterferenceEvents(events) {
    ui.interferenceList.replaceChildren();

    const validEvents = Array.isArray(events)
      ? events
      : [];

    ui.interferenceEmpty.hidden = validEvents.length > 0;
    ui.interferenceSection.hidden = false;

    const fragment = document.createDocumentFragment();

    for (const event of validEvents) {
      const item =
        ui.interferenceTemplate.content.cloneNode(true);

      item.querySelector(".interference-reason").textContent =
        event.reason || "반복 간섭이 탐지되었습니다.";

      item.querySelector(".interference-text").textContent =
        event.current || "";

      fragment.append(item);
    }

    ui.interferenceList.append(fragment);
  }

  function renderTrackingState(state) {
    const status = state?.status || "idle";
    const hasSession = Boolean(state?.goal);
    const isTracking = status === "tracking";

    ui.goalSelect.disabled = isTracking;
    ui.startButton.disabled = isTracking;
    ui.stopButton.disabled = !isTracking;
    ui.findButton.disabled = !isTracking;

    if (!hasSession) {
      setStatus("현재 추적 중인 목표가 없습니다.");
      ui.summary.hidden = true;
      ui.notice.hidden = true;
      ui.interferenceSection.hidden = true;
      return;
    }

    ui.goalSelect.value = state.goal;
    ui.goal.textContent = state.goalLabel || "-";
    ui.pageCount.textContent =
      String(state.pagesVisited || 0);
    ui.interferenceCount.textContent =
      String(state.interferenceCount || 0);
    ui.summary.hidden = false;

    if (status === "tracking") {
      setStatus(
        `${state.goalLabel} 과정을 추적하고 있습니다.`
      );
    } else if (status === "stopped") {
      setStatus(
        `${state.goalLabel} 과정 추적이 중단되었습니다.`
      );
    } else if (status === "paused-offsite") {
      setStatus(
        "다른 사이트로 이동하여 추적이 중단되었습니다."
      );
    }

    const notice =
      typeof state.notice === "string"
        ? state.notice.trim()
        : "";

    ui.notice.textContent = notice;
    ui.notice.hidden = !notice;

    renderInterferenceEvents(
      state.interferenceEvents
    );
  }

  async function loadTrackingState() {
    try {
      const tab = await getCurrentTab();

      const response = await api.runtime.sendMessage({
        type: MESSAGE.GET_STATE,
        tabId: tab.id
      });

      if (response?.error) {
        throw new Error(response.error);
      }

      renderTrackingState(
        response?.state || { status: "idle" }
      );
    } catch (error) {
      console.warn("[goal-tracking]", error);
      setStatus(
        "목표 추적 상태를 불러오지 못했습니다."
      );
    }
  }

  async function startTracking() {
    ui.startButton.disabled = true;

    try {
      const tab = await getCurrentTab();
      const goal = ui.goalSelect.value;

      const response = await api.runtime.sendMessage({
        type: MESSAGE.GOAL_START,
        tabId: tab.id,
        goal
      });

      if (response?.error) {
        throw new Error(response.error);
      }

      const monitoring = await sendToTab(tab.id, {
        type: MESSAGE.START_MONITORING
      });

      if (monitoring?.ok === false) {
        throw new Error(monitoring.message);
      }

      ui.candidatesSection.hidden = true;
      ui.candidatesList.replaceChildren();

      renderTrackingState(response.state);
    } catch (error) {
      console.warn("[goal-tracking]", error);
      setStatus(
        "목표 추적을 시작하지 못했습니다. 페이지를 새로고침한 뒤 다시 실행해 주세요."
      );
      ui.startButton.disabled = false;
    }
  }

  async function stopTracking() {
    ui.stopButton.disabled = true;

    try {
      const tab = await getCurrentTab();

      try {
        await sendToTab(tab.id, {
          type: MESSAGE.STOP_MONITORING
        });
      } catch (error) {
        console.warn(
          "[goal-tracking] 감시 중단 메시지 전송 실패:",
          error
        );
      }

      const response = await api.runtime.sendMessage({
        type: MESSAGE.GOAL_STOP,
        tabId: tab.id
      });

      if (response?.error) {
        throw new Error(response.error);
      }

      renderTrackingState(response.state);
    } catch (error) {
      console.warn("[goal-tracking]", error);
      setStatus("목표 추적을 중단하지 못했습니다.");
      ui.stopButton.disabled = false;
    }
  }

  async function recordNavigation(tabId, result) {
    await api.runtime.sendMessage({
      type: MESSAGE.NAV_RECORD,
      tabId,
      navType: result.action,
      label: result.label,
      href: result.url || null,
      isFinalAction: Boolean(result.isFinalAction)
    });
  }

  async function activateCandidate(tab, candidate) {
    try {
      const result = await sendToTab(tab.id, {
        type: MESSAGE.ACTIVATE_CANDIDATE,
        id: candidate.id
      });

      if (!result?.ok) {
        throw new Error(
          result?.message ||
          "목표 항목을 선택하지 못했습니다."
        );
      }

      await recordNavigation(tab.id, result);

      if (result.action === "navigate") {
        await api.tabs.update(tab.id, {
          url: result.url
        });
        return;
      }

      setStatus(
        `${result.label || "선택한 항목"}의 위치를 페이지에 표시했습니다.`
      );
    } catch (error) {
      console.warn("[goal-tracking]", error);
      setStatus(
        "선택한 항목을 찾지 못했습니다. 후보를 다시 검색해 주세요."
      );
    }
  }

  function renderCandidates(tab, candidates) {
    ui.candidatesList.replaceChildren();
    ui.candidatesSection.hidden = false;

    const validCandidates =
      Array.isArray(candidates) ? candidates : [];

    ui.candidatesEmpty.hidden =
      validCandidates.length > 0;

    const fragment = document.createDocumentFragment();

    for (const candidate of validCandidates) {
      const item =
        ui.candidateTemplate.content.cloneNode(true);

      const button =
        item.querySelector(".goal-candidate-button");

      item.querySelector(
        ".goal-candidate-label"
      ).textContent = candidate.label || "이름 없는 항목";

      item.querySelector(
        ".goal-candidate-action"
      ).textContent =
        candidate.action === "navigate"
          ? "페이지 이동"
          : "위치 보기";

      button.addEventListener("click", () => {
        activateCandidate(tab, candidate);
      });

      fragment.append(item);
    }

    ui.candidatesList.append(fragment);
  }

  async function findGoalCandidates() {
    ui.findButton.disabled = true;

    try {
      const tab = await getCurrentTab();

      const response = await sendToTab(tab.id, {
        type: MESSAGE.FIND_CANDIDATES,
        goalId: ui.goalSelect.value
      });

      if (!response?.ok) {
        throw new Error(
          response?.message ||
          "목표 후보를 찾지 못했습니다."
        );
      }

      renderCandidates(
        tab,
        response.candidates
      );
    } catch (error) {
      console.warn("[goal-tracking]", error);
      setStatus(
        "목표 이동 버튼을 찾지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요."
      );
    } finally {
      ui.findButton.disabled = false;
    }
  }

  if (
    !api?.runtime?.id ||
    !api?.tabs?.query
  ) {
    setStatus(
      "목표 추적 기능은 Chrome 확장 프로그램에서 사용할 수 있습니다."
    );
    return;
  }

  ui.startButton.addEventListener(
    "click",
    startTracking
  );

  ui.stopButton.addEventListener(
    "click",
    stopTracking
  );

  ui.findButton.addEventListener(
    "click",
    findGoalCandidates
  );

  loadTrackingState();
})();