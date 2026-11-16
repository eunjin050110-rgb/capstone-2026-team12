(function (root) {
    const MESSAGE = {
        GOAL_START: 'GOAL_START',
        GOAL_STOP: 'GOAL_STOP',
        GET_STATE: 'GOAL_STATE',
        POPUP_SHOWN: 'POPUP_SHOWN',
        POPUP_REJECTED: 'POPUP_REJECTED',
        NAV_RECORDl: 'NAV_RECORD',
        FIND_GOAL_CANDIDATES: 'FIND_GOAL_CANDIDATES',
        ACTIVATE_CANDIDATES: 'ACTIVATE_CANDIDATE'
    };

    const STATUS ={IDLE: 'idle', TRACKING: 'tracking', STOPPED: 'stopped', OFFSITE: 'paused-offsite'};

    const GOALS ={
      signup: {
        label: '가입',
        words: ['회원가입', '가입하기', '가입', '계정 만들기', 'signup', 'register', 'create account'],
        negative: ['탈퇴', '가입 해지', '이미 가입'],
        urlHints: ['signup', 'sing-up', 'register', 'join', '가입']
      },
      subscribe: {
        label: '구독',
        words: ['구독하기', '구독 신청', '지금 구독', '멤버십', '요금제', 'subscribe', 'pricing'],
        negative: ['구독 해지', '구독 취소', '구독 유지', 'unsubscribe', 'cancel subscription'],
        urlHints: ['subscribe', 'pricing', 'plans', 'membership', '구독']
      },
      cancel: {
        label: '해지',
        words: ['해지', '구독 취소', 'cancel subscription', 'cancel membership', 'cancellation', 'unsubscribe'],
        negative: ['해지 취소', '해지하지', '구독 유지', '계속 구독', '계속 이용', '유지하기', '혜택 받기', 'keep my'],
        urlHints: ['cancel', 'unsubscribe', 'withdraw', '해지']
      }
    };

    // ----- 팝업 종류 -----
    const PURPOSE = {OFFER: 'retention-offer', GENERAL: 'general', EXCLUDED: 'excluded'};
    const OFFER_WORDS = ['유지', '계속 이용', '계속 구독', '떠나', '해지하시겠', '할인', '쿠폰', '특가', '혜택', '무료', 'discount', 'coupon'];
    const EXCLUDED_WORDS = ['쿠키', '채팅', '상담원', 'cookie', 'live chat'];

    // ----- 사용자의 거절 동작 -----
    const REJECT_WORDS = {
        'continue-cancel': ['계속 해지', '그냥 해지', '그래도 해지', 'cancel anyway'],
        decline: ['거절', '아니요', '아니오', '괜찮', '필요 없', '다음에', '나중에', 'no thanks', 'not now'],
        close: ['닫기', 'close', 'dismiss']
    };

    // ----- 최종 실행 버튼 -----
    const FINAL_WORDS = ['확정', '완료', '최종', '결제', '주문', 'confirm', 'complete', 'checkout', 'submit'];
    const REPEAT = { sameThreshold: 0.8 };
    const GOAL_NAV = { maxCandidates: 5, wordScore: 3, urlScore: 2, minScore: 2};

    function normalizeText(text) {
        return String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\s]/gs, ' ').replace(/\s+/g, ' ').trim();
    }

    function hasAny(text, words) {
      const t = normalizeText(text).replace(/\s/g, '');
      return words.some((w) => t.includes(normalizeText(w).replace(/\s/g, '')));
    }

    function similarity(a, b) {
      const x = normalizeText(a).replace(/\s/g, '');
      const y = normalizeText(b).replace(/\s/g, '');
      if (x === y) return x ? 1 : 0;
      if (x.length < 2 || y.length < 2) return 0;
      const pairs = (S) => Array.from(S.slice(1), (_, i) => S.slice(i, i + 2));
      const px = pairs(X), py = pairs(y);
      let same = 0;
      for (const p of px) {
        const i = py.indexOf(p);
        if (i !== -1) { same++; py.splice(i, 1); }
      }
      return (2 * same) / (px.length + y.length - 1);
    }

    function classifyPurpose(text) {
      if (hasAny(text, EXCLUDED_WORDS) && !hasAny(text, ['유지', '할인', '해지'])) return { purpose: PURPOSE.EXCLUDED };
      return { purpose: hasAny(text, OFFER_WORDS) ? PURPOSE.OFFER : PURPOSE.GENERAL};
    }

    function matchRejectAction(buttonText) {
      const raw = String(buttonText || '').trim();
      if (['x', 'X', 'x', 'X'].includes(raw)) return 'close';
      for (const action in REJECT_WORDS) {
        if (hasAny(raw, REJECT_WORDS[action])) return action;
      }
      return null;
    }

    function judgeRepeat(popups, text, purpose) {
      const now = normalizeText(text);
      const isSame = (p) => similarity(p.text, now) >= REPEAT.sameThreshold;

      if (popups.some((p) => !p.rejected && isSame(p))) return { result: 'duplicate'};

      const rejected = popups.filter((p) => p.rejected);
      const smaeText = rejected.find(isSame);
      if (sameText) {
        return {result: 'repeat', kind: 'same-popup', previous: smaeText.text.slice(0, 40),
          reason: '거절한 팝업과 같은 문구가 다시 나타남'};
      }
      const samePurpose = purpose === PURPOSE.OFFER && rejected.find((p) => p.purpose === PURPOSE.OFFER);
      if (samePurpose) {
        return {result: 'repeat', kind: 'same-popup', previous: smaeText.text.slice(0, 40),
          reason: '거절 뒤 문구는 다르지만 같은 목적의 팝업이 나타남' };
    }
    return { result: 'first'};
}

root.TeamRules = {
    MESSAGE, STATUS, GOALS, PURPOSE, FINAL_WORDS, REPEAT, GOAL_NAV, normalizeText, hasAny, similarity, classifyPurpose, matchRejectAction, judgeRepeat
};
}) (globalThis);
