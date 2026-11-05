'use strict';
// كورة برو - خادم مباشر بدون أي اعتماديات (Node 18+)
const http = require('http'), fs = require('fs'), path = require('path');
const { TEAMS, resolve } = require('./teams');
// قراءة ملف .env إن وُجد (لا يطغى على متغيرات البيئة الموجودة)
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !l.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch (e) { }

const PORT = +process.env.PORT || 3000;
const LAZY = !!process.env.VERCEL || process.env.LAZY === '1';   // وضع Vercel: بلا حلقات خلفية، يُحدَّث عند الطلب
const TOKEN = process.env.FD_TOKEN || '';
const AFK = process.env.API_FOOTBALL_KEY || process.env.APISPORTS_KEY || '';
const MOCK = process.env.MOCK === '1' || (!TOKEN && !AFK);   // بدون أي مفتاح = وضع تجريبي
const COMPS = (process.env.COMPS || 'PL,PD').split(',').map(s => s.trim());
const LIVE_S = +process.env.POLL_LIVE_S || (MOCK ? 2 : 15);  // فاصل التحديث وقت وجود مباراة
const IDLE_S = +process.env.POLL_IDLE_S || (MOCK ? 5 : 60);  // فاصل التحديث في الأوقات الهادئة
const LGS = { PL: { id: 1, n: 'الدوري الإنجليزي', i: '🏴' }, PD: { id: 2, n: 'الدوري الإسباني', i: '🇪🇸' }, SA: { id: 3, n: 'دوري روشن السعودي', i: '🇸🇦' }, CL: { id: 4, n: 'دوري أبطال أوروبا', i: '🏆' } };
const lgOf = c => LGS[c] || { id: c, n: c, i: '⚽' };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const PHOTO = process.env.PHOTO_BASE || 'https://media.api-sports.io/football/players';
const ph = id => id ? `${PHOTO}/${id}.png` : '';
let EXTRAS = {}; try { EXTRAS = JSON.parse(fs.readFileSync(path.join(__dirname, 'extras.json'), 'utf8')); } catch (e) { }
const extra = {}, tid = {};
const nm = c => TEAMS[c] ? TEAMS[c][0] : (extra[c] && extra[c].ar) || c;
const SA_AR = { 'al hilal': 'الهلال', 'al nassr': 'النصر', 'al ahli': 'الأهلي', 'al ittihad': 'الاتحاد', 'al shabab': 'الشباب', 'al ettifaq': 'الاتفاق', 'al taawoun': 'التعاون', 'al fateh': 'الفتح', 'al fayha': 'الفيحاء', 'al khaleej': 'الخليج', 'damac': 'ضمك', 'al raed': 'الرائد', 'al riyadh': 'الرياض', 'al kholood': 'الخلود', 'al okhdood': 'الأخدود', 'al qadsiah': 'القادسية', 'al orobah': 'العروبة', 'neom': 'نيوم', 'al hazem': 'الحزم', 'al najma': 'النجمة' };
const arName = t => { const k = String(t.name || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim(); const h = Object.keys(SA_AR).find(x => k.startsWith(x)); return h ? SA_AR[h] : (t.shortName || t.name); };
function teamCode(t) {
  const c = resolve(t.name) || resolve(t.shortName || '');
  if (c) { if (t.id) tid[c] = t.id; return c; }
  const k = t.tla || String(t.id);
  extra[k] = { ar: arName(t), c: '#555', logo: t.crest || '' };
  return k;
}
const fT = new Intl.DateTimeFormat('ar-IQ-u-nu-arab', { timeZone: 'Asia/Baghdad', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true });

/* ---------- أدوات الأسماء ---------- */
const PRE = new Set(['van', 'de', 'da', 'di', 'dos', 'der', 'den', 'le', 'la', 'el', 'al', 'von', 'ter', 'ten']);
const short = n => { const p = String(n).trim().split(/\s+/); return p.length > 2 && PRE.has(p[p.length - 2].toLowerCase()) ? p.slice(-2).join(' ') : p[p.length - 1]; };
const grp = p => /goal/i.test(p) ? 'gk' : /def|back/i.test(p) ? 'd' : /mid/i.test(p) ? 'm' : 'f';
function lineup(t) {
  if (!t || !t.lineup || !t.lineup.length) return null;
  const o = { gk: '', d: [], m: [], f: [], b: [] };
  t.lineup.forEach(p => { const g = grp(p.position || ''), n = short(p.name); if (g === 'gk') o.gk = n; else o[g].push(n); });
  (t.bench || []).forEach(p => o.b.push(short(p.name)));
  return o.gk && o.d.length + o.m.length + o.f.length === 10 ? o : null;
}
function stats(h, a) {
  if (!h || !h.statistics || !a || !a.statistics) return null;
  const f = s => [s.ball_possession || 0, s.shots || 0, s.shots_on_goal || 0, s.corner_kicks || 0, s.fouls || 0, s.yellow_cards || 0, s.offsides || 0, s.saves || 0, (s.red_cards || 0) + (s.yellow_red_cards || 0)];
  return [f(h.statistics), f(a.statistics)];
}

/* ---------- المزوّد الحقيقي: football-data.org ---------- */
const hits = [];
const prune = () => { const n = Date.now(); while (hits.length && n - hits[0] > 6e4) hits.shift(); return hits.length; };
async function fd(p) {
  if (prune() >= 9) throw new Error('rate-limit');
  hits.push(Date.now());
  const r = await fetch('https://api.football-data.org/v4' + p, { headers: { 'X-Auth-Token': TOKEN } });
  if (!r.ok) throw new Error('football-data ' + r.status + ' ' + p);
  return r.json();
}
const day = d => new Date(d).toISOString().slice(0, 10);
const FDP = {
  async matches(c, from, to) {
    const j = await fd(`/competitions/${c}/matches?dateFrom=${day(from)}&dateTo=${day(to)}`);
    return (j.matches || []).map(x => ({ id: x.id, lg: c, utc: x.utcDate, st: x.status, min: x.minute, h: x.homeTeam, a: x.awayTeam,
      hs: (x.score && x.score.fullTime && x.score.fullTime.home) || 0, as: (x.score && x.score.fullTime && x.score.fullTime.away) || 0 }));
  },
  async standings(c) {
    const j = await fd(`/competitions/${c}/standings`);
    const tb = (j.standings || []).find(s => s.type === 'TOTAL') || (j.standings || [])[0];
    return tb ? tb.table.map(r => [teamCode(r.team), r.won, r.draw, r.lost, r.points]) : [];
  },
  async team(id) {
    const x = await fd('/teams/' + id), now = Date.now();
    return { coach: (x.coach && x.coach.name) || '', squad: (x.squad || []).map(p => ({ n: short(p.name), g: grp(p.position || ''), nat: p.nationality || '', age: p.dateOfBirth ? Math.floor((now - Date.parse(p.dateOfBirth)) / 31557600000) : 0, num: p.shirtNumber || 0 })) };
  },
  async detail(id) {
    const x = await fd('/matches/' + id), hid = x.homeTeam && x.homeTeam.id, side = t => t && t.id === hid ? 'h' : 'a';
    const ev = [];
    (x.goals || []).forEach(g => ev.push([g.minute, 'g', side(g.team), g.scorer && g.scorer.name ? short(g.scorer.name) : '']));
    (x.bookings || []).forEach(b => ev.push([b.minute, /RED/.test(b.card) ? 'r' : 'y', side(b.team)]));
    (x.substitutions || []).forEach(s => ev.push([s.minute, 's', side(s.team)]));
    ev.sort((p, q) => p[0] - q[0]);
    return { ev, st: stats(x.homeTeam, x.awayTeam), lu: { h: lineup(x.homeTeam), a: lineup(x.awayTeam) } };
  }
};


/* ---------- المزوّد: API-Football (api-sports.io) ---------- */
const AFID = { PL: 39, PD: 140, SA: 307, CL: 2 };
const AFINV = Object.fromEntries(Object.entries(AFID).map(([k, v]) => [v, k]));
const SEASON = +process.env.SEASON || (new Date().getUTCMonth() >= 6 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() - 1);
const AFBASE = process.env.AF_BASE || 'https://v3.football.api-sports.io';
const BASE_S = +process.env.BASE_S || 180;
let afRemain = 1e9, afBase = [], afBaseAt = 0, afStale = true;
const fx = new Map(), memo = new Map();
async function af(p) {
  const r = await fetch(AFBASE + p, { headers: { 'x-apisports-key': AFK } });
  const rem = r.headers.get('x-ratelimit-requests-remaining'); if (rem != null) afRemain = +rem;
  if (!r.ok) throw new Error('api-football ' + r.status + ' ' + p);
  const j = await r.json();
  const er = j.errors && (Array.isArray(j.errors) ? j.errors[0] : Object.values(j.errors)[0]);
  if (er) throw new Error('api-football: ' + (typeof er === 'string' ? er : JSON.stringify(er)));
  return j.response || [];
}
const cached = async (k, ttl, fn) => { const c = memo.get(k); if (c && Date.now() - c.at < ttl) return c.v; const v = await fn(); memo.set(k, { at: Date.now(), v }); return v; };
const AFS = { NS: 'TIMED', TBD: 'TIMED', '1H': 'IN_PLAY', '2H': 'IN_PLAY', ET: 'IN_PLAY', BT: 'IN_PLAY', P: 'IN_PLAY', LIVE: 'IN_PLAY', HT: 'PAUSED', FT: 'FINISHED', AET: 'FINISHED', PEN: 'FINISHED', AWD: 'FINISHED', WO: 'FINISHED', PST: 'POSTPONED', SUSP: 'SUSPENDED', INT: 'SUSPENDED', CANC: 'CANCELLED', ABD: 'CANCELLED' };
const afT = t => ({ id: t.id, name: t.name, crest: t.logo });
function afNorm(x, lg) {
  fx.set(x.fixture.id, { h: x.teams.home.id, a: x.teams.away.id });
  return { id: x.fixture.id, lg, utc: x.fixture.date, st: AFS[x.fixture.status.short] || 'TIMED', min: x.fixture.status.elapsed, h: afT(x.teams.home), a: afT(x.teams.away), hs: x.goals.home || 0, as: x.goals.away || 0 };
}
function afLu(lus, t) {
  const x = lus.find(l => l.team && l.team.id === t);
  if (!x || !x.startXI || x.startXI.length < 11) return null;
  const o = { gk: '', d: [], m: [], f: [], b: [] };
  const pp = p => ({ n: short(p.name), id: p.id, num: p.number, ph: ph(p.id) });
  x.startXI.forEach(({ player: p }) => { const g = { G: 'gk', D: 'd', M: 'm', F: 'f' }[p.pos] || 'm'; if (g === 'gk') o.gk = pp(p); else o[g].push(pp(p)); });
  (x.substitutes || []).forEach(({ player: p }) => o.b.push(pp(p)));
  return o.gk && o.d.length + o.m.length + o.f.length === 10 ? o : null;
}
const AFP = {
  slow: () => afRemain < 40,
  async all(comps, from, to) {
    const ids = comps.map(c => AFID[c]).filter(Boolean);
    if (afStale || Date.now() - afBaseAt > BASE_S * 1000) {
      const out = [];
      for (const id of ids) (await af(`/fixtures?league=${id}&season=${SEASON}&from=${day(from)}&to=${day(to)}&timezone=UTC`)).forEach(x => out.push(afNorm(x, AFINV[id])));
      afBase = out; afBaseAt = Date.now(); afStale = false;
    }
    const liveNow = afBase.some(m => m.st === 'IN_PLAY' || m.st === 'PAUSED');
    const soon = afBase.some(m => m.st === 'TIMED' && Math.abs(Date.parse(m.utc) - Date.now()) < 3e5);
    if ((liveNow || soon) && !AFP.slow()) {
      const L = new Map((await af('/fixtures?live=' + ids.join('-'))).map(x => [x.fixture.id, afNorm(x, AFINV[x.league.id])]));
      afBase = afBase.map(m => { const l = L.get(m.id); if (l) return l; if (m.st === 'IN_PLAY' || m.st === 'PAUSED') afStale = true; return m; });
      for (const [id, m] of L) if (!afBase.some(b => b.id === id)) afBase.push(m);
    }
    return afBase;
  },
  async standings(c) {
    const r = await af(`/standings?league=${AFID[c]}&season=${SEASON}`);
    const t = (r[0] && r[0].league && r[0].league.standings && r[0].league.standings[0]) || [];
    return t.map(x => [teamCode(afT(x.team)), x.all.win, x.all.draw, x.all.lose, x.points]);
  },
  async pred(id) { const r = await af('/predictions?fixture=' + id), p = r[0] && r[0].predictions; if (!p || !p.percent) return null; const n = x => parseInt(x) || 0; return [n(p.percent.home), n(p.percent.draw), n(p.percent.away)]; },
  async lu(id) { const c = fx.get(id) || {}, lus = await cached('lu' + id, 6e5, () => af('/fixtures/lineups?fixture=' + id)); return { h: afLu(lus, c.h), a: afLu(lus, c.a) }; },
  async detail(id) {
    const c = fx.get(id) || {};
    const [evs, lus, sts, pls] = await Promise.all([
      af('/fixtures/events?fixture=' + id).catch(() => []),
      cached('lu' + id, 6e5, () => af('/fixtures/lineups?fixture=' + id)).catch(() => []),
      af('/fixtures/statistics?fixture=' + id).catch(() => []),
      af('/fixtures/players?fixture=' + id).catch(() => [])]);
    const pr = [];
    pls.forEach(tm => (tm.players || []).forEach(({ player: p, statistics: ss }) => {
      const x = (ss && ss[0]) || {}, gm = x.games || {}, r = parseFloat(gm.rating) || 0;
      if (!gm.minutes && !r) return;
      pr.push({ id: p.id, n: short(p.name), s: tm.team && tm.team.id === (fx.get(id) || {}).h ? 'h' : 'a', r, min: gm.minutes || 0, g: (x.goals && x.goals.total) || 0, a: (x.goals && x.goals.assists) || 0, sv: (x.goals && x.goals.saves) || 0, sh: (x.shots && x.shots.total) || 0, sot: (x.shots && x.shots.on) || 0, pa: (x.passes && x.passes.total) || 0, kp: (x.passes && x.passes.key) || 0, tk: (x.tackles && x.tackles.total) || 0, yc: (x.cards && x.cards.yellow) || 0, rc: (x.cards && x.cards.red) || 0, ph: ph(p.id) });
    }));
    const side = t => t && t.id === c.h ? 'h' : 'a', ev = [];
    evs.forEach(e => {
      const m = (e.time && e.time.elapsed) || 0;
      if (e.type === 'Goal' && !/Missed/i.test(e.detail || '')) ev.push([m, 'g', side(e.team), e.player && e.player.name ? short(e.player.name) : '']);
      else if (e.type === 'Card') ev.push([m, /Red|Second/i.test(e.detail || '') ? 'r' : 'y', side(e.team)]);
      else if (e.type === 'subst') ev.push([m, 's', side(e.team)]);
    });
    ev.sort((p, q) => p[0] - q[0]);
    const st = t => { const x = sts.find(s => s.team && s.team.id === t); if (!x) return null; const g = n => { const r = (x.statistics || []).find(s => s.type === n); return r && r.value != null ? parseInt(r.value) || 0 : 0; }; return [g('Ball Possession'), g('Total Shots'), g('Shots on Goal'), g('Corner Kicks'), g('Fouls'), g('Yellow Cards'), g('Offsides'), g('Goalkeeper Saves'), g('Red Cards')]; };
    const a = st(c.h), b = st(c.a);
    return { ev, st: a && b ? [a, b] : null, lu: { h: afLu(lus, c.h), a: afLu(lus, c.a) }, pr };
  },
  async player(id) {
    const r = await af(`/players?id=${id}&season=${SEASON}`), x = r[0]; if (!x) return {};
    const p = x.player, ss = x.statistics || [], sum = f => ss.reduce((a, s) => a + (+f(s) || 0), 0), mins = sum(s => s.games && s.games.minutes);
    const rt = mins ? ss.reduce((a, s) => a + (parseFloat(s.games && s.games.rating) || 0) * ((s.games && s.games.minutes) || 0), 0) / mins : 0;
    const top = ss.slice().sort((a, b) => ((b.games && b.games.minutes) || 0) - ((a.games && a.games.minutes) || 0))[0] || {};
    return { id: p.id, name: p.name, age: p.age, birth: p.birth || {}, nat: p.nationality, height: p.height, weight: p.weight, ph: p.photo || ph(p.id), inj: !!p.injured,
      team: top.team && top.team.name, pos: top.games && top.games.position,
      st: { apps: sum(s => s.games && s.games.appearences), min: mins, g: sum(s => s.goals && s.goals.total), a: sum(s => s.goals && s.goals.assists), sv: sum(s => s.goals && s.goals.saves), rt: rt ? +rt.toFixed(2) : 0, yc: sum(s => s.cards && s.cards.yellow), rc: sum(s => s.cards && s.cards.red), sh: sum(s => s.shots && s.shots.total), sot: sum(s => s.shots && s.shots.on), kp: sum(s => s.passes && s.passes.key), pa: sum(s => s.passes && s.passes.total), tk: sum(s => s.tackles && s.tackles.total), dr: sum(s => s.dribbles && s.dribbles.success) } };
  },
  async team(id) {
    const [sq, co] = await Promise.all([af('/players/squads?team=' + id), af('/coachs?team=' + id).catch(() => [])]);
    const pg = { Goalkeeper: 'gk', Defender: 'd', Midfielder: 'm', Attacker: 'f' };
    return { coach: (co[0] && co[0].name) || '', squad: ((sq[0] && sq[0].players) || []).map(p => ({ n: short(p.name), id: p.id, ph: p.photo || ph(p.id), g: pg[p.position] || 'm', nat: '', age: p.age || 0, num: p.number || 0 })) };
  }
};

/* ---------- المزوّد التجريبي (1 ثانية حقيقية = 1 دقيقة مباراة) ---------- */
const T0 = Date.now();
const MK = [
  [9001, 'PL', 'LFC', 'ARS', -20, [[7, 'a', 'Saka'], [15, 'h', 'Salah'], [40, 'h', 'Diaz']]],
  [9002, 'PL', 'MCI', 'CFC', -60, [[12, 'h', 'Haaland'], [30, 'h', 'Foden'], [44, 'a', 'Palmer'], [62, 'h', 'Doku']]],
  [9003, 'PD', 'BAR', 'RMA', -5, [[20, 'a', 'Mbappe'], [33, 'h', 'Yamal']]],
  [9004, 'PD', 'ATM', 'SEV', 3, [[4, 'h', 'Griezmann'], [9, 'a', 'Ocampos']]],
  [9005, 'PL', 'TOT', 'NEW', 90, [], { pp: 20 }],
  [9006, 'PD', 'VIL', 'VCF', 150, [], { rs: [25, 260] }],
  [9007, 'PD', 'RVC', 'ESP', 200, []]
];
function mockState(m) {
  const [id, c, h, a, k0, gl, o] = m, el = (Date.now() - T0) / 1000;
  const k = o && o.rs && el >= o.rs[0] ? o.rs[1] : k0, e = el - k;
  const mm = e <= 45 ? e : e <= 60 ? 45 : Math.min(e - 15, 90);
  let hs = 0, as = 0;
  if (e >= 0) gl.forEach(g => { if (g[0] <= mm) g[1] === 'h' ? hs++ : as++; });
  const st = o && o.pp && el >= o.pp && e < 0 ? 'POSTPONED' : e < 0 ? 'TIMED' : e > 105 ? 'FINISHED' : e > 45 && e <= 60 ? 'PAUSED' : 'IN_PLAY';
  return { id, lg: c, utc: new Date(T0 + k * 1000).toISOString(), st, min: st === 'IN_PLAY' ? Math.floor(mm) : null, h: { name: TEAMS[h][1] }, a: { name: TEAMS[a][1] }, hs, as, _m: mm, _g: gl, _h: h, _a: a };
}
const mkLu = c => ({ gk: c + ' GK', d: [1, 2, 3, 4].map(i => c + ' D' + i), m: [1, 2, 3].map(i => c + ' M' + i), f: [1, 2, 3].map(i => c + ' F' + i), b: [c + ' B1', c + ' B2'] });
const MOCKP = {
  async matches(c) { return MK.filter(m => m[1] === c).map(mockState).map(({ _m, _g, _h, _a, ...r }) => r); },
  async team() { return { coach: '', squad: [] }; },
  async pred(id) { return [40 + id % 20, 28, 32 - id % 20]; },
  async player(id) { return { id, name: 'لاعب تجريبي', age: 27, birth: { date: '1999-03-14', place: 'مدريد', country: 'إسبانيا' }, nat: 'Spain', height: '182 cm', weight: '76 kg', ph: '', team: '', pos: 'Midfielder', st: { apps: 9, min: 760, g: 3, a: 2, rt: 7.2, yc: 1, rc: 0, sh: 14, sot: 6, kp: 11, pa: 410, tk: 12, dr: 8, sv: 0 } }; },
  async standings(c) {
    const t = Object.keys(TEAMS).filter(k => TEAMS[k][3] === c);
    return t.map((k, i) => [k, 8 - (i % 6), i % 3, i % 4, (8 - (i % 6)) * 3 + (i % 3)]).sort((a, b) => b[4] - a[4]);
  },
  async detail(id) {
    const m = MK.find(x => x[0] === id); if (!m) throw new Error('no match');
    const s = mockState(m), ev = [];
    m[5].forEach(g => { if (g[0] <= s._m) ev.push([g[0], 'g', g[1], g[2]]); });
    if (s._m >= 25) ev.push([25, 'y', 'a']); if (s._m >= 70) ev.push([70, 's', 'h'], [72, 's', 'a']);
    ev.sort((p, q) => p[0] - q[0]);
    return { ev, st: [[55, 12, 5, 6, 9, 1, 2, 3, 0], [45, 8, 3, 3, 11, 2, 1, 4, 0]], lu: { h: mkLu(m[2]), a: mkLu(m[3]) } };
  }
};
const P = MOCK ? MOCKP : AFK ? AFP : FDP;
const PROV = MOCK ? 'mock' : AFK ? 'api-football' : 'football-data';

/* ---------- الحالة والتنبيهات ---------- */
const SM = { SCHEDULED: 'ns', TIMED: 'ns', IN_PLAY: 'live', LIVE: 'live', PAUSED: 'live', FINISHED: 'ft', AWARDED: 'ft', POSTPONED: 'pp', SUSPENDED: 'pp', CANCELLED: 'cn' };
let LASTERR = '', M = [], ST = {}, LUT = {}, FEED = [], UPD = null, primed = false, last = '';
const PRED = {}, PREDAT = {};
const prev = new Map(), mf = {}, lined = new Set(), lutAt = {}, dc = new Map(), clients = new Set();

function mlabel(x) {
  if (x.st === 'PAUSED') return 'استراحة';
  if (x.min != null) return x.min + '′';
  const e = Math.floor((Date.now() - Date.parse(x.utc)) / 6e4);
  return e < 0 ? 'مباشر' : e <= 45 ? e + '′' : e <= 60 ? 'استراحة' : Math.min(e - 15, 90) + '′';
}
const norm = x => { const s = SM[x.st] || 'ns'; return { id: x.id, lg: lgOf(x.lg).id, h: teamCode(x.h), a: teamCode(x.a), s, hs: x.hs, as: x.as, t: x.utc, ml: s === 'live' ? mlabel(x) : '', note: x.st === 'SUSPENDED' ? 'متوقفة' : '' }; };
const send = str => { for (const r of clients) r.write('data: ' + str + '\n\n'); };
function alert(icon, text, id, x) {
  FEED.unshift({ i: icon, text, at: new Date().toISOString(), id });
  FEED.length = Math.min(FEED.length, 60);
  log(icon, text);
  send(JSON.stringify(Object.assign({ type: 'alert', text: icon + ' ' + text }, x || {})));
}
const teamsPayload = () => { const o = {}; for (const c in TEAMS) o[c] = { ar: TEAMS[c][0], c: TEAMS[c][2], logo: `/logos/${c}.png` }; return Object.assign(o, extra); };
const state = () => ({ teams: teamsPayload(), leagues: COMPS.map(lgOf), standings: ST, matches: M.map(m => PRED[m.id] ? { ...m, p: PRED[m.id] } : m), lineups: LUT, feed: FEED, at: UPD, mock: MOCK, poll: LAZY, err: LASTERR });
function publish() {
  const s = JSON.stringify({ type: 'state', data: state() });
  const key = s.replace(/"at":"[^"]*"/, '');
  if (key !== last) { last = key; send(s); }
}

function update(list) {
  const cur = list.map(norm).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  for (const m of cur) {
    const o = prev.get(m.id), lab = `${nm(m.h)} \u2066${m.as}-${m.hs}\u2069 ${nm(m.a)}`, vs = `${nm(m.h)} × ${nm(m.a)}`;
    if (primed && o) {
      if (o.s === 'ns' && m.s === 'live') alert('🟢', `انطلقت المباراة: ${vs}`, m.id, { h: m.h, a: m.a });
      for (const side of ['h', 'a']) {
        const k = side === 'h' ? 'hs' : 'as';
        if (m[k] > o[k]) {
          (mf[m.id] = mf[m.id] || []).push([parseInt(m.ml) || 0, 'g', side, '']);
          alert('⚽', `هدف! ${nm(m[side])} يسجل — ${lab}${m.ml ? ' (' + m.ml + ')' : ''}`, m.id, { h: m.h, a: m.a, kind: 'goal', team: m[side] });
        } else if (m[k] < o[k]) alert('🔁', `إلغاء هدف في مباراة ${vs}، النتيجة الآن ${lab}`, m.id, { h: m.h, a: m.a });
      }
      if (o.ml !== 'استراحة' && m.ml === 'استراحة') alert('⏱️', `استراحة بين الشوطين: ${lab}`, m.id, { h: m.h, a: m.a });
      if (o.s !== 'ft' && m.s === 'ft') alert('🏁', `انتهت المباراة: ${lab}`, m.id, { h: m.h, a: m.a });
      if (o.s !== 'pp' && m.s === 'pp') alert('⏸️', `${m.note || 'تأجيل'} المباراة: ${vs}`, m.id, { h: m.h, a: m.a });
      if (o.s !== 'cn' && m.s === 'cn') alert('🚫', `إلغاء المباراة: ${vs}`, m.id, { h: m.h, a: m.a });
      if (o.s === 'pp' && m.s === 'ns') alert('📅', `أُعيدت جدولة ${vs} إلى ${fT.format(new Date(m.t))}`, m.id, { h: m.h, a: m.a });
      else if (m.s === 'ns' && Math.abs(Date.parse(m.t) - Date.parse(o.t)) > 6e4) alert('🕒', `تغيّر موعد ${vs} إلى ${fT.format(new Date(m.t))}`, m.id, { h: m.h, a: m.a });
    }
    prev.set(m.id, m);
  }
  scoreFinished(cur); primed = true; M = cur; UPD = new Date().toISOString(); publish();
}

function setLUT(m, d) {
  const when = Date.parse(m.t);
  [['h', m.h], ['a', m.a]].forEach(([s, c]) => { if (d.lu && d.lu[s] && when > (lutAt[c] || 0)) { LUT[c] = d.lu[s]; lutAt[c] = when; } });
}
async function detail(id) {
  const c = dc.get(id), m = M.find(x => x.id === id), ttl = m && m.s === 'live' ? 12e3 : 12e4;
  if (c && Date.now() - c.at < ttl) return c.v;
  let v = { ev: [], st: null, lu: null };
  try { v = await P.detail(id); } catch (e) { log('detail', e.message); }
  if (!v.ev.some(e => e[1] === 'g') && mf[id]) v = { ...v, ev: [...v.ev, ...mf[id]].sort((a, b) => a[0] - b[0]) };
  dc.set(id, { at: Date.now(), v });
  if (m && v.lu) setLUT(m, v);
  return v;
}

/* ---------- حلقات الجلب ---------- */
async function refreshOnce() {
  try {
    const now = Date.now(), all = []; LASTERR = '';
    if (P.all) all.push(...await P.all(COMPS, now - 7 * 864e5, now + 7 * 864e5)); else for (const c of COMPS) all.push(...await P.matches(c, now - 7 * 864e5, now + 7 * 864e5));
    if (!all.length && !MOCK) LASTERR = 'المزوّد أعاد قائمة مباريات فارغة';
    update(all);
    // توقعات الفوز/التعادل/الخسارة للمباريات القادمة (تتجدد كل 3 ساعات)
    if (P.pred && !(P.slow && P.slow())) {
      const n = Date.now(), todo = M.filter(m => m.s === 'ns' && Date.parse(m.t) > n && Date.parse(m.t) - n < 4 * 864e5 && (!(m.id in PRED) || (n - (PREDAT[m.id] || 0) > 108e5 && Date.parse(m.t) - n < 864e5))).slice(0, LAZY ? 6 : 2);
      for (const m of todo) { PREDAT[m.id] = n; try { PRED[m.id] = await P.pred(m.id) || null; } catch (e) { PRED[m.id] = null; log('pred', e.message); } }
      if (todo.length) publish();
    }
    // تعبئة تشكيلات "آخر مباراة" تدريجياً (طلب واحد كل دورة) لاستخدامها كتشكيلة متوقعة
    if (!(P.slow && P.slow()) && (MOCK || AFK || prune() <= 4)) {
      const t = M.find(m => m.s === 'ft' && !lined.has(m.id) && now - Date.parse(m.t) < 5 * 864e5);
      if (t) { try { setLUT(t, P.lu ? { lu: await P.lu(t.id) } : await P.detail(t.id)); lined.add(t.id); publish(); } catch (e) { log('lineup', e.message); } }
    }
  } catch (e) { LASTERR = e.message; log('poll error:', e.message); }
}
const nearNow = () => { const n = Date.now(); return M.some(m => m.s === 'live' || (m.s === 'ns' && Date.parse(m.t) - n < 3e5 && Date.parse(m.t) - n > -36e5)); };
const wait = () => (P.slow && P.slow()) ? 900 : nearNow() ? LIVE_S : IDLE_S;
async function pollMatches() { await refreshOnce(); setTimeout(pollMatches, wait() * 1000); }
async function refreshStandings() {
  for (const c of COMPS) { try { ST[lgOf(c).id] = await P.standings(c); } catch (e) { log('standings', e.message); } }
  publish();
}
async function pollStandings() { await refreshStandings(); setTimeout(pollStandings, 6e5); }
// وضع Vercel: تحديث عند الطلب فقط (يُخزَّن الرد مؤقتاً في شبكة Vercel لتقليل الطلبات)
let lastRef = 0, lastSt = 0, refreshing = null;
async function ensureFresh() {
  if (!LAZY) return;
  if (!M.length || Date.now() - lastRef >= wait() * 1000) {
    if (!refreshing) refreshing = (async () => {
      try { await dbLoad(); await refreshOnce(); if (Date.now() - lastSt > 6e5) { lastSt = Date.now(); await refreshStandings(); } closeWeek(); await flush(); }
      finally { lastRef = Date.now(); refreshing = null; }
    })();
    await refreshing;
  }
}

/* ---------- المسابقة والنقاط (حفظ في ملف JSON) ---------- */
const crypto = require('crypto');
const DATA = process.env.DATA_FILE || (LAZY ? '/tmp/data.json' : path.join(__dirname, 'data.json'));
const PRIZE = process.env.PRIZE_TEXT || 'اشتراك مجاني لمدة شهر', ADMIN = process.env.ADMIN_KEY || '';
const UP_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '', UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const DB0 = () => ({ users: {}, preds: {}, scored: [], winners: [], closed: '' });
let DB = DB0();
try { DB = Object.assign(DB, JSON.parse(fs.readFileSync(DATA, 'utf8'))); } catch (e) { }
let dirty = false, dbAt = 0; const save = () => { dirty = true; };
async function up(cmd) {
  const r = await fetch(UP_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
}
async function dbLoad() {            // قراءة أحدث نسخة من Upstash (بحد أقصى كل 3 ثوانٍ)
  if (!UP_URL || Date.now() - dbAt < 3000) return;
  try { const v = await up(['GET', 'kora:db']); if (v) DB = Object.assign(DB0(), JSON.parse(v)); dbAt = Date.now(); } catch (e) { log('db load', e.message); }
}
async function flush() {
  if (!dirty) return; dirty = false;
  try { if (UP_URL) await up(['SET', 'kora:db', JSON.stringify(DB)]); else fs.writeFileSync(DATA, JSON.stringify(DB)); }
  catch (e) { log('save', e.message); dirty = true; }
}
if (!LAZY) setInterval(flush, 5000);
const day8 = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Baghdad' });
function weekOf(d) { const x = new Date(day8(d) + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - (x.getUTCDay() + 6) % 7); return x.toISOString().slice(0, 10); }
const weekEnd = w => new Date(Date.parse(w + 'T00:00:00+03:00') + 7 * 864e5).toISOString();
const okUid = u => typeof u === 'string' && /^[a-z0-9]{6,40}$/.test(u);
const clean = n => String(n || '').replace(/[<>&"'`]/g, '').trim().slice(0, 20) || 'متسابق';
function user(uid, nick) { const u = DB.users[uid] = DB.users[uid] || { nick: 'متسابق', pts: {}, total: 0, q: {}, dl: '' }; if (nick) u.nick = clean(nick); return u; }
function addPts(uid, n, wk) { const u = user(uid); u.pts[wk] = (u.pts[wk] || 0) + n; u.total += n; save(); }
function board(key, uid) {
  const rows = Object.entries(DB.users).map(([id, u]) => ({ id, nick: u.nick, pts: key ? (u.pts[key] || 0) : u.total })).filter(x => x.pts > 0).sort((a, b) => b.pts - a.pts);
  rows.forEach((x, i) => x.r = i + 1);
  const me = rows.find(x => x.id === uid) || { r: rows.length + 1, pts: 0 };
  return { top: rows.slice(0, 10).map(x => ({ r: x.r, nick: x.nick, pts: x.pts, me: x.id === uid })), me: { r: me.r, pts: me.pts } };
}
function league(uid) {
  const wk = weekOf(Date.now()), win = DB.winners.filter(w => w.uid === uid).slice(-1)[0];
  return { prize: PRIZE, volatile: LAZY && !UP_URL, end: weekEnd(wk), wk: board(wk, uid), all: board(null, uid), mine: win && Date.now() - Date.parse(win.at) < 14 * 864e5 ? win.code : '' };
}
function closeWeek() {
  const cw = weekOf(Date.now());
  if (!DB.closed) { DB.closed = cw; save(); return; }
  if (DB.closed === cw) return;
  const pw = DB.closed, rows = Object.entries(DB.users).map(([id, u]) => ({ id, nick: u.nick, pts: u.pts[pw] || 0 })).filter(x => x.pts > 0).sort((a, b) => b.pts - a.pts);
  if (rows[0]) {
    DB.winners.push({ week: pw, uid: rows[0].id, nick: rows[0].nick, pts: rows[0].pts, code: 'KORA-' + crypto.randomBytes(3).toString('hex').toUpperCase(), at: new Date().toISOString() });
    alert('🏆', `فاز ${rows[0].nick} بدوري الأسبوع برصيد ${rows[0].pts} نقطة وحصل على: ${PRIZE}`, 0, { kind: 'win' });
  }
  DB.closed = cw; save(); send(JSON.stringify({ type: 'lb' }));
}
function scoreFinished(list) {
  let ch = false;
  for (const m of list) {
    if (m.s !== 'ft' || DB.scored.includes(m.id)) continue;
    DB.scored.push(m.id); ch = true;
    const p = DB.preds[m.id]; if (!p) continue;
    const wk = weekOf(m.t);
    for (const uid in p) { const [a, b] = p[uid]; const pt = (a === m.hs && b === m.as) ? 5 : (Math.sign(a - b) === Math.sign(m.hs - m.as)) ? 2 : 0; if (pt) addPts(uid, pt, wk); }
  }
  if (ch) { if (DB.scored.length > 5000) DB.scored = DB.scored.slice(-3000); save(); send(JSON.stringify({ type: 'lb' })); }
}
const readBody = req => { const pb = req.body; if (pb && typeof pb === 'object' && !Buffer.isBuffer(pb)) return Promise.resolve(pb); if (typeof pb === 'string') { try { return Promise.resolve(JSON.parse(pb)); } catch (e) { return Promise.resolve({}); } } return new Promise(r => { let b = ''; req.on('data', c => { b += c; if (b.length > 2048) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } }); }); };
const pcache = new Map();
async function playerInfo(id) {
  const c = pcache.get(id); if (c && Date.now() - c.at < 216e5) return c.v;
  let v = {}; try { v = await (P.player ? P.player(id) : {}); } catch (e) { log('player', e.message); }
  v = Object.assign({}, v, EXTRAS[id] || {});
  if (v.name) pcache.set(id, { at: Date.now(), v });
  return v;
}
const tcache = new Map();
async function teamInfo(code) {
  const c = tcache.get(code); if (c && Date.now() - c.at < 216e5) return c.v;
  let v = { coach: '', squad: [] };
  if (tid[code]) { try { v = await P.team(tid[code]); } catch (e) { log('team', e.message); } }
  if (v.squad.length) tcache.set(code, { at: Date.now(), v });
  return v;
}

/* ---------- خادم HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const cc = n => LAZY ? `public, s-maxage=${n}, stale-while-revalidate=${n * 2}` : 'no-store';
const json = async (res, o, c) => { if (LAZY && dirty) await flush(); res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': c || 'no-store' }); res.end(JSON.stringify(o)); };
const handle = async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (LAZY && (u.pathname.startsWith('/api/') || u.pathname === '/healthz')) { await ensureFresh(); if (u.pathname === '/api/league' || req.method === 'POST') await dbLoad(); }
  if (u.pathname === '/api/state') return json(res, state(), cc(nearNow() ? 8 : 45));
  if (u.pathname === '/healthz' || u.pathname === '/api/healthz') return json(res, { ok: true, mock: MOCK, provider: PROV, error: LASTERR, lazy: LAZY, db: UP_URL ? 'upstash' : LAZY ? 'temporary' : 'file', matches: M.length, quota: AFK ? afRemain : undefined });
  if (u.pathname === '/api/stream') {
    if (LAZY) { res.writeHead(404); return res.end('no stream'); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n'); clients.add(res);
    res.write('data: ' + JSON.stringify({ type: 'state', data: state() }) + '\n\n');
    req.on('close', () => clients.delete(res)); return;
  }
  if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
    const b = await readBody(req);
    if (!okUid(b.uid)) return json(res, { error: 'معرّف غير صالح' });
    if (u.pathname === '/api/join') { user(b.uid, b.nick); save(); return json(res, { ok: true }); }
    if (u.pathname === '/api/predict') {
      const m = M.find(x => x.id === +b.matchId), h = +b.h, a = +b.a;
      if (!m || m.s !== 'ns' || Date.parse(m.t) < Date.now() + 30000) return json(res, { error: 'أُغلق باب التوقع لهذه المباراة' });
      if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0 || h > 9 || a > 9) return json(res, { error: 'نتيجة غير صالحة' });
      DB.preds[m.id] = DB.preds[m.id] || {};
      if (DB.preds[m.id][b.uid]) return json(res, { error: 'سجّلت توقعك لهذه المباراة سابقاً' });
      user(b.uid); DB.preds[m.id][b.uid] = [h, a]; save(); return json(res, { ok: true });
    }
    if (u.pathname === '/api/bonus') {
      const us = user(b.uid), d = day8(Date.now()), wk = weekOf(Date.now());
      if (b.kind === 'quiz') { us.q[d] = us.q[d] || 0; if (us.q[d] >= 5) return json(res, { pts: 0 }); us.q[d]++; addPts(b.uid, 10, wk); return json(res, { pts: 10 }); }
      if (b.kind === 'daily') { if (us.dl === d) return json(res, { pts: 0 }); us.dl = d; addPts(b.uid, 3, wk); return json(res, { pts: 3 }); }
      return json(res, { pts: 0 });
    }
    res.writeHead(404); return res.end('not found');
  }
  if (u.pathname === '/api/league') return json(res, league(u.searchParams.get('uid') || ''));
  if (u.pathname === '/api/winners') { if (!ADMIN || u.searchParams.get('key') !== ADMIN) { res.writeHead(403); return res.end('forbidden'); } return json(res, DB.winners); }
  const pm = u.pathname.match(/^\/api\/player\/(\d+)$/);
  if (pm) return json(res, await playerInfo(+pm[1]), cc(3600));
  const tm = u.pathname.match(/^\/api\/team\/([A-Za-z0-9]{2,5})$/);
  if (tm) return json(res, await teamInfo(tm[1]), cc(3600));
  const mt = u.pathname.match(/^\/api\/match\/(\d+)$/);
  if (mt) { const mm = M.find(x => x.id === +mt[1]); return json(res, await detail(+mt[1]), cc(mm && mm.s === 'live' ? 8 : 120)); }
  // للأمان: لا يُقدَّم إلا ملف الواجهة (لا يمكن لأحد تحميل .env أو الكود)
  if (u.pathname !== '/' && u.pathname !== '/index.html') { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
};
function start() {
  http.createServer(handle).listen(PORT, () => log(`كورة برو يعمل على المنفذ ${PORT} • ${MOCK ? 'وضع تجريبي (بدون مفتاح)' : 'بيانات حقيقية من ' + PROV}`));
  if (LAZY) return;
  setInterval(() => { for (const r of clients) r.write(': ping\n\n'); }, 25000);
  setInterval(closeWeek, 60000); closeWeek();
  pollMatches(); pollStandings();
}
module.exports = (req, res) => handle(req, res);   // Vercel يستدعي هذه الدالة
module.exports.start = start;
if (require.main === module) start();
