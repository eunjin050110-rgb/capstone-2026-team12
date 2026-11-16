(function (root) {
  const R = root.TeamRules;
  let saved = {};   
  const isVisible = (el) => el.offsetWidth > 0 && getComputedStyle(el).visibility !== 'hidden';
  const isSamePage = (a) => a.hash.length > 1 && a.href.split('#')[0] === location.href.split('#')[0];

 
  function getScore(goal, label, a) {
    if (R.hasAny(label, goal.negative)) return -1;
    let score = 0;
    if (R.hasAny(label, goal.words)) score += R.GOAL_NAV.wordScore;
    if (a && R.hasAny(decodeURIComponent(a.pathname).toLowerCase(), goal.urlHints)) score += R.GOAL_NAV.urlScore;
    return score;
  }

  // 최종 실행 
  function isFinalAction(el, label) {
    if (el.tagName !== 'A') return true;
    return R.hasAny(label, R.FINAL_WORDS) || R.FINAL_WORDS.some((w) => el.pathname.toLowerCase().includes(w));
  }

  function findCandidates(goalId) {
    const goal = R.GOALS[goalId];
    saved = {};
    if (!goal) return [];

    const found = [];
    document.querySelectorAll('a[href], button, [role="button"], input[type="submit"], input[type="button"]').forEach((el) => {
      if (el.disabled || !isVisible(el)) return;                      
      const isLink = el.tagName === 'A';
      if (isLink && !/^https?:$/.test(el.protocol)) return;            

      const shown = (el.tagName === 'INPUT' ? el.value : el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 100);
      const label = shown + ' ' + (el.getAttribute('aria-label') || '');
      const score = getScore(goal, label, isLink ? el : null);
      if (score < R.GOAL_NAV.minScore) return;                         

      const final = isFinalAction(el, label);
      found.push({
        el, score, isFinalAction: final,
        label: shown || el.href,
        href: isLink ? el.href : null,
        
        action: !final && isLink && !isSamePage(el) ? 'navigate' : 'locate'
      });
    });

    // 점수 높은 순, 같은 문구+주소는 한 번만, 최대 5개
    found.sort((a, b) => b.score - a.score || a.isFinalAction - b.isFinalAction);
    const seen = new Set();
    return found
      .filter((c) => !seen.has(c.label + c.href) && seen.add(c.label + c.href))
      .slice(0, R.GOAL_NAV.maxCandidates)
      .map((c) => {
        const id = 'gn-' + nextId++;
        saved[id] = c;
        return { id, label: c.label, href: c.href, action: c.action, isFinalAction: c.isFinalAction, score: c.score };
      });
  }


  function activate(id) {
    const c = saved[id];
    if (!c || !c.el.isConnected) return { ok: false, error: '후보를 다시 찾아주세요' };
    if (c.action === 'navigate') return { ok: true, action: 'navigate', url: c.href, label: c.label, isFinalAction: false };

    const target = c.href && isSamePage(c.el) ? document.getElementById(decodeURIComponent(c.el.hash.slice(1))) : null;
    return { ok: true, action: 'locate', element: target || c.el, label: c.label, isFinalAction: c.isFinalAction };
  }

  root.TeamGoalNavigator = { findCandidates, activate };
})(globalThis);