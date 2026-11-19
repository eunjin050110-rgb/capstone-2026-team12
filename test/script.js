"use strict";

const normalTimerElement =
  document.getElementById("normal-timer");

const resetTimerElement =
  document.getElementById("reset-timer");

const startInterferenceButton =
  document.getElementById("start-interference-test");

const popupRoot =
  document.getElementById("popup-root");

let normalTimerSeconds = 5 * 60;
let resetTimerSeconds = 15 * 60;

function formatTime(totalSeconds) {
  const safeSeconds = Math.max(
    0,
    Math.floor(totalSeconds)
  );

  const hours = String(
    Math.floor(safeSeconds / 3600)
  ).padStart(2, "0");

  const minutes = String(
    Math.floor((safeSeconds % 3600) / 60)
  ).padStart(2, "0");

  const seconds = String(
    safeSeconds % 60
  ).padStart(2, "0");

  return `${hours}:${minutes}:${seconds}`;
}

function renderTimers() {
  normalTimerElement.textContent =
    formatTime(normalTimerSeconds);

  resetTimerElement.textContent =
    formatTime(resetTimerSeconds);
}

function updateTimers() {
  if (normalTimerSeconds > 0) {
    normalTimerSeconds--;
  }

  if (resetTimerSeconds > 0) {
    resetTimerSeconds--;
  }

  renderTimers();
}

function closePopup() {
  popupRoot.replaceChildren();
}

function showSubscriptionPopup() {
  const overlay = document.createElement("div");
  overlay.className = "popup-overlay";

  const dialog = document.createElement("section");
  dialog.className = "offer-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute(
    "aria-labelledby",
    "offer-dialog-title"
  );

  dialog.innerHTML = `
    <h2 id="offer-dialog-title">
      구독 혜택을 포기하시겠어요?
    </h2>

    <p>
      지금 구독하면 첫 달 50% 할인 혜택을 받을 수 있습니다.
      계속 구독하고 특별 혜택을 받아 보세요.
    </p>

    <div class="offer-dialog__actions">
      <button
        type="button"
        class="decline-button"
        data-action="decline"
      >
        아니요, 필요 없어요
      </button>

      <button
        type="button"
        data-action="subscribe"
      >
        혜택 받고 구독하기
      </button>
    </div>
  `;

  overlay.append(dialog);
  popupRoot.replaceChildren(overlay);

  const declineButton =
    dialog.querySelector('[data-action="decline"]');

  const subscribeButton =
    dialog.querySelector('[data-action="subscribe"]');

  declineButton.addEventListener("click", () => {
    closePopup();

    window.setTimeout(() => {
      showSubscriptionPopup();
    }, 1500);
  });

  subscribeButton.addEventListener("click", () => {
    closePopup();
  });
}

startInterferenceButton.addEventListener(
  "click",
  showSubscriptionPopup
);

renderTimers();

window.setInterval(updateTimers, 1000);