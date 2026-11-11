(() => {
  "use strict";

  const OPTINAL_KEYWORDS = [
    "선택",
    "마케팅",
    "광고",
    "이벤트",
    "혜택",
    "수신",
    "부가서비스",
    "부가 서비스",
    "보험",
    "보증",
    "프리미엄",
    "업그레이드",
    "자동갱신",
    "자동 갱신",
    "정기결제",
    "정기 결제"
  ];

    const REQUIRED_KEYWORDS = [
    "필수",
    "필수 동의",
    "서비스 이용을 위해 필요"
  ];

  // 요소가 현재 화면에 표시되는지 확인
  function isVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  // 체크박스와 연결된 label 또는 주변 설명 문구
  function getCheckboxText(checkbox) {
    if (checkbox.labels?.length > 0) {
      const labelText = Array.from(checkbox.labels)
        .map((label) => label.textContent.trim())
        .filter(Boolean)
        .join(" ");

      if (labelText) {
        return normalizeText(labelText);
      }
    }

    if (checkbox.id) {
      const escapedId = CSS.escape(checkbox.id);
      const label = document.querySelector(`label[for="${escapedId}"]`);

      if (label?.textContent) {
        return normalizeText(label.textContent);
      }
    }

    const closestLabel = checkbox.closest("label");

    if (closestLabel?.textContent) {
      return normalizeText(closestLabel.textContent);
    }

    let parent = checkbox.parentElement;
    let depth = 0;

    while (parent && depth < 3) {
      const text = normalizeText(parent.textContent || "");

      if (text) {
        return text.slice(0, 200);
      }

      parent = parent.parentElement;
      depth ++;
    }

    return "";
  }

  function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  function containsKeyword(text, keywords) {
    const normalizedText = text.toLowerCase();

    return keywords.some((keyword) =>
      normalizedText.includes(keyword.toLowerCase())
    );
  }

  // 다른 기능에서 해당 체크박스를 다시 찾을 수 있는 selector 생성
  function getSelector(element) {
    if (element.id) {
      return `#${CSS.escape(element.id)}`;
    }

    if (element.name) {
      const escapedName = CSS.escape(element.name);
      const sameNameElements = document.querySelectorAll(
        `input[type="checkbox"][name="${escapedName}"]`
      );

      if (sameNameElements.length === 1) {
        return `input[type="checkbox"][name="${escapedName}"]`;
      }
    }

    const parts = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let part = current.tagName.toLowerCase();

      if (current.id) {
        part += `#${CSS.escape(current.id)}`;
        parts.unshift(part);
        break;
      }

      const parent = current.parentElement;

      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (sibling) => sibling.tagName === current.tagName
        );

        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }

      parts.unshift(part);
      current = parent;
    }

    return parts.join(" > ");
  }

  // 처음부터 체크되어 있는 선택 항목 후보 반환
  function detectPreselectedCheckboxes() {
    const checkedCheckboxes = document.querySelectorAll(
      'input[type="checkbox"]:checked'
    );

    return Array.from(checkedCheckboxes)
      .filter((checkbox) => {
        if (checkbox.disabled || !isVisible(checkbox)) {
          return false;
        }

        if (
          checkbox.required ||
          checkbox.getAttribute("aria-required") === "true"
        ) {
          return false;
        }

        const text = getCheckboxText(checkbox);

        if (!text) {
          return false;
        }

        if (containsKeyword(text, REQUIRED_KEYWORDS)) {
          return false;
        }

        return containsKeyword(text, OPTINAL_KEYWORDS);
      })
      .map((checkbox) => {
        const label = getCheckboxText(checkbox);

        return {
          type: "PRESELECTED_OPTION",
          label,
          selector: getSelector(checkbox),
          checked: checkbox.checked
        };
      });
  }

  // 파일이 실행된 시점의 상태 저장
  // 사용자가 직접 체크해도 최초 결과 바뀌지 않음
  const initialResults = detectPreselectedCheckboxes();

  // 다른 content script에서 사용할 수 있는 인터페이스
  globalThis.checkboxDetector = {
    detect: detectPreselectedCheckboxes,
    getInitialResults() {
      return [...initialResults];
    }
  };

  // 추후 popup이나 통합 스트립트에서 결과 요청할 때 사용
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type !== "GET_PRESELECTED_CHECKBOXES") {
        return false;
      }

      sendResponse({
        success: true,
        results: [...initialResults]
      });

      return false;
    });
  }

  console.log(
    "[checkbox-detector] 최초 선택 항목 탐지 결과: ",
    initialResults
  );

})();
