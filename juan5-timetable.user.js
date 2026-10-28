// ==UserScript==
// @name         주안초 나이스 시간표 자동 입력시스템
// @namespace    juan-elementary-neis-timetable
// @version      1.2.0
// @description  구글 시트의 주간 시간표를 나이스 [학급담임 > 교육과정 > 시간표관리 > 학급시간표관리]에 자동으로 입력합니다. (프로그램 개발자 : 교사 백천재)
// @author       교사 백천재
// @match        https://*.neis.go.kr/*
// @match        https://neis.go.kr/*
// @noframes
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @updateURL    https://raw.githubusercontent.com/GITHUB_ID/neis-timetable/main/juan5-timetable.user.js
// @downloadURL  https://raw.githubusercontent.com/GITHUB_ID/neis-timetable/main/juan5-timetable.user.js
// @connect      script.google.com
// @connect      script.googleusercontent.com
// ==/UserScript==

(function () {
  'use strict';
  if (window.top !== window.self) return;
  if (window.__JUAN_TT__) return;
  window.__JUAN_TT__ = true;

  const VERSION = '1.2.0';

  // ★ 배포한 Apps Script 웹앱 주소(…/exec)를 여기에 넣으면, 다른 선생님은 주소를 입력하지 않아도 됩니다.
  const DEFAULT_API_URL = '';
  const TITLE = '주안초 나이스 시간표 자동 입력시스템';
  const DEV_CREDIT = '프로그램 개발자 : 교사 백천재';

  /* ═══════════════════ 기본 설정 ═══════════════════ */

  const FIRST_MONDAY = new Date(2026, 7, 17);   // 1주차가 들어 있는 주의 월요일
  const SEMESTER_START = new Date(2026, 7, 18); // 2학기 개학일(1주차 시작)
  const LAST_WEEK = 21;
  const DAYS = ['월', '화', '수', '목', '금'];
  const PERIODS = 6;

  // 시트에 적힌 표기 → 나이스 과목명 앞부분
  const ALIAS = {
    '지율': '자율', '수힉': '수학', '자율활동': '자율', '자율자치': '자율', '자율자치활동': '자율',
    '자치': '자율', '창체': '자율', '동아리활동': '동아리', '진로활동': '진로',
  };
  const SPEEDS = { slow: 1.7, normal: 1, fast: 0.6 };

  const CFG_KEY = 'juan5.cfg';
  const UI_KEY = 'juan5.ui';
  const CACHE_KEY = 'juan5.cache';

  function defaultSpecialists() {
    return [
      { subject: '', teacher: '' }
    ];
  }

  function defaults() {
    return {
      name: '', cls: '', apiUrl: '',
      specialists: defaultSpecialists(),
      speed: 'normal', stopBeforeSave: false, selectFirst: true,
    };
  }
  function readJSON(key, fb) {
    try { const v = GM_getValue(key, ''); return v ? JSON.parse(v) : fb; } catch (e) { return fb; }
  }
  function writeJSON(key, v) { try { GM_setValue(key, JSON.stringify(v)); } catch (e) { /* 무시 */ } }

  // 이전 버전(v1.1.0)의 고정 객체 데이터를 새 배열 형식으로 자동 변환
  function migrateSpecialists(savedObj) {
    if (!savedObj) return defaultSpecialists();
    if (Array.isArray(savedObj.specialists)) {
      return savedObj.specialists.map((s) => ({
        subject: String(s.subject || '').trim(),
        teacher: String(s.teacher || '').trim(),
      }));
    }
    if (savedObj.teachers && typeof savedObj.teachers === 'object') {
      const map = [
        { k: 'moral', label: '도덕' },
        { k: 'science', label: '과학' },
        { k: 'health', label: '체육(보건)' },
        { k: 'english', label: '영어' },
      ];
      const list = [];
      map.forEach((m) => {
        const t = String(savedObj.teachers[m.k] || '').trim();
        if (t) list.push({ subject: m.label, teacher: t });
      });
      return list.length ? list : defaultSpecialists();
    }
    return defaultSpecialists();
  }

  const saved = readJSON(CFG_KEY, null);
  const CFG = Object.assign(defaults(), saved || {});
  CFG.specialists = migrateSpecialists(saved);
  delete CFG.teachers;

  const saveCfg = () => writeJSON(CFG_KEY, CFG);
  const isInstalled = () => !!(CFG.name && CFG.cls);

  const UI = Object.assign({ left: null, top: 72, min: false }, readJSON(UI_KEY, {}));
  const saveUI = () => writeJSON(UI_KEY, UI);

  const CACHE = readJSON(CACHE_KEY, {});

  /* ═══════════════════ 날짜 · 주차 ═══════════════════ */

  const pad = (n) => String(n).padStart(2, '0');
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const fmtDot = (d) => `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}.`;

  function weekRange(n) {
    const mon = addDays(FIRST_MONDAY, 7 * (n - 1));
    const start = n === 1 ? SEMESTER_START : mon;
    return { mon, start, end: addDays(mon, 6) };
  }
  function weekLabel(n) {
    const r = weekRange(n);
    return `${n}주차 (${fmtDot(r.start)}~${fmtDot(r.end)})`;
  }
  function currentWeek() {
    const t = new Date();
    const today = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    const n = Math.floor((today - FIRST_MONDAY) / 86400000 / 7) + 1;
    return Math.min(LAST_WEEK, Math.max(1, n));
  }

  /* ═══════════════════ 시간표 칸 해석 ═══════════════════ */

  // 시트의 과목 칸과 등록된 전담 과목 목록을 비교하여 매칭
  function matchSpecialist(rawClean, base, tag) {
    const list = CFG.specialists || [];
    for (let i = 0; i < list.length; i++) {
      const sp = list[i];
      const sub = String(sp.subject || '').replace(/\s+/g, '');
      if (!sub) continue;

      const sm = sub.match(/^([^(]+)(?:\(([^)]*)\)?)?/);
      const sBase = ALIAS[sm ? sm[1] : sub] || (sm ? sm[1] : sub);
      const sTag = sm && sm[2] ? sm[2] : '';

      // 1) 보건 특수 처리: 전담 과목이 '보건' 또는 '체육(보건)'/'체육(보)' 형태일 때
      if ((sBase === '보건' || (sBase === '체육' && /^보/.test(sTag))) &&
          (base === '보건' || (base === '체육' && /^보/.test(tag)))) {
        return i;
      }
      // 2) 괄호 태그까지 지정한 전담 과목인 경우 (예: 실과(코))
      if (sTag) {
        if (sBase === base && tag && (tag.startsWith(sTag) || sTag.startsWith(tag))) {
          return i;
        }
        continue;
      }
      // 3) 일반 과목명 일치 (예: 도덕, 과학, 영어, 음악, 미술, 체육 등)
      if (sBase === base) {
        // 단, 시트에 '체육(보)'라고 적혔는데 일반 '체육' 전담과 매칭하려는 경우, 별도 보건 전담이 있으면 건너뜀
        if (base === '체육' && /^보/.test(tag)) {
          const hasHealth = list.some((x) => {
            const xs = String(x.subject || '').replace(/\s+/g, '');
            return xs === '보건' || /^체육\(보/.test(xs);
          });
          if (hasHealth) continue;
        }
        return i;
      }
    }
    return -1;
  }

  // "(자매) 국어"→국어, "체육(보)"→체육·보건전담, "실과(코)"→실과·담임 …
  function parseCell(raw) {
    let s = String(raw || '').trim();
    if (!s) return null;
    s = s.replace(/^\([^)]*\)\s*/, '').replace(/\s+/g, '');
    if (!s) return null;
    const m = s.match(/^([^(]+)(?:\(([^)]*)\)?)?/);
    let base = m ? m[1] : s;
    const tag = m && m[2] ? m[2] : '';
    base = ALIAS[base] || base;

    const spIdx = matchSpecialist(s, base, tag);
    // 나이스 우클릭 메뉴에서는 보건도 '체육' 과목명으로 들어감
    const neisBase = base === '보건' ? '체육' : base;
    const who = spIdx >= 0 ? `sp:${spIdx}` : 'homeroom';

    return { raw: String(raw).trim(), base: neisBase, tag, who, spIdx };
  }

  function teacherOf(who) {
    if (who === 'homeroom') return CFG.name || '';
    if (typeof who === 'string' && who.startsWith('sp:')) {
      const idx = Number(who.slice(3));
      return (CFG.specialists[idx] && CFG.specialists[idx].teacher) || '';
    }
    return '';
  }

  function whoLabel(who) {
    if (who === 'homeroom') return '담임';
    if (typeof who === 'string' && who.startsWith('sp:')) {
      const idx = Number(who.slice(3));
      const sp = CFG.specialists[idx];
      return sp && sp.subject ? `${sp.subject} 전담` : '전담';
    }
    return '전담';
  }

  // 월요일 1교시 → 6교시, 화요일 1교시 → … 금요일 6교시 순서
  function buildPlan(data) {
    const plan = [];
    for (let d = 0; d < 5; d++) {
      for (let p = 0; p < PERIODS; p++) {
        const c = parseCell(data.grid[p] && data.grid[p][d]);
        if (c) plan.push(Object.assign({ d, p: p + 1, teacher: teacherOf(c.who) }, c));
      }
    }
    return plan;
  }

  /* ═══════════════════ 시트 불러오기 ═══════════════════ */

  const apiBase = () => (CFG.apiUrl || DEFAULT_API_URL || '').trim();

  function api(params, baseUrl) {
    return new Promise((resolve, reject) => {
      const base = String(baseUrl || apiBase()).trim();
      if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(base)) {
        reject(new Error('시트 연결 주소(Apps Script 웹앱 주소)가 없습니다. [설정]에서 입력해 주세요.'));
        return;
      }
      const url = base + (base.includes('?') ? '&' : '?') + new URLSearchParams(params).toString();
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: 45000,
        onload: (r) => {
          let j;
          try { j = JSON.parse(r.responseText); } catch (e) {
            reject(new Error('시트 응답을 읽지 못했습니다. 웹앱을 "액세스: 모든 사용자"로 배포했는지 확인해 주세요.'));
            return;
          }
          if (j.ok) resolve(j); else reject(new Error(j.error || '알 수 없는 오류'));
        },
        onerror: () => reject(new Error('시트 서버에 연결하지 못했습니다.')),
        ontimeout: () => reject(new Error('시트 응답 시간이 초과되었습니다.')),
      });
    });
  }

  const cacheKey = (w) => `${w}-${CFG.cls}`;
  async function loadWeek(force) {
    const w = STATE.week;
    const hit = CACHE[cacheKey(w)];
    if (!force && hit && Date.now() - (hit.fetchedAt || 0) < 10 * 60 * 1000) { STATE.error = ''; render(); return; }
    STATE.loading = true; STATE.error = ''; render();
    try {
      const data = await api({ week: w, class: CFG.cls });
      CACHE[cacheKey(w)] = Object.assign(data, { fetchedAt: Date.now() });
      const keys = Object.keys(CACHE).sort((a, b) => CACHE[b].fetchedAt - CACHE[a].fetchedAt);
      keys.slice(30).forEach((k) => delete CACHE[k]);
      writeJSON(CACHE_KEY, CACHE);
    } catch (e) {
      if (STATE.week === w) STATE.error = e.message;
    } finally {
      if (STATE.week === w) STATE.loading = false;
      render();
    }
  }
  const currentData = () => (STATE.loading ? null : CACHE[cacheKey(STATE.week)] || null);

  /* ═══════════════════ 로그 ═══════════════════ */

  const LOG = [];
  function log(msg, kind) {
    const t = new Date();
    const line = { text: `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())} ${msg}`, kind: kind || '' };
    LOG.push(line);
    if (LOG.length > 400) LOG.shift();
    try { console.log('[시간표 입력]', msg); } catch (e) { /* 무시 */ }
    const box = ROOT && ROOT.querySelector('.log');
    if (box) {
      const div = document.createElement('div');
      div.className = line.kind; div.textContent = line.text;
      box.appendChild(div); box.scrollTop = box.scrollHeight;
    }
  }
  function setProgress(done, total) {
    STATE.progress = total ? done / total : 0;
    const bar = ROOT && ROOT.querySelector('.bar');
    if (bar) bar.style.width = Math.round(STATE.progress * 100) + '%';
  }

  /* ═══════════════════ 화면 조작 도구 ═══════════════════ */

  class Stopped extends Error {}
  let RUN = null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function checkStop() { if (RUN && RUN.stopped) throw new Stopped('중지'); }
  async function pause(ms) {
    const end = Date.now() + ms * (SPEEDS[CFG.speed] || 1);
    while (Date.now() < end) { checkStop(); await sleep(Math.min(100, end - Date.now())); }
    checkStop();
  }
  async function waitFor(fn, timeout, interval) {
    const end = Date.now() + (timeout || 5000) * Math.max(1, SPEEDS[CFG.speed] || 1);
    for (;;) {
      checkStop();
      let v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v && (!Array.isArray(v) || v.length)) return v;
      if (Date.now() > end) return null;
      await sleep(interval || 150);
    }
  }

  const clean = (s) => String(s || '').replace(/[\s\u200b-\u200d\u2060\ufeff]+/g, '');

  function allDocs() {
    const out = [];
    const walk = (doc, depth) => {
      if (!doc || out.includes(doc)) return;
      out.push(doc);
      if (depth > 4) return;
      doc.querySelectorAll('iframe,frame').forEach((f) => {
        try { if (f.contentDocument && f.contentDocument.body) walk(f.contentDocument, depth + 1); } catch (e) { /* 다른 도메인 */ }
      });
    };
    walk(document, 0);
    return out;
  }

  function visible(el) {
    if (!el || !el.isConnected || (HOST && HOST.contains(el))) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.right <= 0 || r.bottom < -3000) return false;
    const win = el.ownerDocument.defaultView;
    const cs = win.getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    for (let a = el, i = 0; a && i < 10; a = a.parentElement, i++) {
      if (win.getComputedStyle(a).opacity === '0') return false;
    }
    return true;
  }
  function inView(el) {
    const r = el.getBoundingClientRect(); const w = el.ownerDocument.defaultView;
    return r.bottom > 0 && r.right > 0 && r.top < w.innerHeight && r.left < w.innerWidth;
  }
  function center(el) { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

  // 글자를 직접 가진 요소들 중 조건에 맞고 화면에 보이는 것
  function findText(test) {
    const out = [];
    const isStr = typeof test === 'string';
    const target = isStr ? clean(test) : '';
    for (const doc of allDocs()) {
      if (!doc.body) continue;
      const tw = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      const seen = new Set();
      let n;
      while ((n = tw.nextNode())) {
        if (!n.nodeValue || !n.nodeValue.trim()) continue;
        const el = n.parentElement;
        if (!el || seen.has(el)) continue;
        seen.add(el);
        if (/^(SCRIPT|STYLE|NOSCRIPT|OPTION|TEXTAREA)$/.test(el.tagName)) continue;
        const t = clean(el.textContent);
        if (t.length > 200) continue;
        const ok = isStr ? t === target : (test instanceof RegExp ? test.test(t) : test(t, el));
        if (ok && visible(el)) out.push(el);
      }
    }
    return out;
  }
  const innermost = (list) => list.filter((a) => !list.some((b) => b !== a && a.contains(b)));
  function pick(list) { if (!list || !list.length) return null; return list.find(inView) || list[0]; }
  function closestTo(list, pt) {
    if (!list.length) return null;
    if (!pt) return pick(list);
    return list.slice().sort((a, b) => {
      const ca = center(a), cb = center(b);
      return Math.hypot(ca.x - pt.x, ca.y - pt.y) - Math.hypot(cb.x - pt.x, cb.y - pt.y);
    })[0];
  }
  // 글자가 정확히 같은 것 → 없으면 그 글자를 포함하는 짧은 것
  function findLoose(label) {
    const exact = innermost(findText(label));
    if (exact.length) return exact;
    const key = clean(label);
    return innermost(findText((t) => t.includes(key) && t.length <= key.length + 8))
      .sort((a, b) => clean(a.textContent).length - clean(b.textContent).length);
  }

  // 펼쳐진 메뉴에서 "머리글(교육과정) 아래 같은 열"에 있는 항목(시간표관리)을 찾음
  function findMenuItem(label, headLabel) {
    const key = clean(label);
    const heads = innermost(findText(headLabel)).filter(inView);
    let cands = innermost(findText((t) => t.includes(key) && t.length <= key.length + 20));
    if (heads.length) {
      let best = null, bd = Infinity;
      cands.forEach((c) => {
        const cc = center(c);
        heads.forEach((h) => {
          if (h.ownerDocument !== c.ownerDocument) return;
          const hr = h.getBoundingClientRect(), hc = center(h);
          if (cc.y < hc.y - 5 || Math.abs(cc.x - hc.x) > Math.max(90, hr.width)) return;
          const d = cc.y - hc.y + Math.abs(cc.x - hc.x);
          if (d < bd) { bd = d; best = c; }
        });
      });
      if (best) return best;
    }
    for (const h of heads) {
      const r = h.getBoundingClientRect(), doc = h.ownerDocument;
      for (let dy = 14; dy <= 420; dy += 5) {
        for (const dx of [10, 24]) {
          const t = hitAt(doc, r.left + dx, r.top + r.height / 2 + dy);
          for (let a = t, i = 0; a && i < 5; a = a.parentElement, i++) {
            const tx = clean(a.textContent);
            if (tx.length > key.length + 20) break;
            if (tx.includes(key)) return a;
          }
        }
      }
    }
    if (!heads.length && cands.length) return pick(cands);
    return null;
  }

  function dumpNear(word) {
    const key = clean(word); let n = 0;
    for (const doc of allDocs()) {
      const tw = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT); let t;
      while ((t = tw.nextNode()) && n < 8) {
        if (!clean(t.nodeValue).includes(key) && !(t.parentElement && clean(t.parentElement.textContent).includes(key) && clean(t.parentElement.textContent).length < 30)) continue;
        const el = t.parentElement; if (!el || (HOST && HOST.contains(el))) continue;
        const r = el.getBoundingClientRect();
        log(`  · ${describe(el)} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} ${visible(el) ? '보임' : '숨김'}`);
        n++;
      }
    }
    if (!n) log('  · "' + word + '"이(가) 들어간 글자가 화면에 없습니다.');
  }

  const BTN_SEL = 'button,[role="button"],a,input[type="button"],input[type="submit"],[class*="btn"],[class*="Btn"],[class*="button"],[class*="Button"]';
  function pickButton(list, nearPt) {
    if (!list.length) return null;
    const vis = list.filter(inView);
    let pool = vis.length ? vis : list;
    const btns = pool.filter((e) => e.closest(BTN_SEL));
    if (btns.length) pool = btns;
    if (nearPt) return closestTo(pool, nearPt);
    return pool.slice().sort((a, b) => center(b).x - center(a).x)[0];
  }

  function hitAt(doc, x, y) {
    const prev = HOST.style.visibility;
    HOST.style.visibility = 'hidden';
    try { return doc.elementFromPoint(x, y); } finally { HOST.style.visibility = prev; }
  }

  function fire(el, type, x, y, button) {
    const win = el.ownerDocument.defaultView;
    const down = /down$/.test(type);
    const opts = {
      bubbles: true, cancelable: true, composed: true, view: win, detail: 1,
      clientX: x, clientY: y, screenX: x + (win.screenX || 0), screenY: y + (win.screenY || 0),
      button: button || 0, buttons: down ? (button === 2 ? 2 : 1) : 0,
    };
    let ev;
    if (/^pointer/.test(type) && win.PointerEvent) {
      ev = new win.PointerEvent(type, Object.assign(opts, { pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    } else {
      ev = new win.MouseEvent(type, opts);
    }
    el.dispatchEvent(ev);
  }
  function mouseSeq(t, x, y, button) {
    ['pointerover', 'mouseover', 'pointerenter', 'mouseenter', 'pointermove', 'mousemove']
      .forEach((tp) => fire(t, tp, x, y, 0));
    fire(t, 'pointerdown', x, y, button); fire(t, 'mousedown', x, y, button);
    if (button !== 2) {
      try { const f = t.closest('button,a,input,[tabindex]'); if (f && f.focus) f.focus({ preventScroll: true }); } catch (e) { /* 무시 */ }
    }
    fire(t, 'pointerup', x, y, button); fire(t, 'mouseup', x, y, button);
    if (button === 2) fire(t, 'contextmenu', x, y, 2);
    else fire(t, 'click', x, y, 0);
  }
  async function clickEl(el) {
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* 무시 */ }
    await sleep(60);
    const { x, y } = center(el);
    let t = hitAt(el.ownerDocument, x, y);
    if (!t || !(t === el || el.contains(t) || t.contains(el))) t = el;
    mouseSeq(t, x, y, 0);
  }
  function clickPoint(doc, x, y) { const t = hitAt(doc, x, y); if (t) mouseSeq(t, x, y, 0); return t; }
  function rightClickPoint(doc, x, y) { const t = hitAt(doc, x, y); if (t) mouseSeq(t, x, y, 2); return t; }
  function pressEscape(doc) {
    const d = doc || document;
    const t = d.activeElement || d.body;
    ['keydown', 'keyup'].forEach((tp) => {
      t.dispatchEvent(new (d.defaultView.KeyboardEvent)(tp, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
    });
  }
  function describe(el) {
    if (!el) return '-';
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    return `<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}> "${clean(el.textContent).slice(0, 30)}"`;
  }

  /* ═══════════════════ 나이스 화면 찾기 ═══════════════════ */

  const DAY_RE = /^(?:\d{4}[./-])?(?:\d{1,2}[./-]\d{1,2}\.?)?\(?([월화수목금])(?:요일)?\)?(?:\(?[\d./-]{1,10}\)?)?$/;

  function findSearchButton() {
    let list = findText('조회');
    if (!list.length) {
      list = [];
      for (const doc of allDocs()) {
        doc.querySelectorAll('[title*="조회"],[aria-label*="조회"],[alt*="조회"],[class*="search" i],[class*="inquiry" i]')
          .forEach((e) => { if (visible(e)) list.push(e); });
      }
    }
    return pickButton(innermost(list));
  }

  function weekPatterns(n) {
    const r = weekRange(n);
    const ds = [r.start, r.mon].filter((d, i, a) => a.findIndex((x) => +x === +d) === i);
    const out = [];
    ds.forEach((d) => {
      const y = d.getFullYear(), m = pad(d.getMonth() + 1), dd = pad(d.getDate());
      out.push(`${y}.${m}.${dd}`, `${y}-${m}-${dd}`, `${y}/${m}/${dd}`, `${y}년${m}월${dd}일`, `${y}년${d.getMonth() + 1}월${d.getDate()}일`);
    });
    return out;
  }
  function findWeekItem(n) {
    const pats = weekPatterns(n);
    let list = innermost(findText((t) => pats.some((p) => t.includes(p))));
    if (!list.length) {
      const re = new RegExp('^' + n + '주(차)?(?!\\d)');
      list = innermost(findText((t) => re.test(t)));
    }
    if (!list.length) return null;
    const inRow = list.filter((e) => e.closest('[role="row"],[role="gridcell"],[role="option"],tr,li,[class*="row"],[class*="Row"],[class*="item"],[class*="cell"]'));
    return pick(inRow.length ? inRow : list);
  }
  async function scrollFindWeek(n) {
    const dates = innermost(findText(/20\d\d[.\-/]\d\d[.\-/]\d\d/));
    let box = null;
    for (const e of dates) {
      for (let a = e.parentElement; a && a !== a.ownerDocument.body; a = a.parentElement) {
        const cs = a.ownerDocument.defaultView.getComputedStyle(a);
        if (a.scrollHeight > a.clientHeight + 8 && /(auto|scroll)/.test(cs.overflowY)) { box = a; break; }
      }
      if (box) break;
    }
    const wheelTarget = box || (dates[0] && dates[0].parentElement);
    if (!wheelTarget) return null;
    if (box) { box.scrollTop = 0; await pause(250); }
    for (let i = 0; i < 25; i++) {
      const hit = findWeekItem(n);
      if (hit) return hit;
      const c = center(wheelTarget);
      const win = wheelTarget.ownerDocument.defaultView;
      wheelTarget.dispatchEvent(new win.WheelEvent('wheel', { deltaY: 120, deltaMode: 0, clientX: c.x, clientY: c.y, bubbles: true, cancelable: true }));
      if (box) box.scrollTop += Math.max(40, box.clientHeight * 0.7);
      await pause(300);
    }
    return findWeekItem(n);
  }

  function lca(a, b) {
    const s = new Set();
    for (let x = a; x; x = x.parentElement) s.add(x);
    for (let y = b; y; y = y.parentElement) if (s.has(y)) return y;
    return null;
  }
  function findPeriods(t) {
    const mon = center(t.days[0]);
    const doc = t.days[0].ownerDocument;
    for (const re of [/^([1-9])교시/, /^([1-7])$/]) {
      const cands = innermost(findText(re))
        .filter((e) => e.ownerDocument === doc)
        .map((e) => ({ e, c: center(e), n: Number(clean(e.textContent).match(re)[1]) }))
        .filter((o) => (t.orient === 'h' ? (o.c.x < mon.x - 5 && o.c.y > mon.y + 5) : (o.c.y < mon.y - 5 && o.c.x > mon.x + 5)));
      const groups = [];
      for (const o of cands) {
        const k = t.orient === 'h' ? o.c.x : o.c.y;
        let g = groups.find((x) => Math.abs(x.k - k) < 24);
        if (!g) { g = { k, items: [] }; groups.push(g); }
        g.items.push(o);
      }
      groups.forEach((g) => { g.size = new Set(g.items.map((o) => o.n)).size; });
      const g = groups.filter((x) => x.size >= 4).sort((a, b) => b.k - a.k)[0];
      if (!g) continue;
      const periods = {};
      for (let p = 1; p <= PERIODS; p++) {
        const it = g.items.filter((o) => o.n === p)
          .sort((a, b) => (t.orient === 'h' ? a.c.y - b.c.y : a.c.x - b.c.x))[0];
        if (it) periods[p] = it.e;
      }
      if (Object.keys(periods).length >= 4) return periods;
    }
    return null;
  }
  function detectGrid() {
    const byDay = { 월: [], 화: [], 수: [], 목: [], 금: [] };
    innermost(findText(DAY_RE)).forEach((e) => {
      const m = clean(e.textContent).match(DAY_RE);
      if (m) byDay[m[1]].push(e);
    });
    for (const mon of byDay['월']) {
      for (const orient of ['h', 'v']) {
        const seq = [mon];
        let ok = true;
        for (const d of ['화', '수', '목', '금']) {
          const pc = center(seq[seq.length - 1]);
          const next = byDay[d].filter((e) => e.ownerDocument === mon.ownerDocument)
            .map((e) => ({ e, c: center(e) }))
            .filter((o) => (orient === 'h'
              ? Math.abs(o.c.y - pc.y) < 12 && o.c.x > pc.x + 8
              : Math.abs(o.c.x - pc.x) < 12 && o.c.y > pc.y + 8))
            .sort((a, b) => (orient === 'h' ? a.c.x - b.c.x : a.c.y - b.c.y))[0];
          if (!next) { ok = false; break; }
          seq.push(next.e);
        }
        if (!ok) continue;
        const t = { orient, days: seq };
        const periods = findPeriods(t);
        if (!periods) continue;
        let root = lca(seq[0], periods[Object.keys(periods)[0]]);
        const doc = mon.ownerDocument;
        if (root === doc.body || root === doc.documentElement) root = null;
        return { orient, days: seq, periods, root, doc };
      }
    }
    return null;
  }
  function cellPoint(g, d, p) {
    const de = g.days[d], pe = g.periods[p];
    if (!de || !pe || !de.isConnected || !pe.isConnected) return null;
    const dc = center(de), pc = center(pe);
    return g.orient === 'h' ? { x: dc.x, y: pc.y } : { x: pc.x, y: dc.y };
  }
  function cellText(g, pt) {
    let e = hitAt(g.doc, pt.x, pt.y);
    if (!e) return '';
    let t = clean(e.textContent);
    for (let i = 0; i < 2 && e.parentElement && t.length < 2; i++) { e = e.parentElement; t = clean(e.textContent); }
    return t.length > 60 ? '' : t;
  }

  function menuCandidates(key) {
    return innermost(findText((t) => t.startsWith(key) && t.length <= 60));
  }
  function itemText(el, key) {
    let best = clean(el.textContent);
    let x = el;
    for (let i = 0; i < 3 && x.parentElement; i++) {
      x = x.parentElement;
      const t = clean(x.textContent);
      if (t.length > 60 || !t.startsWith(key)) break;
      best = t;
    }
    return best;
  }

  /* ═══════════════════ 입력 단계 ═══════════════════ */

  async function stepNavigate() {
    let target = pick(findLoose('학급시간표관리'));
    if (!target) {
      log('메뉴 → 학급담임');
      const homeroom = await waitFor(() => pick(findLoose('학급담임')), 4000);
      if (!homeroom) throw new Error('상단 메뉴에서 "학급담임"을 찾지 못했습니다.');
      await clickEl(homeroom);
      await pause(800);

      log('메뉴 → 교육과정 > 시간표관리');
      const findTm = () => findMenuItem('시간표관리', '교육과정');
      let tm = await waitFor(findTm, 2500);
      if (!tm) {
        const cur = pick(findLoose('교육과정'));
        if (cur) { await clickEl(cur); await pause(600); }
        tm = await waitFor(findTm, 3000);
      }
      if (!tm) { dumpNear('시간표'); throw new Error('"교육과정 > 시간표관리" 메뉴를 찾지 못했습니다.'); }
      await clickEl(tm);
      await pause(1000);

      target = await waitFor(() => pick(findLoose('학급시간표관리')), 8000);
      if (!target) throw new Error('왼쪽 메뉴에서 "학급시간표관리"를 찾지 못했습니다.');
    }
    log('메뉴 → 학급시간표관리');
    await clickEl(target);
    await pause(1500);
  }

  async function stepSearch() {
    const btn = await waitFor(findSearchButton, 8000);
    if (!btn) throw new Error('돋보기 [조회] 버튼을 찾지 못했습니다.');
    STATE.searchPt = center(btn);
    log('조회 버튼 클릭');
    await clickEl(btn);
    await pause(1500);
  }

  async function stepSelectWeek(n) {
    let item = await waitFor(() => findWeekItem(n), 6000);
    if (!item) item = await scrollFindWeek(n);
    if (!item) throw new Error(`화면에서 ${weekLabel(n)} 항목을 찾지 못했습니다.`);
    log(`주차 선택 → ${clean(item.textContent).slice(0, 40)}`);
    await clickEl(item);
    await pause(1800);
  }

  async function stepDetectGrid() {
    const g = await waitFor(detectGrid, 8000, 300);
    if (!g) throw new Error('시간표 표(월~금, 1~6교시 머리글)를 찾지 못했습니다. [화면 진단] 결과를 보내 주세요.');
    try { g.days[0].scrollIntoView({ block: 'nearest' }); } catch (e) { /* 무시 */ }
    await pause(200);
    log(`시간표 표 확인 (교시 ${Object.keys(g.periods).join('·')})`);
    return g;
  }

  async function refreshGrid(g) {
    const alive = g.days.every((e) => e.isConnected && visible(e)) &&
      Object.values(g.periods).every((e) => e.isConnected && visible(e));
    if (alive) return true;
    const ng = await waitFor(detectGrid, 4000, 200);
    if (!ng) return false;
    Object.assign(g, ng);
    return true;
  }

  async function fillCell(g, it) {
    const key = clean(it.base);
    const teacher = clean(it.teacher);
    if (!(await refreshGrid(g))) return { ok: false, why: '시간표 표를 다시 찾지 못함' };
    let pt = cellPoint(g, it.d, it.p);
    if (!pt) return { ok: false, why: `${it.p}교시 줄을 찾지 못함` };
    const win = g.doc.defaultView;
    if (pt.y < 4 || pt.y > win.innerHeight - 4 || pt.x < 4 || pt.x > win.innerWidth - 4) {
      try { g.periods[it.p].scrollIntoView({ block: 'center' }); } catch (e) { /* 무시 */ }
      await pause(300);
      pt = cellPoint(g, it.d, it.p);
      if (!pt) return { ok: false, why: '칸 위치를 다시 찾지 못함' };
    }

    if (CFG.selectFirst) { clickPoint(g.doc, pt.x, pt.y); await pause(150); }

    const before = new Set(menuCandidates(key));
    rightClickPoint(g.doc, pt.x, pt.y);

    const outside = (e) => !g.root || !g.root.contains(e);
    let found = await waitFor(() => {
      const all = menuCandidates(key);
      const fresh = all.filter((e) => !before.has(e));
      const a = fresh.filter(outside);
      return a.length ? a : (fresh.length ? fresh : null);
    }, 2500);
    if (!found) found = menuCandidates(key).filter(outside);
    if (!found || !found.length) {
      pressEscape(g.doc);
      return { ok: false, why: `우클릭 메뉴에서 "${it.base}" 과목을 찾지 못함` };
    }

    let pickList = teacher ? found.filter((e) => itemText(e, key).includes(teacher)) : [];
    if (!pickList.length && it.who === 'homeroom' && found.length === 1) pickList = found;
    if (!pickList.length) {
      pressEscape(g.doc);
      const names = [...new Set(found.map((e) => itemText(e, key)))].slice(0, 4).join(', ');
      return { ok: false, why: `"${it.base}" 중 "${it.teacher || '(이름 미입력)'}" 선생님 항목이 없음 [메뉴: ${names}]` };
    }
    const target = closestTo(pickList, pt);
    const chosen = itemText(target, key);
    await clickEl(target);
    await pause(350);
    if (found.some((e) => visible(e))) { pressEscape(g.doc); await pause(120); }

    const now = cellText(g, pt);
    const verified = now ? now.includes(key) : null;
    return { ok: true, chosen, verified };
  }

  async function stepFill(g, plan) {
    const fails = [];
    let done = 0;
    setProgress(0, plan.length);
    for (const it of plan) {
      checkStop();
      const pos = `${DAYS[it.d]}${it.p}`;
      let r;
      try { r = await fillCell(g, it); } catch (e) {
        if (e instanceof Stopped) throw e;
        r = { ok: false, why: e.message };
      }
      if (r.ok) {
        log(`✓ ${pos} ${it.raw} → ${r.chosen}${r.verified === false ? ' (칸 표시 확인 필요)' : ''}`, r.verified === false ? 'warn' : 'ok');
      } else {
        fails.push(`${pos} ${it.raw}`);
        log(`✗ ${pos} ${it.raw}: ${r.why}`, 'err');
      }
      setProgress(++done, plan.length);
      await pause(200);
    }
    return fails;
  }

  async function stepSave() {
    const saveBtn = pickButton(innermost(findText('저장')), STATE.searchPt || null);
    if (!saveBtn) throw new Error('[저장] 버튼을 찾지 못했습니다. 직접 눌러 주세요.');
    const beforeOk = new Set(findText('확인'));
    log('저장 버튼 클릭');
    await clickEl(saveBtn);

    const msg = await waitFor(() => pick(findText((t) => t.includes('저장하시겠습니까'))), 5000);
    if (!msg) log('"저장하시겠습니까?" 문구는 찾지 못해 새로 뜬 [확인] 버튼을 찾습니다.', 'warn');
    const okBtn = await waitFor(() => {
      const c = innermost(findText('확인')).filter((e) => !beforeOk.has(e));
      return c.length ? closestTo(c, msg ? center(msg) : null) : null;
    }, 5000);
    if (!okBtn) throw new Error('저장 확인 창의 [확인] 버튼을 찾지 못했습니다. 직접 눌러 주세요.');
    const beforeOk2 = new Set(findText('확인'));
    log('확인 버튼 클릭');
    await clickEl(okBtn);

    const res = await waitFor(() => pick(findText((t) => /저장되었|저장하였|처리되었|완료되었|정상적으로/.test(t) && t.length < 80)), 6000);
    if (res) {
      log('나이스: ' + clean(res.textContent).slice(0, 50), 'ok');
      const ok2 = await waitFor(() => {
        const c = innermost(findText('확인')).filter((e) => !beforeOk2.has(e));
        return c.length ? closestTo(c, center(res)) : null;
      }, 1500);
      if (ok2) await clickEl(ok2);
    } else {
      const err = pick(findText((t) => /오류|실패|할 수 없|불가/.test(t) && t.length < 120));
      if (err) log('나이스 메시지: ' + clean(err.textContent).slice(0, 80), 'warn');
    }
  }

  async function run() {
    const data = currentData();
    if (!data) { alert('먼저 주차를 선택해 시간표를 불러와 주세요.'); return; }
    const plan = buildPlan(data);
    if (!plan.length) { alert('입력할 시간표 칸이 없습니다.'); return; }
    const missing = [...new Set(plan.filter((it) => !it.teacher).map((it) => whoLabel(it.who)))];
    if (missing.length) { alert(`다음 선생님 이름이 비어 있습니다: ${missing.join(', ')}\n먼저 이름을 입력해 주세요.`); return; }
    if (!confirm(`${weekLabel(STATE.week)}\n${CFG.cls}반 시간표 ${plan.length}칸을 나이스에 입력합니다.\n\n진행되는 동안에는 나이스 화면을 클릭하지 말아 주세요.`)) return;

    RUN = { stopped: false };
    STATE.running = true; STATE.searchPt = null;
    render();
    const t0 = Date.now();
    try {
      log(`▶ ${weekLabel(STATE.week)} ${CFG.cls}반 입력 시작 (${plan.length}칸)`);
      await stepNavigate();
      await stepSearch();
      await stepSelectWeek(STATE.week);
      const g = await stepDetectGrid();
      const fails = await stepFill(g, plan);
      if (fails.length) {
        log(`입력하지 못한 칸 ${fails.length}개: ${fails.join(', ')}`, 'err');
        log('잘못 저장되지 않도록 저장하지 않았습니다. 위 칸을 직접 고친 뒤 [저장]을 눌러 주세요.', 'warn');
      } else if (CFG.stopBeforeSave) {
        log('⏸ 입력을 마쳤습니다. 화면을 확인한 뒤 [저장]을 직접 눌러 주세요.', 'ok');
      } else {
        await stepSave();
        log(`■ 완료 (${Math.round((Date.now() - t0) / 1000)}초)`, 'ok');
      }
    } catch (e) {
      if (e instanceof Stopped) log('■ 중지했습니다.', 'warn');
      else log('✗ ' + e.message, 'err');
    } finally {
      RUN = null;
      STATE.running = false;
      render();
    }
  }

  /* ═══════════════════ 화면 진단 ═══════════════════ */

  function diagnose() {
    const L = [];
    L.push(`[${TITLE} v${VERSION} 진단] ${new Date().toLocaleString()}`);
    L.push('주소: ' + location.href.split('?')[0]);
    L.push('화면 문서 수(프레임 포함): ' + allDocs().length);
    ['학급담임', '교육과정', '시간표관리', '학급시간표관리', '저장'].forEach((k) => {
      const c = findLoose(k);
      L.push(`${k}: ${c.length}개 ${c[0] ? describe(c[0]) : ''}`);
    });
    L.push('조회 버튼: ' + describe(findSearchButton()));
    const w = findWeekItem(STATE.week);
    L.push(`주차 항목(${STATE.week}주차): ${w ? describe(w) : '못 찾음'}`);
    const dates = innermost(findText(/20\d\d[.\-/]\d\d[.\-/]\d\d/)).slice(0, 4);
    if (dates.length) L.push('날짜 글자 예: ' + dates.map((e) => `"${clean(e.textContent).slice(0, 26)}"`).join(', '));
    const g = detectGrid();
    if (g) {
      L.push(`시간표 표: 찾음 (요일 ${g.orient === 'h' ? '가로' : '세로'} 배치, 교시 ${Object.keys(g.periods).join('·')})`);
      L.push('  요일 머리글: ' + g.days.map((e) => `"${clean(e.textContent)}"`).join(' '));
      const pt = cellPoint(g, 0, 1);
      if (pt) L.push(`  월1 칸: ${describe(hitAt(g.doc, pt.x, pt.y))}`);
    } else {
      const ds = innermost(findText(DAY_RE)).slice(0, 8).map((e) => `"${clean(e.textContent)}"`);
      L.push('시간표 표: 못 찾음. 요일처럼 보이는 글자: ' + (ds.join(' ') || '없음'));
      const ps = innermost(findText(/^[1-9]교시/)).slice(0, 8).map((e) => `"${clean(e.textContent)}"`);
      L.push('  교시 글자: ' + (ps.join(' ') || '없음'));
    }
    const menu = innermost(findText(/^[가-힣·ㆍ]{1,12}\([가-힣]{2,5}/)).slice(0, 14);
    L.push(`과목(선생님) 모양 글자 ${menu.length}개` + (menu.length ? ':' : ''));
    menu.forEach((e) => L.push('  ' + describe(e)));
    return L.join('\n');
  }

  /* ═══════════════════ 창(패널) ═══════════════════ */

  const STATE = {
    view: isInstalled() ? 'main' : 'setup',
    week: currentWeek(), loading: false, error: '', running: false,
    editing: null, isNewEdit: false, progress: 0, searchPt: null, pingMsg: '', draft: null,
  };
  let HOST = null, ROOT = null;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: 'Malgun Gothic','맑은 고딕','Apple SD Gothic Neo',sans-serif; }
  .panel { position: fixed; width: 406px; max-height: calc(100vh - 20px); display: flex; flex-direction: column;
    background: #fff; color: #1d2733; border: 1px solid #c4cfdb; border-radius: 10px;
    box-shadow: 0 14px 34px rgba(16,38,66,.24); font-size: 13px; overflow: hidden; z-index: 2147483000; }
  .hd { background: #173a63; color: #fff; padding: 9px 10px 9px 14px; display: flex; align-items: center; gap: 6px;
    cursor: move; user-select: none; }
  .hd .ttl-wrap { flex: 1; display: flex; flex-direction: column; gap: 1px; }
  .hd .ttl { font-weight: 700; font-size: 13.5px; letter-spacing: -.3px; }
  .hd .dev-sub { font-size: 10.5px; color: #b8d0eb; font-weight: 400; }
  .hd .ver { font-size: 10px; opacity: .6; align-self: flex-start; margin-top: 2px; }
  .hd button { background: transparent; border: 0; color: #fff; width: 26px; height: 24px; border-radius: 5px;
    cursor: pointer; font-size: 15px; line-height: 1; }
  .hd button:hover { background: rgba(255,255,255,.16); }
  .bd { padding: 12px 14px 12px; overflow: auto; word-break: keep-all; }
  .who { display: flex; align-items: center; justify-content: space-between; margin: 0 0 10px; }
  .who b { font-size: 15.5px; letter-spacing: -.3px; }
  .link { background: none; border: 0; color: #3a6ea5; cursor: pointer; font-size: 12px; text-decoration: underline; padding: 2px; }
  .card { border: 1px solid #dfe6ee; border-radius: 8px; padding: 6px 10px; margin-bottom: 12px; background: #f8fafc; }
  .sp { display: flex; align-items: center; gap: 6px; padding: 5px 0; border-bottom: 1px dashed #e3e9ef; }
  .sp:last-child { border-bottom: 0; }
  .sp .lab { min-width: 72px; color: #2b4c6f; font-size: 12.5px; font-weight: 700; }
  .sp .nm { flex: 1; font-weight: 600; color: #1d2733; }
  .sp .nm i { color: #c0392b; font-style: normal; font-weight: 400; font-size: 12px; }
  .sp input.inp-sub { width: 92px; flex: 0 0 92px; }
  .sp input.inp-tch { flex: 1; min-width: 0; }
  .sp-empty { padding: 8px 0; text-align: center; color: #7a8a9a; font-size: 12px; }
  .sp-add-bar { padding-top: 6px; margin-top: 2px; border-top: 1px dashed #e3e9ef; text-align: center; }
  .btn { background: #fff; border: 1px solid #b9c6d3; color: #22384f; border-radius: 6px; padding: 4px 9px;
    font-size: 12px; cursor: pointer; white-space: nowrap; }
  .btn:hover { background: #eef3f8; }
  .btn.blue { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  .btn.minus { color: #c0392b; border-color: #e6b0aa; font-weight: 700; padding: 4px 8px; line-height: 1; }
  .btn.minus:hover { background: #fdeceb; }
  .btn.add-row { width: 100%; border-style: dashed; color: #1f6feb; border-color: #9cc2f5; background: #f4f8ff; font-weight: 600; padding: 6px; }
  .btn.add-row:hover { background: #e6f0ff; }
  .btn:disabled, .primary:disabled, select:disabled { opacity: .5; cursor: default; }
  input:not([type=checkbox]), select { height: 30px; }
  input, select { border: 1px solid #b9c6d3; border-radius: 6px; padding: 4px 8px; font-size: 12.5px; color: #1d2733; background: #fff; }
  input:focus, select:focus { outline: 2px solid #9cc2f5; outline-offset: 0; border-color: #1f6feb; }
  .weekrow { display: flex; gap: 6px; margin-bottom: 8px; }
  .weekrow select { flex: 1; min-width: 0; font-weight: 600; }
  table.tt { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12px; margin-bottom: 4px; }
  table.tt th { background: #edf2f7; color: #364a5e; font-weight: 600; padding: 4px 1px; border: 1px solid #d3dce6; font-size: 11.5px; }
  table.tt th small { display: block; font-weight: 400; color: #708194; font-size: 10px; }
  table.tt td { border: 1px solid #d3dce6; text-align: center; height: 36px; padding: 2px 1px; line-height: 1.15; word-break: keep-all; }
  table.tt td.pn { background: #edf2f7; color: #364a5e; font-weight: 600; width: 38px; }
  table.tt td.spc { background: #fff1cf; }
  table.tt td .t { display: block; font-size: 10px; color: #8a6514; margin-top: 1px; }
  table.tt td.empty { color: #b7c1cc; }
  .note { font-size: 11px; color: #6b7a8a; margin: 2px 0 10px; display: flex; justify-content: space-between; gap: 6px; }
  .legend::before { content: ''; display: inline-block; width: 9px; height: 9px; background: #fff1cf; border: 1px solid #e5c879; margin-right: 4px; vertical-align: -1px; }
  .msg { padding: 14px 8px; text-align: center; color: #5b6b7c; background: #f6f8fa; border-radius: 8px; margin-bottom: 10px; line-height: 1.5; }
  .msg.err { color: #b3261e; background: #fdeceb; }
  .opts { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 4px 0 10px; font-size: 12px; color: #364a5e; }
  .opts label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
  .opts select { padding: 3px 6px; font-size: 12px; height: 28px; }
  .primary { width: 100%; background: #1f6feb; color: #fff; border: 0; border-radius: 8px; padding: 11px; font-size: 15px;
    font-weight: 700; cursor: pointer; letter-spacing: -.2px; }
  .primary:hover { background: #1a5fd0; }
  .primary.stop { background: #d0372d; }
  .prog { height: 5px; background: #e6ecf2; border-radius: 3px; overflow: hidden; margin: 10px 0 6px; }
  .bar { height: 100%; width: 0; background: #2ea043; transition: width .2s; }
  .log { background: #0f1b2a; color: #cfe0f2; font-family: Consolas,'D2Coding',monospace; font-size: 11.5px; height: 128px; overflow: auto;
    border-radius: 6px; padding: 6px 8px; white-space: pre-wrap; word-break: break-all; }
  .log .ok { color: #8fe08f; } .log .err { color: #ff8f86; } .log .warn { color: #ffd479; }
  .foot { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; }
  .foot-btns { display: flex; gap: 6px; }
  .dev-foot { font-size: 11px; color: #5b6b7c; font-weight: 600; text-align: center; margin-top: 10px; padding-top: 8px; border-top: 1px solid #eaeef2; }
  .form label.f { display: block; margin-bottom: 8px; font-size: 12px; color: #364a5e; }
  .form label.f input, .form label.f select { display: block; width: 100%; margin-top: 3px; }
  .form .two { display: grid; grid-template-columns: 1fr 1fr; gap: 0 10px; }
  .form .sec { font-weight: 700; color: #173a63; margin: 12px 0 6px; font-size: 13px; border-top: 1px solid #e3e9ef; padding-top: 10px; display: flex; justify-content: space-between; align-items: center; }
  .form .hint { font-size: 11px; color: #6b7a8a; margin: -2px 0 8px; line-height: 1.45; }
  .form .row { display: flex; gap: 6px; }
  .form .row input { flex: 1; min-width: 0; }
  .form .sp-setup-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
  .form .sp-setup-row { display: flex; gap: 6px; align-items: center; }
  .form .sp-setup-row input.s-sub { width: 120px; flex: 0 0 120px; }
  .form .sp-setup-row input.s-tch { flex: 1; min-width: 0; }
  .form .pm { font-size: 12px; margin: 4px 0 8px; min-height: 16px; }
  .form .pm.ok { color: #1a7f37; } .form .pm.err { color: #b3261e; }
  .form .actions { display: flex; gap: 8px; margin-top: 12px; }
  .form .actions .primary { flex: 1; }
  .intro { margin: 0 0 12px; color: #364a5e; line-height: 1.5; }
  .pill { position: fixed; right: 18px; bottom: 18px; background: #173a63; color: #fff; border: 0; border-radius: 999px;
    padding: 10px 16px; font-size: 13px; font-weight: 700; cursor: pointer; box-shadow: 0 8px 22px rgba(16,38,66,.3); z-index: 2147483000; }
  .pill.busy { background: #1f6feb; }
  `;

  function mount() {
    HOST = document.createElement('div');
    HOST.id = 'juan-timetable-host';
    ROOT = HOST.attachShadow({ mode: 'open' });
    document.body.appendChild(HOST);
    ROOT.addEventListener('click', onClick);
    ROOT.addEventListener('change', onChange);
    ROOT.addEventListener('mousedown', onDragStart);
    ['keydown', 'keypress', 'keyup'].forEach((tp) => HOST.addEventListener(tp, (e) => e.stopPropagation()));
    ROOT.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target.dataset) return;
      if (e.target.dataset.spIdx != null) {
        const b = ROOT.querySelector(`[data-act="sp-save"][data-idx="${e.target.dataset.spIdx}"]`);
        if (b) b.click();
      }
    });
    setInterval(() => { if (!HOST.isConnected && document.body) document.body.appendChild(HOST); }, 2000);
    render();
  }

  function weekOptions() {
    let h = '';
    for (let n = 1; n <= LAST_WEEK; n++) h += `<option value="${n}" ${n === STATE.week ? 'selected' : ''}>${esc(weekLabel(n))}</option>`;
    return h;
  }

  function ttHTML() {
    if (!apiBase()) return '<div class="msg err">시트 연결 주소가 없습니다. 오른쪽 위 [설정]에서 입력해 주세요.</div>';
    if (STATE.loading) return '<div class="msg">시트에서 시간표를 불러오는 중…</div>';
    if (STATE.error) return `<div class="msg err">${esc(STATE.error)}</div>`;
    const data = currentData();
    if (!data) return '<div class="msg">주차를 선택하면 시간표를 불러옵니다.</div>';
    let h = '<table class="tt"><thead><tr><th style="width:38px">교시</th>';
    data.days.forEach((d) => { h += `<th>${esc(d.day)}<small>${esc(d.date)}</small></th>`; });
    h += '</tr></thead><tbody>';
    for (let p = 0; p < PERIODS; p++) {
      h += `<tr><td class="pn">${p + 1}</td>`;
      for (let d = 0; d < 5; d++) {
        const c = parseCell(data.grid[p] && data.grid[p][d]);
        if (!c) { h += '<td class="empty">·</td>'; continue; }
        if (c.who === 'homeroom') h += `<td title="담임">${esc(c.raw)}</td>`;
        else h += `<td class="spc" title="${esc(whoLabel(c.who))}">${esc(c.raw)}<span class="t">${esc(teacherOf(c.who) || '이름 미입력')}</span></td>`;
      }
      h += '</tr>';
    }
    h += '</tbody></table>';
    const total = buildPlan(data).length;
    h += `<div class="note"><span>시트: ${esc(data.sheetName)}${data.matchedBy === 'title' ? ' (이름으로 찾음)' : ''}</span><span class="legend">전담 · ${total}칸</span></div>`;
    return h;
  }

  function mainHTML() {
    const lock = STATE.running ? 'disabled' : '';
    let sp = '';
    const list = CFG.specialists || [];
    if (!list.length) {
      sp += `<div class="sp-empty">등록된 전담 과목이 없습니다. 아래 버튼으로 추가해 주세요.</div>`;
    } else {
      list.forEach((s, idx) => {
        if (STATE.editing === idx) {
          sp += `<div class="sp">
            <input class="inp-sub" data-sp-sub="${idx}" data-sp-idx="${idx}" value="${esc(s.subject)}" placeholder="전담 과목명">
            <input class="inp-tch" data-sp-tch="${idx}" data-sp-idx="${idx}" value="${esc(s.teacher)}" placeholder="선생님 이름">
            <button class="btn blue" data-act="sp-save" data-idx="${idx}">저장</button>
            <button class="btn" data-act="sp-cancel" data-idx="${idx}">취소</button>
            <button class="btn minus" data-act="sp-del" data-idx="${idx}" title="전담과목 삭제">−</button>
          </div>`;
        } else {
          sp += `<div class="sp">
            <span class="lab">${esc(s.subject || '(과목 미입력)')}</span>
            <span class="nm">${s.teacher ? esc(s.teacher) + ' 선생님' : '<i>이름을 입력해 주세요</i>'}</span>
            <button class="btn" data-act="sp-edit" data-idx="${idx}" ${lock}>변경</button>
            <button class="btn minus" data-act="sp-del" data-idx="${idx}" title="전담과목 삭제" ${lock}>−</button>
          </div>`;
        }
      });
    }
    sp += `<div class="sp-add-bar"><button class="btn add-row" data-act="sp-add-main" ${lock}>+ 전담 과목 추가하기</button></div>`;

    return `
      <div class="who"><b>${esc(CFG.cls)}반 ${esc(CFG.name)} 선생님</b>
        <button class="link" data-act="settings" ${lock}>설정</button></div>
      <div class="card">${sp}</div>
      <div class="weekrow">
        <select data-k="week" ${lock}>${weekOptions()}</select>
        <button class="btn" data-act="reload" title="시트를 다시 읽어 옵니다" ${lock}>새로고침</button>
      </div>
      ${ttHTML()}
      <div class="opts">
        <label><input type="checkbox" data-k="stopBeforeSave" ${CFG.stopBeforeSave ? 'checked' : ''} ${lock}> 저장은 내가 직접 누르기</label>
        <label>속도 <select data-k="speed" ${lock}>
          <option value="slow" ${CFG.speed === 'slow' ? 'selected' : ''}>천천히</option>
          <option value="normal" ${CFG.speed === 'normal' ? 'selected' : ''}>보통</option>
          <option value="fast" ${CFG.speed === 'fast' ? 'selected' : ''}>빠르게</option></select></label>
      </div>
      ${STATE.running
        ? '<button class="primary stop" data-act="stop">중지</button>'
        : `<button class="primary" data-act="run" ${currentData() && !STATE.loading && !STATE.error ? '' : 'disabled'}>나이스 입력</button>`}
      <div class="prog"><div class="bar" style="width:${Math.round(STATE.progress * 100)}%"></div></div>
      <div class="log"></div>
      <div class="foot">
        <span style="font-size:11px; color:#5b6b7c; font-weight:600;">${DEV_CREDIT}</span>
        <div class="foot-btns">
          <button class="btn" data-act="diag" ${lock}>화면 진단</button>
          <button class="btn" data-act="copylog">로그 복사</button>
        </div>
      </div>`;
  }

  function ensureDraft() {
    if (!STATE.draft) {
      const cloned = (CFG.specialists || []).map((s) => ({ subject: s.subject, teacher: s.teacher }));
      STATE.draft = {
        name: CFG.name,
        cls: CFG.cls,
        apiUrl: CFG.apiUrl,
        specialists: cloned.length ? cloned : [{ subject: '', teacher: '' }],
        selectFirst: CFG.selectFirst,
      };
    }
    return STATE.draft;
  }

  function formHTML(first) {
    const D = ensureDraft();
    let clsOpts = '<option value="">선택</option>';
    for (let i = 1; i <= 15; i++) clsOpts += `<option value="${i}" ${String(D.cls) === String(i) ? 'selected' : ''}>${i}반</option>`;

    let spRows = '';
    if (!D.specialists.length) {
      spRows = `<div class="sp-empty">전담 과목이 없습니다. 아래 [+ 추가하기] 버튼을 눌러 추가하세요.</div>`;
    } else {
      spRows = D.specialists.map((s, idx) => `
        <div class="sp-setup-row" data-setup-sp-row="${idx}">
          <input class="s-sub" data-f-sub="${idx}" value="${esc(s.subject)}" placeholder="과목 (예: 도덕, 체육(보건))">
          <input class="s-tch" data-f-tch="${idx}" value="${esc(s.teacher)}" placeholder="선생님 이름">
          <button type="button" class="btn minus" data-act="setup-sp-del" data-idx="${idx}" title="전담과목 삭제">−</button>
        </div>`).join('');
    }

    return `<div class="form">
      ${first ? '<p class="intro">처음 한 번만 입력하면 됩니다. 이름은 나이스 우클릭 메뉴에 보이는 이름과 같게 적어 주세요.</p>' : ''}
      <div class="two">
        <label class="f">담임 선생님 이름 <input data-f="name" value="${esc(D.name)}" placeholder="예: 백천재"></label>
        <label class="f">반 <select data-f="cls">${clsOpts}</select></label>
      </div>
      <div class="sec">
        <span>전담 과목 및 선생님</span>
      </div>
      <div class="hint">전담 과목명(예: 도덕, 과학, 영어, 체육(보건) 등)과 선생님 성함을 입력하고 [+ 추가하기]를 눌러 계속 추가하세요.</div>
      <div class="sp-setup-list">${spRows}</div>
      <button type="button" class="btn add-row" data-act="setup-sp-add">+ 전담 과목 추가하기</button>

      ${DEFAULT_API_URL ? `<input type="hidden" data-f="apiUrl" value="${esc(D.apiUrl)}">` : `<div class="sec">시트 연결 주소</div>
      <div class="hint">시간표 시트를 읽어 오는 Apps Script 웹앱 주소(…/exec)를 붙여 넣으세요.</div>
      <div class="row"><input data-f="apiUrl" value="${esc(D.apiUrl)}" placeholder="https://script.google.com/macros/s/…/exec">
        <button class="btn" data-act="ping">연결 확인</button></div>`}
      <div class="pm ${STATE.pingMsg && STATE.pingMsg[0] === '✓' ? 'ok' : 'err'}">${esc(STATE.pingMsg)}</div>
      <label class="opts" style="justify-content:flex-start"><input type="checkbox" data-f="selectFirst" ${D.selectFirst ? 'checked' : ''}>
        우클릭 전에 칸을 먼저 한 번 클릭(선택)</label>
      <div class="actions">
        <button class="primary" data-act="save-setup">${first ? '설치 완료' : '저장'}</button>
        ${first ? '' : '<button class="btn" data-act="cancel-setup">취소</button>'}
      </div>
      <div class="dev-foot">${DEV_CREDIT}</div>
    </div>`;
  }

  function render() {
    if (!ROOT) return;
    const prevLog = ROOT.querySelector('.log');
    const logScroll = prevLog ? prevLog.scrollTop : null;
    if (UI.min) {
      ROOT.innerHTML = `<style>${CSS}</style><button class="pill ${STATE.running ? 'busy' : ''}" data-act="restore">📅 시간표 입력${STATE.running ? ' · 진행 중' : ''}</button>`;
      return;
    }
    const first = !isInstalled();
    const body = STATE.view === 'main' && !first ? mainHTML() : formHTML(first);
    ROOT.innerHTML = `<style>${CSS}</style>
      <div class="panel">
        <div class="hd" data-drag="1">
          <div class="ttl-wrap">
            <span class="ttl">${TITLE}</span>
            <span class="dev-sub">${DEV_CREDIT}</span>
          </div>
          <span class="ver">v${VERSION}</span>
          <button data-act="min" title="접기">—</button>
        </div>
        <div class="bd">${body}</div>
      </div>`;
    const panel = ROOT.querySelector('.panel');
    const left = UI.left == null ? Math.max(8, window.innerWidth - 406 - 18) : Math.min(UI.left, window.innerWidth - 120);
    panel.style.left = Math.max(0, left) + 'px';
    panel.style.top = Math.max(0, Math.min(UI.top, window.innerHeight - 60)) + 'px';
    const box = ROOT.querySelector('.log');
    if (box) {
      LOG.forEach((l) => { const d = document.createElement('div'); d.className = l.kind; d.textContent = l.text; box.appendChild(d); });
      box.scrollTop = logScroll != null && !STATE.running ? logScroll : box.scrollHeight;
    }
  }

  function readForm() {
    const v = (f) => { const e = ROOT.querySelector(`[data-f="${f}"]`); return e ? e.value.trim() : ''; };
    const sf = ROOT.querySelector('[data-f="selectFirst"]');
    const rows = ROOT.querySelectorAll('[data-setup-sp-row]');
    const specialists = [];
    rows.forEach((r) => {
      const idx = r.getAttribute('data-setup-sp-row');
      const subEl = ROOT.querySelector(`[data-f-sub="${idx}"]`);
      const tchEl = ROOT.querySelector(`[data-f-tch="${idx}"]`);
      const subject = subEl ? subEl.value.trim() : '';
      const teacher = tchEl ? tchEl.value.trim() : '';
      specialists.push({ subject, teacher });
    });
    return {
      name: v('name'), cls: v('cls'), apiUrl: v('apiUrl'),
      specialists,
      selectFirst: sf ? sf.checked : CFG.selectFirst,
    };
  }

  async function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === 'min') { UI.min = true; saveUI(); render(); return; }
    if (act === 'restore') { UI.min = false; saveUI(); render(); return; }
    if (act === 'settings') { STATE.view = 'setup'; STATE.pingMsg = ''; STATE.draft = null; render(); return; }
    if (act === 'cancel-setup') { STATE.view = 'main'; STATE.draft = null; render(); return; }

    // 설치/설정창에서 전담 과목 행 추가 및 삭제
    if (act === 'setup-sp-add') {
      const f = readForm();
      f.specialists.push({ subject: '', teacher: '' });
      STATE.draft = f;
      render();
      const lastIdx = f.specialists.length - 1;
      const inp = ROOT.querySelector(`[data-f-sub="${lastIdx}"]`);
      if (inp) inp.focus();
      return;
    }
    if (act === 'setup-sp-del') {
      const idx = Number(b.dataset.idx);
      const f = readForm();
      f.specialists.splice(idx, 1);
      STATE.draft = f;
      render();
      return;
    }

    if (act === 'ping') {
      STATE.draft = readForm();
      STATE.pingMsg = '확인 중…'; render();
      try { const r = await api({ action: 'ping' }, STATE.draft.apiUrl); STATE.pingMsg = '✓ 연결됨: ' + r.title; }
      catch (err) { STATE.pingMsg = '✗ ' + err.message; }
      render();
      return;
    }
    if (act === 'save-setup') {
      const f = readForm();
      STATE.draft = f;
      if (!f.name) { STATE.pingMsg = '✗ 담임 선생님 이름을 입력해 주세요.'; render(); return; }
      if (!f.cls) { STATE.pingMsg = '✗ 반을 선택해 주세요.'; render(); return; }
      // 빈 줄은 자동 제외하되, 과목명 없이 선생님 이름만 적은 경우는 안내
      for (const sp of f.specialists) {
        if (!sp.subject && sp.teacher) {
          STATE.pingMsg = `✗ '${sp.teacher}' 선생님의 전담 과목명을 입력해 주세요.`;
          render();
          return;
        }
      }
      f.specialists = f.specialists.filter((s) => s.subject || s.teacher);
      if (!DEFAULT_API_URL && !/^https:\/\/script\.google(usercontent)?\.com\//.test(f.apiUrl)) {
        STATE.pingMsg = '✗ 시트 연결 주소(https://script.google.com/…/exec)를 입력해 주세요.';
        render();
        return;
      }
      Object.assign(CFG, f);
      saveCfg();
      STATE.view = 'main'; STATE.pingMsg = ''; STATE.draft = null; STATE.error = ''; STATE.editing = null;
      render();
      loadWeek(false);
      return;
    }

    // 실행창에서 전담 과목 추가 / 변경 / 저장 / 취소 / 삭제
    if (act === 'sp-add-main') {
      CFG.specialists.push({ subject: '', teacher: '' });
      STATE.editing = CFG.specialists.length - 1;
      STATE.isNewEdit = true;
      render();
      const inp = ROOT.querySelector(`[data-sp-sub="${STATE.editing}"]`);
      if (inp) inp.focus();
      return;
    }
    if (act === 'sp-edit') {
      STATE.editing = Number(b.dataset.idx);
      STATE.isNewEdit = false;
      render();
      const inp = ROOT.querySelector(`[data-sp-tch="${STATE.editing}"]`);
      if (inp) { inp.focus(); inp.select(); }
      return;
    }
    if (act === 'sp-cancel') {
      const idx = Number(b.dataset.idx);
      if (STATE.isNewEdit && CFG.specialists[idx] && !CFG.specialists[idx].subject && !CFG.specialists[idx].teacher) {
        CFG.specialists.splice(idx, 1);
      }
      STATE.editing = null;
      STATE.isNewEdit = false;
      render();
      return;
    }
    if (act === 'sp-save') {
      const idx = Number(b.dataset.idx);
      const subEl = ROOT.querySelector(`[data-sp-sub="${idx}"]`);
      const tchEl = ROOT.querySelector(`[data-sp-tch="${idx}"]`);
      const subject = subEl ? subEl.value.trim() : '';
      const teacher = tchEl ? tchEl.value.trim() : '';
      if (!subject) {
        alert('전담 과목명을 입력해 주세요.');
        if (subEl) subEl.focus();
        return;
      }
      CFG.specialists[idx] = { subject, teacher };
      saveCfg();
      STATE.editing = null;
      STATE.isNewEdit = false;
      render();
      return;
    }
    if (act === 'sp-del') {
      const idx = Number(b.dataset.idx);
      const target = CFG.specialists[idx];
      if (target && (target.subject || target.teacher)) {
        const label = target.subject || target.teacher;
        if (!confirm(`'${label}' 전담 항목을 삭제할까요?`)) return;
      }
      CFG.specialists.splice(idx, 1);
      saveCfg();
      if (STATE.editing === idx) STATE.editing = null;
      else if (typeof STATE.editing === 'number' && STATE.editing > idx) STATE.editing--;
      STATE.isNewEdit = false;
      render();
      return;
    }

    if (act === 'reload') { loadWeek(true); return; }
    if (act === 'run') { run(); return; }
    if (act === 'stop') { if (RUN) RUN.stopped = true; log('중지 요청…', 'warn'); return; }
    if (act === 'copylog') {
      const text = LOG.map((l) => l.text).join('\n');
      try { GM_setClipboard(text); log('로그를 복사했습니다.'); } catch (err) { log('복사 실패: ' + err.message, 'err'); }
      return;
    }
    if (act === 'diag') {
      log('5초 뒤 나이스 화면을 살펴봅니다. 우클릭 메뉴 모양도 보려면 그동안 시간표 칸 하나를 우클릭해 두세요.');
      b.disabled = true;
      await sleep(5000);
      const text = diagnose();
      text.split('\n').forEach((line) => log(line));
      try { GM_setClipboard(text); log('진단 결과를 복사했습니다. 그대로 붙여 넣어 보내 주시면 됩니다.', 'ok'); } catch (err) { /* 무시 */ }
      b.disabled = false;
    }
  }

  function onChange(e) {
    const k = e.target.dataset && e.target.dataset.k;
    if (!k) return;
    if (k === 'week') { STATE.week = Number(e.target.value); STATE.error = ''; setProgress(0, 0); loadWeek(false); }
    else if (k === 'stopBeforeSave') { CFG.stopBeforeSave = e.target.checked; saveCfg(); }
    else if (k === 'speed') { CFG.speed = e.target.value; saveCfg(); }
  }

  function onDragStart(e) {
    const hd = e.target.closest('[data-drag]');
    if (!hd || e.target.closest('button') || e.button !== 0) return;
    const panel = ROOT.querySelector('.panel');
    const r = panel.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => {
      UI.left = Math.max(0, Math.min(window.innerWidth - 120, ev.clientX - dx));
      UI.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy));
      panel.style.left = UI.left + 'px'; panel.style.top = UI.top + 'px';
    };
    const up = () => { window.removeEventListener('mousemove', move, true); window.removeEventListener('mouseup', up, true); saveUI(); };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
    e.preventDefault();
  }

  /* ═══════════════════ 시작 ═══════════════════ */

  function start() {
    if (!document.body) { setTimeout(start, 300); return; }
    mount();
    if (isInstalled() && apiBase()) loadWeek(false);
    try {
      GM_registerMenuCommand('시간표 입력 창 열기', () => { UI.min = false; saveUI(); render(); });
      GM_registerMenuCommand('설정 전체 초기화', () => {
        if (!confirm('이름·반·전담 선생님·연결 주소를 모두 지울까요?')) return;
        writeJSON(CFG_KEY, null); writeJSON(CACHE_KEY, {});
        Object.assign(CFG, defaults());
        Object.keys(CACHE).forEach((k) => delete CACHE[k]);
        STATE.view = 'setup'; STATE.draft = null; STATE.editing = null; render();
      });
    } catch (e) { /* 무시 */ }
  }
  start();
})();