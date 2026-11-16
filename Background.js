importScripts('src/rules.js');
const R = self.TeamRules, M = R.MESSAGE;
 
const host = (url) => new URL(url).hostname.replace(/^www\./, '');            // 사이트 이름
const load = async (id) => (await chrome.storage.session.get('tab' + id))['tab' + id];
const save = (id, s) => chrome.storage.session.set({ ['tab' + id]: s });
 
async function handle(msg, sender) {
  const id = sender.tab ? sender.tab.id : msg.tabId;   
  let s = await load(id);
 
  if (msg.type === M.GET_STATE) return { state: s || { status: R.STATUS.IDLE } };
 
  if (msg.type === M.GOAL_START) {                     // 추적 시작 = 새 기록 만들기
    const tab = await chrome.tabs.get(id);
    s = { goal: msg.goal, goalLabel: R.GOALS[msg.goal].label, status: R.STATUS.TRACKING,
      host: host(tab.url), pagesVisited: 1, popups: [], interferenceCount: 0,
      interferenceEvents: [], navigation: [], notice: '' };
  } else if (msg.type === M.GOAL_STOP) {               // 추적 중단
    if (s) s.status = R.STATUS.STOPPED;
  } else if (!s || s.status !== R.STATUS.TRACKING) {
    return {};                                         // 추적 중이 아니면 기록 안 함
  } else if (msg.type === M.POPUP_SHOWN) {             // 팝업이 떴다
    const text = R.normalizeText(msg.text);
    s.popups.push({ key: msg.popupKey, text: text, purpose: msg.purpose, rejected: false });
    if (msg.repeat) {                                  // 탐지기가 "반복"이라고 판단한 경우
      s.interferenceCount += 1;
      s.interferenceEvents.push({ step: s.interferenceCount, kind: msg.repeat.kind,
        reason: msg.repeat.reason, previous: msg.repeat.previous, current: text.slice(0, 40) });
    }
  } else if (msg.type === M.POPUP_REJECTED) {          // 사용자가 거절했다
    const p = s.popups.filter((x) => !x.rejected && x.key === msg.popupKey).pop();
    if (p) p.rejected = true;
  } else if (msg.type === M.NAV_RECORD) {              // 목표 이동 기록 (최종 버튼은 항상 위치 안내)
    s.navigation.push({ type: msg.isFinalAction ? 'locate' : msg.navType, label: msg.label,
      href: msg.href || null, isFinalAction: !!msg.isFinalAction });
  }
  await save(id, s);
  return { state: s };
}
 
// 메시지를 한 개씩 차례대로 처리한다 (동시에 저장하다 꼬이는 것 방지)
let line = Promise.resolve();
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  line = line.then(() => handle(msg, sender)).catch((e) => ({ error: String(e) })).then(sendResponse);
  return true;
});
 
// 페이지 이동 감시: 같은 사이트면 페이지 수 +1, 다른 사이트면 추적 중단
chrome.tabs.onUpdated.addListener((id, change) => {
  if (!change.url || !change.url.startsWith('http')) return;
  line = line.then(async () => {
    const s = await load(id);
    if (!s || s.status !== R.STATUS.TRACKING) return;
    if (host(change.url) === s.host) s.pagesVisited += 1;
    else { s.status = R.STATUS.OFFSITE; s.notice = '다른 사이트로 이동해서 추적을 멈췄어요. 다시 시작해 주세요.'; }
    await save(id, s);
  }).catch(() => {});
});
 
