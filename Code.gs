/**
 * 주안초 나이스 시간표 자동 입력시스템 — 시트 읽기용 Apps Script (웹앱)
 * 프로그램 개발자 : 교사 백천재
 *
 * 하는 일: 주간학습안내 시트에서 주차·반을 받아
 *          그 주의 시간표(월~금 × 1~6교시)를 JSON으로 돌려줍니다.
 *
 *   연결 확인  : 웹앱주소?action=ping
 *   시간표     : 웹앱주소?week=12&class=1
 *
 * 배포 방법: [배포] → [새 배포] → 유형 "웹 앱"
 *            실행 사용자 "나", 액세스 권한 "모든 사용자"
 */

const SPREADSHEET_ID = '1Rvckoxg0zPFhO_z5hRpYvVkHxGHN-DoPjuFPsUQ4x7o';
const FIRST_MONDAY = { y: 2026, m: 8, d: 17 }; // 1주차(8.18 개학)가 들어 있는 주의 월요일
const LAST_WEEK = 21;
const GRADE = 5;
const PERIODS = 6;
const DAYS = ['월', '화', '수', '목', '금'];

function doGet(e) {
  const p = (e && e.parameter) || {};
  let out;
  try {
    if (p.action === 'ping') {
      out = { ok: true, title: SpreadsheetApp.openById(SPREADSHEET_ID).getName() };
    } else {
      out = getTimetable(parseInt(p.week, 10), parseInt(p['class'], 10));
      out.ok = true;
    }
  } catch (err) {
    out = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function getTimetable(week, cls) {
  if (!(week >= 1 && week <= LAST_WEEK)) throw new Error('주차는 1~' + LAST_WEEK + ' 사이여야 합니다.');
  if (!(cls >= 1 && cls <= 15)) throw new Error('반 번호가 올바르지 않습니다.');
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheets = ss.getSheets().map(function (sh) {
    return {
      name: sh.getName(),
      gid: sh.getSheetId(),
      values: function () { return sh.getDataRange().getDisplayValues(); }
    };
  });
  return pickTimetable(sheets, week, cls);
}

/* ───────────── 아래는 시트 모양만 보고 판단하는 함수들 ───────────── */

// 해당 주차의 월~금 날짜 [{m,d}] (월요일 기준)
function expectedDates(week) {
  const out = [];
  for (let i = 0; i < 5; i++) {
    const dt = new Date(FIRST_MONDAY.y, FIRST_MONDAY.m - 1, FIRST_MONDAY.d + 7 * (week - 1) + i);
    out.push({ y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() });
  }
  return out;
}

// 같은 "N주" 이름의 시트가 여러 개일 때
// ① 반 표 머리글의 날짜(예: 10/26(월))가 이번 학기 날짜와 맞는 시트를 고르고
// ② 머리글에 날짜가 없으면 시트 이름의 날짜 + 해당 학년 시트인지로 판단합니다.
function pickTimetable(sheets, week, cls) {
  const exp = expectedDates(week);
  const tried = [];
  let best = null;
  sheets.forEach(function (s) {
    const m = String(s.name).match(/^\s*(\d+)\s*주/);
    if (!m || Number(m[1]) !== week) return;
    const values = s.values();
    const block = findClassBlock(values, cls);
    const score = block ? scoreSheet(s.name, values, block, exp) : 0;
    tried.push(s.name);
    if (score > 0 && (!best || score > best.score)) best = { s: s, block: block, score: score };
  });
  if (!best) {
    throw new Error(week + '주차 시트가 아직 없거나 ' + cls + '반 시간표를 찾지 못했습니다.' +
      (tried.length ? ' (확인한 시트: ' + tried.join(', ') + ')' : ''));
  }
  return {
    week: week,
    cls: cls,
    sheetName: best.s.name,
    gid: best.s.gid,
    matchedBy: best.score >= 10 ? 'dates' : 'title',
    days: DAYS.map(function (d, i) {
      return { day: d, date: exp[i].m + '/' + exp[i].d, head: best.block.heads[i] };
    }),
    grid: best.block.grid
  };
}

// "1반" 칸(오른쪽에 "…(월)" 머리글이 붙은 칸)을 찾아 아래 1~6교시를 읽습니다.
function findClassBlock(values, cls) {
  const label = cls + '반';
  for (let r = 0; r < values.length; r++) {
    const row = values[r];
    for (let c = 0; c < row.length; c++) {
      if (String(row[c]).replace(/\s/g, '') !== label) continue;
      if (String(row[c + 1] || '').indexOf('월') < 0) continue; // 메모 칸의 "2반" 같은 글자는 건너뜀
      const heads = [];
      for (let i = 0; i < 5; i++) heads.push(String(row[c + 1 + i] || '').replace(/\s+/g, ' ').trim());
      const grid = [];
      for (let p = 1; p <= PERIODS; p++) {
        let cells = ['', '', '', '', ''];
        for (let rr = r + 1; rr < values.length && rr <= r + PERIODS + 3; rr++) {
          if (String(values[rr][c]).trim() === String(p)) {
            cells = [0, 1, 2, 3, 4].map(function (i) {
              return String(values[rr][c + 1 + i] || '').replace(/\s+/g, ' ').trim();
            });
            break;
          }
        }
        grid.push(cells);
      }
      return { row: r, col: c, heads: heads, grid: grid };
    }
  }
  return null;
}

function scoreSheet(name, values, block, exp) {
  let match = 0, mismatch = 0;
  block.heads.forEach(function (h, i) {
    const m = h.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
    if (!m) return;
    if (Number(m[1]) === exp[i].m && Number(m[2]) === exp[i].d) match++;
    else mismatch++;
  });
  if (mismatch > 0) return 0;
  if (match > 0) return 10 + match;

  // 머리글에 날짜가 없을 때: 시트 이름의 시작 날짜가 그 주 안에 있고, 해당 학년 시트여야 함
  const t = String(name).match(/\(\s*(\d{1,2})\s*\.\s*(\d{1,2})/);
  if (!t) return 0;
  const mon = new Date(exp[0].y, exp[0].m - 1, exp[0].d);
  let inWeek = false;
  [-1, 0, 1].forEach(function (dy) {
    const dt = new Date(exp[0].y + dy, Number(t[1]) - 1, Number(t[2]));
    const diff = Math.round((dt - mon) / 86400000);
    if (diff >= 0 && diff <= 6) inWeek = true;
  });
  if (!inWeek || gradeOf(values) !== GRADE) return 0;
  return String(name).indexOf('주간학습안내') >= 0 ? 3 : 2;
}

// 전담 배정표의 "5-1", "6-3" 같은 반 표기를 세어 몇 학년 시트인지 판단
function gradeOf(values) {
  const count = {};
  values.forEach(function (row) {
    row.forEach(function (v) {
      const re = /(^|[^\d])([1-6])-([1-9])(?!\d)/g;
      let m;
      while ((m = re.exec(String(v)))) count[m[2]] = (count[m[2]] || 0) + 1;
    });
  });
  let best = 0, bestN = 0;
  Object.keys(count).forEach(function (g) { if (count[g] > bestN) { bestN = count[g]; best = Number(g); } });
  return best;
}