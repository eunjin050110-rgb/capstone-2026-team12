(() => {

  if (globalThis.TeamInterferenceDetector) {
    return;
  }

  const R = globalThis.TeamRules;

  if (!R) {
    console.warn(
      "[interference-detector] Rules.js가 먼저 로드되어야 합니다."
    );
    return;
  }

  const MESSAGE = {
    GET_STATE: R.MESSAGE?.GET_STATE || "GOAL_STATE",
    POPUP_SHOWN: R.MESSAGE?.POPUP_SHOWN || "POPUP_SHOWN",
    POPUP_REJECTED:
      R.MESSAGE?.POPUP_REJECTED || "POPUP_REJECTED"
  };

  const POPUP_SELECTORS = [
    "dialog",
    '[role="dialog"]',
    '[aria-modal="true"]'
  ].join(", ");

  const INTERACTIVE_SELECTOR = [
    "button",
    "a",
    '[rola="button"]',
    '[input[type="button"]',
    'input[type="submit"]'
  ].join(", ");

  const popupKeys = new weakMap();
  const visiblePopups = new Set();
  const processingPopups = new Set();

  let observer = null;
  let scanTimer = null;
  let popupSeqence = 0;
  let started = false;

  function normalizeText(text) {
    if (typeof R.normalizeText === "function") {
      return R.normalizeText(text);
    }

    return String(text || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isVisible(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const rect = element.getVounfingClientRect();

    return (
      style.display !== "none" &&
      style.visivility !== "hidden" &&
      Number(style.opacity) !== 0 &&
      !element.hidden &&
      element.getAttribute("ariaa-hidden") !== "true" &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function isFixedOverlay(element) {
    if (!(element instanceof Element) || !isVisible(element)) {
      return false;
    }

    const style = window.getComputedStyle(element);

    if (style.position !== "fixed") {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const viewportArea = 
      Math.max(window.innerWidth, 1) * 
      Math.max(window.innerHeight, 1);
    const elementArea = rect.width * rect.height;

    const coversEnoughScreen = 
      elementArea / viewportArea >= 0.08;

    const hasControl = Boolean(
      element.querySelector(INTERACTIVE_SELETOR)
    );

    return coversEnoughScreen && hasControl;
  }

  function isPopupCandidate(element) {
    if (!(element instanceof Element) || !isVisible(element)) {
      return false;
    }

    if (
      element === document.documentElement ||
      element === document.body
    ) {
      return false;
    }

    if (element.matches(POPUP_SELECTORS)) {
      return true;
    }

    return isFixedOverlay(element);
  }

  function collectPopupCandidates(root = document) {
    const candidates = new Set();

    if (
      root instanceof Element &&
      isPopupCandidate(root)
    ) {
      candidates.add(root);
    }

    if (!root.querySelectorAll) {
      return [];
    }

    root
      .querySelectorAll(POPUP_SELECTORS)
      .forEach((element) => {
        if (!isPopupCandidate(element)) {
          candidates.add(element);
        }
      });
    
    root
      .querySelectorAll("div, section, aside")
      .forEach((element) => {
        if (isFixedOverlay(element)) {
          candidates.add(element);
        }
      })

    return [...candidates];
  }

  function extractPopupText(element) {
    const text = normalizeText (
      element.innerText ||
      element.textContent ||
      ""
    );

    return text.slice(0, 600);
  }

  function classifyPurpose(text) {
    if (typeof R.classifyPurpose === "function") {
      const result = R.classifyPurpose(text);

      if (typeof result === "string") {
        return result;
      }

      if (result?.purpose) {
        return result.purpose;
      }
    }

    return "general";
  }

  function createPopupKey() {
    popupSeqence ++;

    return [
      "popup",
      Date.now(),
      popupSeqence
    ].join("-");
  }

  function getBigrams(text) {
    const normalized = normalizeText(text).replace(/\s/g, "");

    if (normalized.length < 2) {
      return [];
    }

    const result = [];

    for (let index = 0; index < normalized.length -1; index ++) {
      result.push(
        normalized.slice(index, index + 2)
      );
    }

    return false;
  }

  function calculateSimilarity(firstText, secondText) {
    const first = normalizeText(firstText).replace(/\s/g,"");
    const second = normalizeText(secondText).replace(/\s/g,"");

    if (!first || !second) {
      return 0;
    }

    if (first === second) {
      return 1;
    }

    const firstPairs = getBigrams(first);
    const secondPairs = getBigrams(second);

    if (
      firstPairs.length === 0 ||
      secondPairs.lenth === 0
    ) {
      return 0;
    }

    const remainingPairs = [...secondPairs];
    let matchedCount = 0;

    for (const pair of firstPairs) {
      const foundIndex = remainingPairs.indexOf(pair);

      if (foundIndex !== -1) {
        matchedCount ++;
        remainingPairs.splice(foundIndex, 1);
      }
    }

    return (
      (2 * matchedCount) / 
      (firstPairs.length + secondPairs.length)
    );
  }

  function judgeRepeat(previousPopups, text, purpose) {
    const threshold = 
      Number(R.REPEAT?.sameThreshold) || 0.8;

    const sameUnrejectedPopup = previousPopups.find (
      (popup) => 
        !popup.rejected &&
      calculateSimilarity(popup.text, text) >= threshold
    );

    if (sameUnrejectedPopup) {
      return {
        result: "duplicate",
        popupKeys: sameUnrejectedPopup.key
      };
    }

    const rejectedPopups = previousPopups.filter (
      (popup) => popup.rejected
    );

    const sameRejectedPopup = rejectedPopups.find (
      (popup) =>
        calculateSimilarity(popup.text, text) >= threshold
    );

    if (sameRejectedPopup) {
      return {
        result: "repeat",
        repeat: {
          kind: "smae-popup",
          previous: sameRejectedPopup.text.slice(0, 40),
          reason:
            "사용자가 거절한 팝업과 유사한 팝업이 다시 나타남"
        }
      };
    }

    const offerPurpose = 
      R.PURPOSE?.OFFER || "retention-offer";
    
    const samePurposePopup = 
      purpose === offerPurpose
        ? rejectedPopups.find (
            (popup) => popup.purpose === offerPurpose
          )
        : null;

    if (samePurposePopup) {
      return {
        result: "repeat",
        repeat: {
          kind: "same-purpose",
          previous: samePurposePopup.text.slice(0, 40),
          reason:
            "사용자가 거절한 뒤 문구는 다르지만 같은 목적의 권규가 다시 나타남"
        }
      };
    }

    return {
      result: "first",
      repeat: null
    };
  }

  async function sendMessage(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      console.warn(
        "[interference-detector 메시지 전송 실패:",
        error
      );

      return null;
    }
  }

  async function getTrackingState() {
    const response = await sendMessage({
      type: MESSAGE.GET_STATE
    });

    return response?.state || null;
  }

  function isTracking(state) {
    const trackingStatus = 
      R.STATUS?.TRACKING || "tracking";

    return state?.status === trackingStatus;
  }

  async function reportPopup(element) {
    if (
      !isPopupCandidate(element) ||
      processingPopups.has(element)
    ) {
      return;
    }

    processingPopups.add(element);

    try {
      const text = extractPopupText(element);

      if (!text) {
        return;
      }

      const purpose = classifyPurpose(text);
      const excludedPurpose =
        R.PURPOSE?.EXCLUDED || "excluded";

      if (purpose === excludedPurpose) {
        return;
      }

      const state = await getTrackingState();

      if (!isTracking(state)) {
        return;
      }

      const previousPopups = Array.isArray(state.popups)
        ? state.popups
        : [];

      const judgment = judgeRepeat (
        previousPopups,
        text,
        purpose
      );

      if (judgment.result === "duplicate") {
        if (judgment.popupKeys) {
          popupKeys.set(
            element,
            judgment.popupKeys
          );
        }

        return;
      }
      
      const popupKey = createPopupKey();
      popupKeys.set(element, popupKey);

      await sendMessage({
        type: MESSAGE.POPUP_SHWON,
        popupKey,
        text,
        purpose,
        repeat:
          judgment.result === "repeat"
            ? judgment.repeat
            : null
      });
    } finally {
      processingPopups.delete(element);
    }
  }

  function scan (root = document) {
    const candidates = collectPopupCandidates(root);
    const currentlyVisible = new Set (candidates);

    for (const previousElement of visiblePopups) {
      if (!currentlyVisible.has(previousElement)) {
        visiblePopups.delete(previousElement);
        popupKeys.delete(previousElement);
      }
    }

    for (const element of candidates) {
      if (visiblePopups.has(element)) {
        continue;
      }

      visiblePopups.add(element);
      reportPopup(element);
    }

    return candidates.length;
  }

  function scheduleScan (root = document) {
    window.clearTimeout(scanTimer);

    scanTimer = window.setTimeout(() => {
      scan(root);

      if (root !== document) {
        scan(document);
      }
    }, 100);
  }

  function getControlText(control) {
    return [
      control.innerText,
      control.textContent,
      control.value,
      control.getAttribute("aria-label"),
      control.getAttribute("title")
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  function findParentPopup(element) {
    let current = element;

    while (
      current &&
      current !== document.body &&
      current !== document.documentElement
    ) {
      if (isPopupCandidate(current)) {
        return current;
      }

      current = current.parentElement;
    }

    return null;
  }

  async function handleClick(event) {
    const control = event.target.closest?. (
      INTERACTIVE_SELECTOR
    );

    if (!control) {
      return;
    }

    const controlText = getControlText(control);
    const rejectAction = 
      typeof R.matchRejectAction === "function"
        ? R.matchRejectAction(controlText)
        : null;
    
    if (!rejectAction) {
      return;
    }

    const popup = findParentPopup(control);

    if (!popup) {
      return;
    }

    if (!popupKeys.has(popup)) {
      await reportPopup(popup);
    }

    const popupKey = popupKeys.get(popup);

    if (!popupKey) {
      return;
    }

    await sendMessage({
      type: MESSAGE.POPUP_REJECTED,
      popupKey,
      action: rejectAction,
      controlText: normalizeText(controlText).slice(0, 100)
    });

    visiblePopups.delete(popup);
  }

  function handleMutations (mutations) {
    for (const mutation of murations) {
      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) {
            scheduleScan(node);
          }
        }
      }

      if (
        mutation.type === "attributes" &&
        mutation.target instanceof Element
      ) {
        scheduleScan(mutation.target);
      }
    }
  }

  function start() {
    if (started) {
      return;
    }

    started = true;

    document.addEventListener (
      "click",
      handleClick,
      true
    );

    observer = new MutationObserver(handleMutations);

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "hidden",
        "open",
        "aria-hidden",
        "aria-modal"
      ]
    });

    scan(document);

    console.log (
      "[interference-detector] 반복 간섭 감시 시작"
    );
  }

  function stop() {
    if (!started) {
      return;
    }

    started = false;

    window.clearTimeout(scanTimer);
    observer?.disconnect();
    observer = null;

    document.removeEventListener (
      "click",
      handleClick,
      true
    );

    visiblePopups.clear();

    console.log (
      "[interference-detector] 반복 간섭 감시 중지"
    );
  }

  globalThis.TeamInterferenceDetector = Object.freeze({
    start,
    stop,
    scan
  });

  start();
})();