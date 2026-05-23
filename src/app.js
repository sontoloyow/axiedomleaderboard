const https   = require("https");
const express = require("express");
const cron    = require("node-cron");
const fs      = require("fs");
const path    = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const { fetchClaimHistory } = require("./services/explorer");

const app  = express();
const PORT = process.env.PORT || 3000;
const PROJECT_ROOT = path.join(__dirname, "..");

const MY_ADDRESS = process.env.MY_ADDRESS  || "";
const COOKIE     = process.env.AXIE_COOKIE || "";

// ── STORAGE ───────────────────────────────────────────────────────────────────
const DATA_DIR      = fs.existsSync("/data") ? "/data" : path.join(PROJECT_ROOT, "data");
const SNAPSHOT_FILE = path.join(DATA_DIR, "snapshot.json");
const WINNERS_FILE  = path.join(DATA_DIR, "winners.json");
const WEEKS_DIR     = path.join(DATA_DIR, "weeks");  // week archive: week_15.json, week_16.json ...

if (!fs.existsSync(DATA_DIR))  fs.mkdirSync(DATA_DIR,  { recursive: true });
if (!fs.existsSync(WEEKS_DIR)) fs.mkdirSync(WEEKS_DIR, { recursive: true });

console.log("[storage] DATA_DIR:", DATA_DIR, "| volume:", fs.existsSync("/data"));

// ── IN-MEMORY STATE ───────────────────────────────────────────────────────────
let leaderboardData = null;   // current week players[]
let poolData        = null;   // current week pool info
let jackpotData     = null;
let winnerLog       = [];
let winnerTally     = {};
let lastUpdate      = null;
let lastWinnerTs    = 0;
let prevJackpotBal  = null;

// ── REQUEST HEADERS ───────────────────────────────────────────────────────────
function getHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0",
    Accept: "*/*", "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://axiedom.xyz/", Connection: "keep-alive", Cookie: COOKIE,
  };
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: getHeaders() }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { reject(new Error(`JSON parse error ${res.statusCode}: ${raw.slice(0,200)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// ── WEEK ARCHIVE ──────────────────────────────────────────────────────────────
function weekFile(n) { return path.join(WEEKS_DIR, `week_${n}.json`); }

function saveWeekArchive(weekNumber, players, poolInfo) {
  const f = weekFile(weekNumber);
  try {
    fs.writeFileSync(f, JSON.stringify({ weekNumber, savedAt: new Date().toISOString(), pool: poolInfo, players }, null, 2));
    console.log(`[weeks] archived week ${weekNumber} (${players.length} players)`);
  } catch (e) { console.error("[weeks] save error:", e.message); }
}

function loadWeekArchive(weekNumber) {
  const f = weekFile(weekNumber);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); }
  catch { return null; }
}

function listArchivedWeeks() {
  try {
    return fs.readdirSync(WEEKS_DIR)
      .filter(f => f.match(/^week_\d+\.json$/))
      .map(f => parseInt(f.match(/\d+/)[0]))
      .sort((a, b) => b - a);  // newest first
  } catch { return []; }
}

// ── SNAPSHOT (keys diff) ──────────────────────────────────────────────────────
function loadSnapshot() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8")); }
  catch { return null; }
}
function saveSnapshot(players, weekNumber) {
  const data = { savedAt: new Date().toISOString(), weekNumber, keys: {} };
  players.forEach(p => { data.keys[p.address.toLowerCase()] = p.totalKeysSpent; });
  try { fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error("[snapshot] error:", e.message); }
}

// ── WINNERS PERSISTENCE ───────────────────────────────────────────────────────
function loadWinners() {
  if (!fs.existsSync(WINNERS_FILE)) return { log: [], tally: {}, lastTs: 0 };
  try { return JSON.parse(fs.readFileSync(WINNERS_FILE, "utf8")); }
  catch { return { log: [], tally: {}, lastTs: 0 }; }
}
function saveWinners() {
  try {
    fs.writeFileSync(WINNERS_FILE, JSON.stringify(
      { savedAt: new Date().toISOString(), jackpot: jackpotData, log: winnerLog.slice(0,500), tally: winnerTally, lastTs: lastWinnerTs }, null, 2));
  } catch (e) { console.error("[winners] error:", e.message); }
}

// ── WINNER PATTERNS ───────────────────────────────────────────────────────────
const WINNER_PATTERNS = [
  /^(.+?)\s+defeated The Werewolf and claimed the blessing!$/,
  /^(.+?)[…\.]+\s+just became a legend by defeating The Werewolf!$/,
  /^Victory!\s+(.+?)\s+slayed The Werewolf for the blessing!$/,
  /^The Werewolf has fallen!\s+(.+?)\s+wins the blessing!$/,
  /^(.+?)\s+just became a legend by defeating The Werewolf!$/,
  /^(.+?)\s+conquered The Werewolf and struck it rich!$/,
  /^All hail (.+?), slayer of The Werewolf!$/,
  /^(.+?)\s+has proven their worth and claimed the ultimate prize!$/,
  /^The treasure is theirs!\s+(.+?)\s+vanquished The Werewolf!$/,
];
function extractWinner(text) {
  for (const p of WINNER_PATTERNS) { const m = (text||"").trim().match(p); if (m) return m[1].trim(); }
  return null;
}
function addWinner(name, tier, prize, ts) {
  winnerLog.push({ ts, name, tier, prize: +prize.toFixed(2) });
  if (!winnerTally[name]) winnerTally[name] = { MEGA:0, MAJOR:0, MINOR:0, total:0, totalPrize:0 };
  winnerTally[name][tier]++;
  winnerTally[name].total++;
  winnerTally[name].totalPrize = +(winnerTally[name].totalPrize + prize).toFixed(2);
  if (ts > lastWinnerTs) lastWinnerTs = ts;
}

async function seedChatBaseline() {
  console.log("[init] seeding chat baseline...");
  try {
    const res = await fetchJSON("https://axiedom.xyz/api/chat/history?limit=50");
    if (res.status !== 200) return;
    const msgs = (res.body.messages||[]).filter(m => m.sender==="system" && m.messageType==="event");
    if (msgs.length) {
      lastWinnerTs = Math.max(...msgs.map(m => m.timestamp||0));
      console.log("[init] baseline ts:", lastWinnerTs);
    }
  } catch (e) { console.error("[init]", e.message); }
}

// ── BUILD ALLTIME AGGREGATE ───────────────────────────────────────────────────
function buildAlltimeData() {
  const weeks  = listArchivedWeeks();
  const merged = {};  // address -> { name, treasure, marbles, runCount, keys, payout, cost, earning }
  for (const wn of weeks) {
    const w = loadWeekArchive(wn);
    if (!w || !w.players) continue;
    for (const p of w.players) {
      const addr = p.address.toLowerCase();
      if (!merged[addr]) merged[addr] = { name: p.profileName||p.address.slice(0,8)+"…", address: p.address, treasure:0, marbles:0, runCount:0, keys:0, payout:0, cost:0, earning:0 };
      merged[addr].treasure  += p.treasure  || 0;
      merged[addr].marbles   += p.marbles   || 0;
      merged[addr].runCount  += p.runCount  || 0;
      merged[addr].keys      += p.totalKeysSpent || 0;
      merged[addr].payout    += p.payout    || 0;
      merged[addr].cost      += p.cost      || 0;
      merged[addr].earning   += p.earning   || 0;
    }
  }
  return Object.values(merged).sort((a,b) => b.treasure - a.treasure).map((p,i) => ({ ...p, rank: i+1, payout: +p.payout.toFixed(4), earning: +p.earning.toFixed(4) }));
}

// ── REFRESH LEADERBOARD ───────────────────────────────────────────────────────
async function refreshLeaderboard() {
  console.log("[lb]", new Date().toISOString());
  try {
    const [lbRes, poolRes] = await Promise.all([
      fetchJSON(`https://axiedom.xyz/api/runs?mode=weekly&address=${MY_ADDRESS}`),
      fetchJSON("https://axiedom.xyz/api/weekly-pool"),
    ]);
    if (lbRes.status !== 200) throw new Error("LB HTTP " + lbRes.status);
    if (poolRes.status !== 200) throw new Error("Pool HTTP " + poolRes.status);

    const lb   = lbRes.body;
    const pool = poolRes.body;
    const poolUSDT      = parseInt(pool.currentPoolWei) / 1_000_000;
    const totalTreasure = lb.totalGlobalTreasure;
    const currentWeek   = lb.weekNumber;

    const snapshot   = loadSnapshot();
    const isSameWeek = snapshot && snapshot.weekNumber === currentWeek;

    // Archive previous week if week changed
    if (snapshot && snapshot.weekNumber && snapshot.weekNumber !== currentWeek) {
      const prevArchive = loadWeekArchive(snapshot.weekNumber);
      if (!prevArchive) {
        console.log(`[weeks] week changed ${snapshot.weekNumber} -> ${currentWeek}, archiving prev week data`);
        // We don't have prev week players anymore from API, so we skip — will be captured going forward
      }
    }

    let players = [...(lb.leaderboard||[])];
    const addrs = new Set(players.map(p => p.address.toLowerCase()));
    if (lb.userStats && !addrs.has(lb.userStats.address.toLowerCase())) players.push(lb.userStats);
    players.sort((a,b) => a.rank - b.rank);

    const processed = players.map(p => {
      const payout   = (poolUSDT / totalTreasure) * p.treasure;
      const cost     = p.totalKeysSpent * 2;
      const earning  = payout - cost;
      const prev     = isSameWeek ? snapshot.keys[p.address.toLowerCase()] : undefined;
      const keysDiff = prev !== undefined ? p.totalKeysSpent - prev : null;
      return { ...p, payout: +payout.toFixed(4), cost, earning: +earning.toFixed(4), keysDiff };
    });

    leaderboardData = processed;
    poolData = { poolUSDT, totalTreasure, weekNumber: currentWeek, weekEnd: pool.weekEnd, total: lb.total };
    lastUpdate = new Date().toISOString();

    // Archive current week to disk every refresh (overwrite with latest)
    saveWeekArchive(currentWeek, processed, poolData);
    saveSnapshot(players, currentWeek);
    console.log("[lb] done", players.length, "rows, week", currentWeek);
  } catch (e) { console.error("[lb] error:", e.message); }
}

// ── REFRESH JACKPOT ───────────────────────────────────────────────────────────
async function refreshJackpot() {
  console.log("[jk]", new Date().toISOString());
  try {
    const poolRes = await fetchJSON("https://axiedom.xyz/api/jackpot/pool");
    if (poolRes.status !== 200) throw new Error("Jackpot HTTP " + poolRes.status);
    const pool    = poolRes.body;
    const currBal = parseInt(pool.balanceWei);
    const usdt    = currBal / 1_000_000;

    jackpotData = {
      poolUSDT:   usdt, balanceWei: pool.balanceWei,
      totalAdded: +(parseInt(pool.totalAddedWei) / 1_000_000).toFixed(2),
      totalPaid:  +(parseInt(pool.totalPaidWei)  / 1_000_000).toFixed(2),
      mega: +(usdt*0.02).toFixed(2), major: +(usdt*0.005).toFixed(2), minor: +(usdt*0.001).toFixed(2),
    };

    const poolDropped = prevJackpotBal !== null && currBal < prevJackpotBal;
    const dropUSDT    = poolDropped ? (prevJackpotBal - currBal) / 1_000_000 : 0;
    if (poolDropped) console.log(`[jk] pool drop $${dropUSDT.toFixed(2)}`);
    prevJackpotBal = currBal;

    const chatRes = await fetchJSON("https://axiedom.xyz/api/chat/history?limit=50");
    if (chatRes.status !== 200) throw new Error("Chat HTTP " + chatRes.status);

    const newMsgs = (chatRes.body.messages||[])
      .filter(m => m.sender==="system" && m.messageType==="event" && m.timestamp > lastWinnerTs)
      .sort((a,b) => a.timestamp - b.timestamp);

    const TIER_PCT = { MEGA:0.02, MAJOR:0.005, MINOR:0.001 };
    for (const msg of newMsgs) {
      const winner = extractWinner(msg.text||"");
      if (!winner) continue;
      let tier="MINOR", prize=usdt*TIER_PCT.MINOR;
      if (poolDropped && dropUSDT > 0) {
        const d = (a,b) => Math.abs(a-b);
        const meg=usdt*TIER_PCT.MEGA, maj=usdt*TIER_PCT.MAJOR, min=usdt*TIER_PCT.MINOR;
        if (d(dropUSDT,meg)<d(dropUSDT,maj) && d(dropUSDT,meg)<d(dropUSDT,min)) { tier="MEGA"; prize=meg; }
        else if (d(dropUSDT,maj)<d(dropUSDT,min)) { tier="MAJOR"; prize=maj; }
      }
      console.log(`[jk] winner: ${winner} | ${tier} | $${prize.toFixed(2)}`);
      addWinner(winner, tier, prize, msg.timestamp);
    }

    winnerLog.sort((a,b) => b.ts - a.ts);
    if (winnerLog.length > 500) winnerLog = winnerLog.slice(0,500);
    saveWinners();
    console.log(`[jk] done pool=$${usdt.toFixed(2)} winners=${winnerLog.length}`);
  } catch (e) { console.error("[jk] error:", e.message); }
}

// ── SHARED CSS & NAV ──────────────────────────────────────────────────────────
const SHARED_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
:root{--neon:#C8FF00;--dark:#0a0a0a;--surface:#111;--surface2:#181818;--border:#2a2a2a;--muted:#666;--red:#ff4444}
body{background:var(--dark);color:#fff;font-family:'Courier New',monospace;min-height:100vh;display:flex;flex-direction:column}
nav{display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:56px;border-bottom:1px solid var(--border);background:var(--dark);flex-shrink:0}
.logo{font-size:13px;font-weight:700;letter-spacing:3px;color:var(--neon)}
.nav-links{display:flex}
.nav-btn{background:none;border:none;color:var(--muted);font-family:inherit;font-size:11px;letter-spacing:2px;padding:0 18px;height:56px;cursor:pointer;border-bottom:2px solid transparent;transition:color .15s;text-decoration:none;display:flex;align-items:center}
.nav-btn:hover{color:#fff}
.nav-btn.active{color:var(--neon);border-bottom:2px solid var(--neon)}
.play-btn{background:var(--neon);color:#000;border:none;font-family:inherit;font-size:11px;letter-spacing:2px;padding:8px 20px;cursor:pointer;font-weight:700;text-decoration:none}
.panel{padding:28px 24px;flex:1}
.sys-label{font-size:10px;letter-spacing:3px;color:var(--muted);margin-bottom:12px;display:flex;align-items:center;gap:8px}
.sys-label::before{content:'';display:inline-block;width:24px;height:1px;background:var(--muted)}
h1{font-size:44px;font-weight:900;letter-spacing:-1px;line-height:1;margin-bottom:4px;text-transform:uppercase}
h1 span{color:var(--neon)}
.subtitle{font-size:11px;letter-spacing:2px;color:var(--muted);margin-bottom:24px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.version-tag{border:1px solid var(--border);padding:2px 10px;font-size:10px;color:var(--muted)}
.dot{width:6px;height:6px;border-radius:50%;background:var(--neon);display:inline-block;animation:blink 1.5s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}
.update-bar{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;gap:8px;flex-wrap:wrap}
.update-time{font-size:10px;color:var(--muted);letter-spacing:1px;margin-top:3px}
.status-live{display:flex;align-items:center;gap:6px;font-size:10px;letter-spacing:2px;color:var(--muted)}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:1px;background:var(--border);border:1px solid var(--border);margin-bottom:20px}
.stat-card{background:var(--surface);padding:16px 14px}
.stat-label{font-size:9px;letter-spacing:3px;color:var(--muted);margin-bottom:6px;text-transform:uppercase}
.stat-value{font-size:19px;font-weight:700;color:var(--neon)}
.tbl-wrap{border:1px solid var(--border);overflow-x:auto}
table{width:100%;border-collapse:collapse;min-width:600px}
th{background:var(--surface2);color:var(--muted);font-size:9px;letter-spacing:2px;padding:10px 12px;text-align:left;border-bottom:1px solid var(--border);white-space:nowrap;text-transform:uppercase}
th.sortable{cursor:pointer;user-select:none}
th.sortable:hover{color:#fff}
th.sortable.asc::after{content:" ▲";color:var(--neon)}
th.sortable.desc::after{content:" ▼";color:var(--neon)}
td{padding:9px 12px;font-size:12px;border-bottom:1px solid #1a1a1a;white-space:nowrap;color:#fff}
tr:last-child td{border-bottom:none}
tr:hover td{background:#141400}
.rank-num{color:var(--muted);font-size:11px}
.rank-gold{color:var(--neon);font-weight:700}
.rank-silver{color:#c0c0c0;font-weight:700}
.rank-bronze{color:#cd7f32;font-weight:700}
.name-cell{font-weight:700;font-size:12px}
.pool-bar{background:var(--surface2);border:1px solid var(--border);padding:14px 20px;margin-bottom:18px;display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:14px}
.pool-label{font-size:9px;letter-spacing:3px;color:var(--muted);text-transform:uppercase;margin-bottom:5px}
.pool-value{font-size:26px;font-weight:700;color:var(--neon);line-height:1}
.pool-meta{font-size:10px;color:var(--muted);margin-top:4px;letter-spacing:1px}
.winner-log{border:1px solid var(--border);background:var(--surface);margin-bottom:18px;max-height:380px;overflow-y:auto}
.log-header{background:var(--surface2);padding:9px 16px;font-size:9px;letter-spacing:3px;color:var(--muted);border-bottom:1px solid var(--border);text-transform:uppercase;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0}
.log-row{padding:8px 16px;border-bottom:1px solid #161616;display:grid;grid-template-columns:160px 1fr 80px 100px;gap:12px;align-items:center;font-size:11px}
.log-row:last-child{border-bottom:none}
.log-time{color:var(--muted);font-size:10px;letter-spacing:1px}
.log-name{font-weight:700;color:#fff}
.log-prize{color:var(--neon);text-align:right;font-weight:700}
.empty-state{padding:28px;text-align:center;color:var(--muted);font-size:10px;letter-spacing:2px}
.section-title{font-size:9px;letter-spacing:3px;color:var(--muted);text-transform:uppercase;margin-bottom:8px;margin-top:18px}
.week-bar{display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap}
.week-select{background:var(--surface2);border:1px solid var(--border);color:#fff;font-family:'Courier New',monospace;font-size:10px;letter-spacing:1px;padding:6px 10px;cursor:pointer;outline:none}
.week-select option{background:var(--surface2)}
.week-label{font-size:9px;letter-spacing:2px;color:var(--muted);text-transform:uppercase}
footer{padding:14px 24px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;flex-shrink:0}
.footer-copy{font-size:9px;letter-spacing:2px;color:var(--muted)}
.footer-rpc{font-size:9px;letter-spacing:1px;color:var(--muted);display:flex;align-items:center;gap:6px}
.baxs-val{color:#a78bfa;font-weight:700}
`;

const NAV = (active, weekVal = "") => {
  const weekQuery = weekVal ? `?week=${encodeURIComponent(weekVal)}` : "";
  return `
<nav>
  <span class="logo">MOG_STATS</span>
  <div class="nav-links">
    <a href="/${weekQuery}" class="nav-btn${active==="lb"?" active":""}">LEADERBOARD</a>
    <a href="/shards" class="nav-btn${active==="sh"?" active":""}">SHARDS</a>
    <a href="/jackpot${weekQuery}" class="nav-btn${active==="jk"?" active":""}">JACKPOT</a>
  </div>
  <a href="https://axiedom.xyz" target="_blank" class="play-btn">PLAY NOW</a>
</nav>`;
};

const FOOTER = `
<footer>
  <span class="footer-copy">© 2026 MOG_STATS // TECHNICAL_SERVICES_DIV</span>
  <div style="display:flex;gap:24px;align-items:center">
    <div class="footer-rpc"><span class="dot" style="animation:none"></span>BLACK_GREEN // V2.0_LIVE</div>
    <div class="footer-rpc">RPC: RONIN_MAINNET</div>
  </div>
</footer>`;

// ── HELPER: resolve players for a given week selector value ───────────────────
function resolveWeekData(weekVal) {
  // weekVal: "current" | "alltime" | number string
  if (weekVal === "current" || !weekVal) {
    return { players: leaderboardData, label: poolData ? "WEEK #"+poolData.weekNumber : "CURRENT WEEK", pool: poolData };
  }
  if (weekVal === "alltime") {
    const all = buildAlltimeData();
    return { players: all, label: "ALL TIME", pool: null };
  }
  const wn = parseInt(weekVal);
  const arch = loadWeekArchive(wn);
  if (!arch) return { players: [], label: "WEEK #"+wn, pool: arch ? arch.pool : null };
  return { players: arch.players, label: "WEEK #"+wn, pool: arch.pool };
}

function parseTimeValue(value) {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function getArchivedWeekData() {
  return listArchivedWeeks()
    .map(wn => loadWeekArchive(wn))
    .filter(Boolean)
    .sort((a, b) => a.weekNumber - b.weekNumber);
}

function buildWeekOptions(weekVal, currWeek) {
  const weeks = listArchivedWeeks();
  return [
    `<option value="current"${weekVal==="current"||!weekVal?" selected":""}>CURRENT WEEK${currWeek?" (W"+currWeek+")":""}</option>`,
    `<option value="alltime"${weekVal==="alltime"?" selected":""}>ALL TIME</option>`,
    ...weeks.filter(w => !currWeek || w !== currWeek).map(w =>
      `<option value="${w}"${weekVal==w?" selected":""}>WEEK #${w}</option>`)
  ].join("");
}

function buildWeeklyJackpotScope(weekVal) {
  const weekArchives = getArchivedWeekData();
  const currentWeek = poolData ? poolData.weekNumber : null;

  if (weekVal === "alltime") {
    return {
      weekVal: "alltime",
      label: "ALL TIME",
      pool: jackpotData,
      log: winnerLog,
      tally: winnerTally,
      current: true,
    };
  }

  const selectedWeek = weekVal === "current" || !weekVal ? currentWeek : parseInt(weekVal, 10);
  if (!selectedWeek) {
    return { weekVal: weekVal || "current", label: "CURRENT WEEK", pool: null, log: [], tally: {}, current: true };
  }

  const selectedIndex = weekArchives.findIndex(w => w.weekNumber === selectedWeek);
  const selectedArchive = selectedIndex >= 0 ? weekArchives[selectedIndex] : null;
  const isCurrent = weekVal === "current" || !weekVal;
  const pool = isCurrent ? poolData : selectedArchive ? selectedArchive.pool : null;
  const endMs = parseTimeValue(isCurrent ? poolData?.weekEnd : selectedArchive?.pool?.weekEnd) ?? Date.now();
  const prevArchive = selectedIndex > 0 ? weekArchives[selectedIndex - 1] : null;
  const startMs = parseTimeValue(prevArchive?.pool?.weekEnd || prevArchive?.savedAt);

  const log = winnerLog.filter(e => {
    const ts = Number(e.ts || 0);
    if (startMs !== null && ts <= startMs) return false;
    if (endMs !== null && ts > endMs) return false;
    return true;
  }).sort((a, b) => b.ts - a.ts);

  const tally = {};
  for (const e of log) {
    if (!tally[e.name]) tally[e.name] = { MEGA: 0, MAJOR: 0, MINOR: 0, total: 0, totalPrize: 0 };
    if (tally[e.name][e.tier] !== undefined) tally[e.name][e.tier]++;
    tally[e.name].total++;
    tally[e.name].totalPrize = +(tally[e.name].totalPrize + e.prize).toFixed(2);
  }

  return {
    weekVal: isCurrent ? "current" : String(selectedWeek),
    label: selectedArchive ? `WEEK #${selectedWeek}` : currentWeek ? `WEEK #${currentWeek}` : "CURRENT WEEK",
    pool,
    log,
    tally,
    current: isCurrent,
  };
}

// ── PAGE: LEADERBOARD ─────────────────────────────────────────────────────────
function buildPage(weekVal, sortCol, sortDir) {
  sortCol = sortCol || "rank";
  sortDir = sortDir || "asc";
  const myAddr   = (MY_ADDRESS||"").toLowerCase();
  const updated  = lastUpdate ? new Date(lastUpdate).toLocaleString("en-GB") : "NOT LOADED YET";
  const currWeek = poolData ? poolData.weekNumber : null;
  const { players, label, pool } = resolveWeekData(weekVal);
  const weekScope = buildWeeklyJackpotScope(weekVal);
  const jkByName = {};
  Object.entries(weekScope.tally || {}).forEach(([n,d]) => { jkByName[n.toLowerCase()] = d.totalPrize; });
  const weekOptions = buildWeekOptions(weekVal, currWeek);

  let summaryCards = "";
  if (pool) {
    const me   = (players||[]).find(p => p.address.toLowerCase() === myAddr);
    const myJk = me ? (jkByName[(me.profileName||"").toLowerCase()]||0) : 0;
    summaryCards = `
      <div class="stat-card"><div class="stat-label">POOL</div><div class="stat-value">$${pool.poolUSDT.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div></div>
      <div class="stat-card"><div class="stat-label">TOTAL TREASURE</div><div class="stat-value">${(pool.totalTreasure/1e6).toFixed(1)}M</div></div>
      <div class="stat-card"><div class="stat-label">TOTAL PLAYERS</div><div class="stat-value">${pool.total||"—"}</div></div>
      <div class="stat-card"><div class="stat-label">YOUR RANK</div><div class="stat-value">${((players||[]).find(p=>p.address.toLowerCase()===myAddr))?"#"+((players||[]).find(p=>p.address.toLowerCase()===myAddr)).rank:"—"}</div></div>
      <div class="stat-card"><div class="stat-label">YOUR EARNING</div><div class="stat-value" style="color:${me&&me.earning>=0?"#C8FF00":"#ff4444"}">${me?(me.earning>=0?"+":"")+me.earning.toFixed(2):"—"}</div></div>
      <div class="stat-card"><div class="stat-label">TOTAL + JACKPOT</div><div class="stat-value" style="color:${me&&(me.earning+myJk)>=0?"#C8FF00":"#ff4444"}">${me?((me.earning+myJk)>=0?"+":"")+(me.earning+myJk).toFixed(2):"—"}</div></div>`;
  }

  if (!summaryCards) {
    const currentPlayers = players || [];
    const me = currentPlayers.find(p => p.address.toLowerCase() === myAddr);
    const myName = me ? (me.profileName || me.name || "").toLowerCase() : "";
    const myJk = me ? (jkByName[myName] || 0) : 0;
    const summaryPool = {
      poolUSDT: currentPlayers.reduce((s, p) => s + (p.payout || 0), 0),
      totalTreasure: currentPlayers.reduce((s, p) => s + (p.treasure || 0), 0),
      total: currentPlayers.length,
    };
    summaryCards = `
      <div class="stat-card"><div class="stat-label">POOL</div><div class="stat-value">$${summaryPool.poolUSDT.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div></div>
      <div class="stat-card"><div class="stat-label">TOTAL TREASURE</div><div class="stat-value">${(summaryPool.totalTreasure/1e6).toFixed(1)}M</div></div>
      <div class="stat-card"><div class="stat-label">TOTAL PLAYERS</div><div class="stat-value">${summaryPool.total||"-"}</div></div>
      <div class="stat-card"><div class="stat-label">YOUR RANK</div><div class="stat-value">${me?"#"+me.rank:"-"}</div></div>
      <div class="stat-card"><div class="stat-label">YOUR EARNING</div><div class="stat-value" style="color:${me&&me.earning>=0?"#C8FF00":"#ff4444"}">${me?(me.earning>=0?"+":"")+me.earning.toFixed(2):"-"}</div></div>
      <div class="stat-card"><div class="stat-label">TOTAL + JACKPOT</div><div class="stat-value" style="color:${me&&(me.earning+myJk)>=0?"#C8FF00":"#ff4444"}">${me?((me.earning+myJk)>=0?"+":"")+(me.earning+myJk).toFixed(2):"-"}</div></div>`;
  }

  // Build + sort rows server-side
  let rows = (players||[]).map(p => {
    const name    = p.profileName || p.name || p.address.slice(0,8)+"...";
    const jkPrize = jkByName[name.toLowerCase()]||0;
    return {
      rank: p.rank, name, address: p.address,
      treasure: p.treasure||0, marbles: p.marbles||0, runCount: p.runCount||0,
      keys: p.totalKeysSpent||p.keys||0,
      keysDiff: (p.keysDiff !== undefined && p.keysDiff !== null) ? p.keysDiff : null,
      payout: p.payout||0, cost: p.cost||0, earning: p.earning||0,
      jkPrize, totalEarn: +((p.earning||0)+jkPrize).toFixed(4),
      isMe: p.address.toLowerCase()===myAddr,
    };
  });

  // Server-side sort
  const numCols = ["treasure","marbles","runCount","keys","payout","cost","earning","jkPrize","totalEarn","rank"];
  if (numCols.includes(sortCol)) {
    rows.sort((a,b) => {
      const av = a[sortCol], bv = b[sortCol];
      if (av===null&&bv===null) return 0;
      if (av===null) return 1;
      if (bv===null) return -1;
      return sortDir==="asc" ? av-bv : bv-av;
    });
  }

  // Helper: sort link URL
  function sortLink(col, label) {
    const nextDir = (sortCol===col && sortDir==="asc") ? "desc" : "asc";
    const arrow   = sortCol===col ? (sortDir==="asc"?" ▲":" ▼") : "";
    const cls     = sortCol===col ? "sortable active" : "sortable";
    const week    = weekVal||"current";
    return `<th class="${cls}"><a href="/?week=${week}&sort=${col}&dir=${nextDir}" style="color:inherit;text-decoration:none;display:block">${label}${arrow}</a></th>`;
  }

  // Render rows as pure HTML
  function diffHtml(d) {
    if (d===null) return '<span style="color:#555">—</span>';
    if (d>0)  return `<span style="color:#a78bfa;font-weight:700">+${d}</span>`;
    if (d===0) return '<span style="color:#555">0</span>';
    return `<span style="color:#ff4444">${d}</span>`;
  }
  function colorVal(v, bold) {
    const c = v>=0 ? "#C8FF00" : "#ff4444";
    const w = bold ? "700" : "400";
    return `<span style="color:${c};font-weight:${w}">${v>=0?"+":""}${v.toFixed(2)}</span>`;
  }
  function rankClass(r) {
    return r===1?"rank-gold":r===2?"rank-silver":r===3?"rank-bronze":"rank-num";
  }

  const lbRows = rows.map(p => {
    const rowStyle = p.isMe ? ' style="background:#1a1c00"' : "";
    const star     = p.isMe ? ' <span style="color:#C8FF00">&#9733;</span>' : "";
    const safeName = (p.name||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const href     = `/player/${encodeURIComponent(p.address)}?name=${encodeURIComponent(p.name)}`;
    const nameLink = `<a href="${href}" target="_blank" class="player-link">${safeName}${star}</a>`;
    const jkCell   = p.jkPrize>0
      ? `<span style="color:#FFD700;font-weight:700">+${p.jkPrize.toFixed(2)}</span>`
      : `<span style="color:#333">—</span>`;
    return `<tr${rowStyle}>
      <td class="${rankClass(p.rank)}">${p.rank}</td>
      <td class="name-cell">${nameLink}</td>
      <td>${p.treasure.toLocaleString()}</td>
      <td>${p.marbles.toLocaleString()}</td>
      <td>${p.runCount}</td>
      <td>${p.keys}</td>
      <td>${diffHtml(p.keysDiff)}</td>
      <td>${p.payout.toFixed(2)}</td>
      <td>${p.cost.toFixed(2)}</td>
      <td>${colorVal(p.earning,false)}</td>
      <td>${jkCell}</td>
      <td>${colorVal(p.totalEarn,true)}</td>
    </tr>`;
  }).join("");

  const emptyMsg = rows.length===0
    ? '<tr><td colspan="12" class="empty-state" style="padding:28px;text-align:center">NO DATA FOR THIS PERIOD</td></tr>'
    : "";

  const week = weekVal||"current";

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="300"><title>MOG_STATS // Leaderboard</title>
<style>${SHARED_CSS}
th.sortable a{color:inherit;text-decoration:none;display:block}
th.sortable:hover{background:#222}
th.sortable.active{color:#fff}
.player-link{color:inherit;text-decoration:none;border-bottom:1px dashed #555;padding-bottom:1px}
.player-link:hover{color:#C8FF00}
</style></head><body>
${NAV("lb", weekVal)}
<div class="panel">
  <div class="sys-label">SYSTEM_ACCESS_GRANTED</div>
  <h1>GLOBAL<br><span>LEADERBOARD</span></h1>
  <div class="subtitle"><span>RANKING THE TOP PLAYERS BY ACCUMULATED REWARDS</span><span class="version-tag">V.2.0.4</span></div>
  <div class="update-bar">
    <div><div class="status-live"><span class="dot"></span>AUTO REFRESH EVERY 5 MIN</div>
    <div class="update-time">LAST UPDATE: ${updated} — ${rows.length} PLAYERS</div></div>
  </div>
  <div class="week-bar">
    <span class="week-label">VIEWING:</span>
    <select class="week-select" onchange="location.href='/?week='+this.value">
      ${weekOptions}
    </select>
    <span style="font-size:10px;color:var(--muted);letter-spacing:1px">${label}</span>
  </div>
  ${summaryCards?`<div class="stats-grid">${summaryCards}</div>`:""}
  <div class="tbl-wrap">
    <table>
      <thead><tr>
        <th><a href="/?week=${week}&sort=rank&dir=${sortCol==='rank'&&sortDir==='asc'?'desc':'asc'}" style="color:inherit;text-decoration:none">#${sortCol==='rank'?(sortDir==='asc'?' ▲':' ▼'):''}</a></th>
        <th>PLAYER</th>
        ${sortLink("treasure","TREASURE")}
        <th>MARBLES</th>
        <th>RUNS</th>
        ${sortLink("keys","KEYS")}
        <th>KEYS DIFF</th>
        ${sortLink("payout","PAYOUT")}
        ${sortLink("cost","COST")}
        ${sortLink("earning","EARNING")}
        ${sortLink("jkPrize","JACKPOT")}
        ${sortLink("totalEarn","TOTAL EARNING")}
      </tr></thead>
      <tbody>${lbRows}${emptyMsg}</tbody>
    </table>
  </div>
</div>
${FOOTER}`;
}

// ── PAGE: SHARDS ──────────────────────────────────────────────────────────────
function buildShardsPage(weekVal) {
  const updated  = lastUpdate ? new Date(lastUpdate).toLocaleString("en-GB") : "NOT LOADED YET";
  const weeks    = listArchivedWeeks();
  const currWeek = poolData ? poolData.weekNumber : null;
  const { players, label } = resolveWeekData(weekVal);

  const BAXS_POOL = 5000;
  // Only top 100 by marbles for bAXS denominator
  const sorted   = [...(players||[])].sort((a,b) => b.marbles - a.marbles);
  const top100   = sorted.slice(0, 100);
  const totalMrb = top100.reduce((s,p) => s + (p.marbles||0), 0);

  const weekOptions = [
    `<option value="current"${weekVal==="current"||!weekVal?" selected":""}>CURRENT WEEK${currWeek?" (W"+currWeek+")":""}</option>`,
    `<option value="alltime"${weekVal==="alltime"?" selected":""}>ALL TIME</option>`,
    ...weeks.filter(w => !currWeek || w !== currWeek).map(w =>
      `<option value="${w}"${weekVal==w?" selected":""}>WEEK #${w}</option>`
    )
  ].join("");

  const rows = top100.map((p,i) => {
    const name    = p.profileName || p.name || p.address.slice(0,8)+"...";
    const bAXS   = totalMrb > 0 ? (p.marbles / totalMrb) * BAXS_POOL : 0;
    const share  = totalMrb > 0 ? ((p.marbles / totalMrb)*100).toFixed(2) : "0.00";
    return { rank:i+1, name, address: p.address, marbles: p.marbles, runCount: p.runCount,
             keys: p.totalKeysSpent||p.keys||0, bAXS: +bAXS.toFixed(4), share };
  });

  const myAddr = (MY_ADDRESS||"").toLowerCase();

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="300"><title>MOG_STATS // Shards</title>
<style>${SHARED_CSS}</style></head><body>
${NAV("sh", weekVal)}
<div class="panel">
  <div class="sys-label">SYSTEM_ACCESS_GRANTED</div>
  <h1>SHARDS<br><span>LEADERBOARD</span></h1>
  <div class="subtitle"><span>TOP 100 PLAYERS BY MARBLES — PROJECTED bAXS REWARDS</span><span class="version-tag">V.2.0.4</span></div>
  <div class="update-bar">
    <div><div class="status-live"><span class="dot"></span>AUTO REFRESH EVERY 5 MIN</div>
    <div class="update-time">LAST UPDATE: ${updated}</div></div>
  </div>
  <div class="week-bar">
    <span class="week-label">VIEWING:</span>
    <select class="week-select" onchange="location.href='/shards?week='+this.value">${weekOptions}</select>
    <span style="font-size:10px;color:var(--muted);letter-spacing:1px">${label}</span>
  </div>
  <div class="stats-grid" style="margin-bottom:20px">
    <div class="stat-card"><div class="stat-label">bAXS POOL</div><div class="stat-value">${BAXS_POOL.toLocaleString()}</div></div>
    <div class="stat-card"><div class="stat-label">TOTAL MARBLES (TOP 100)</div><div class="stat-value">${totalMrb.toLocaleString()}</div></div>
    <div class="stat-card"><div class="stat-label">PLAYERS IN TOP 100</div><div class="stat-value">${top100.length}</div></div>
  </div>
  <div class="tbl-wrap">
    <table>
      <thead><tr>
        <th>#</th><th>PLAYER</th>
        <th>MARBLES</th>
        <th>SHARE %</th>
        <th>RUNS</th>
        <th>KEYS</th>
        <th>bAXS (PROJECTED)</th>
      </tr></thead>
      <tbody>
        ${rows.map(p => {
          const isMe = p.address.toLowerCase()===myAddr;
          const rs   = isMe?' style="background:#1a1c00"':'';
          const star = isMe?' <span style="color:#C8FF00">★</span>':'';
          const rkc  = p.rank===1?'rank-gold':p.rank===2?'rank-silver':p.rank===3?'rank-bronze':'rank-num';
          return `<tr${rs}>
            <td class="${rkc}">${p.rank}</td>
            <td class="name-cell">${p.name}${star}</td>
            <td>${p.marbles.toLocaleString()}</td>
            <td style="color:var(--muted)">${p.share}%</td>
            <td>${p.runCount}</td>
            <td>${p.keys}</td>
            <td class="baxs-val">${p.bAXS.toFixed(4)}</td>
          </tr>`;
        }).join("")||'<tr><td colspan="7" class="empty-state" style="padding:20px;text-align:center">NO DATA FOR THIS PERIOD</td></tr>'}
      </tbody>
    </table>
  </div>
</div>
${FOOTER}</body></html>`;
}

// ── PAGE: JACKPOT ─────────────────────────────────────────────────────────────
function buildJackpotPage(weekVal) {
  const scope = buildWeeklyJackpotScope(weekVal);
  const poolDataForView = scope.pool || jackpotData;
  const updated = lastUpdate ? new Date(lastUpdate).toLocaleString("en-GB") : "—";
  const weekOptions = buildWeekOptions(scope.weekVal, poolData ? poolData.weekNumber : null);
  const weekLabel = scope.label || (poolData ? `WEEK #${poolData.weekNumber}` : "CURRENT WEEK");
  const isCurrent = scope.current;
  const jkPool       = poolDataForView ? `$${poolDataForView.poolUSDT.toFixed(2)}` : "—";
  const jkTotalAdded = isCurrent && jackpotData ? `$${jackpotData.totalAdded.toLocaleString()}` : "—";
  const jkTotalPaid  = isCurrent && jackpotData ? `$${jackpotData.totalPaid.toLocaleString()}` : "—";
  const jkMega       = poolDataForView ? `$${(poolDataForView.poolUSDT * 0.02).toFixed(2)}` : "—";
  const jkMajor      = poolDataForView ? `$${(poolDataForView.poolUSDT * 0.005).toFixed(2)}` : "—";
  const jkMinor      = poolDataForView ? `$${(poolDataForView.poolUSDT * 0.001).toFixed(2)}` : "—";

  const logRows = scope.log.length===0
    ? '<div class="empty-state">NO WINNERS DETECTED YET — MONITORING ACTIVE</div>'
    : scope.log.map(e=>{
        const t=new Date(e.ts).toLocaleString("en-GB");
        const tc=e.tier==="MEGA"?"#FFD700":e.tier==="MAJOR"?"#60a5fa":"#888";
        return `<div class="log-row"><span class="log-time">${t}</span><span class="log-name">${e.name}</span><span style="color:${tc};font-weight:700;font-size:10px;letter-spacing:1px">${e.tier}</span><span class="log-prize">$${e.prize.toFixed(2)}</span></div>`;
      }).join("");

  const jkSorted = Object.entries(scope.tally || {}).sort((a,b)=>b[1].totalPrize-a[1].totalPrize);
  const jkLbRows = jkSorted.length===0
    ? '<tr><td colspan="7" class="empty-state" style="padding:20px;text-align:center">NO DATA YET</td></tr>'
    : jkSorted.map(([name,d],i)=>{
        const rc=i===0?"rank-gold":i===1?"rank-silver":i===2?"rank-bronze":"rank-num";
        return `<tr><td class="${rc}">${i+1}</td><td class="name-cell">${name}</td><td style="color:#FFD700;font-weight:700">${d.MEGA}</td><td style="color:#60a5fa;font-weight:700">${d.MAJOR}</td><td style="color:#888">${d.MINOR}</td><td>${d.total}</td><td style="color:#C8FF00;font-weight:700">$${d.totalPrize.toFixed(2)}</td></tr>`;
      }).join("");

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="300"><title>MOG_STATS // Jackpot</title>
<style>${SHARED_CSS}</style></head><body>
${NAV("jk", scope.weekVal)}
<div class="panel">
  <div class="sys-label">SYSTEM_ACCESS_GRANTED</div>
  <h1>JACKPOT<br><span>MONITOR</span></h1>
  <div class="subtitle"><span>REAL-TIME WEREWOLF PRIZE TRACKER</span><span class="version-tag">V.2.0.4</span></div>
  <div class="update-bar">
    <div><div class="status-live"><span class="dot"></span>AUTO REFRESH EVERY 5 MIN</div>
    <div class="update-time">LAST UPDATE: ${updated} — ${scope.log.length} WINNERS TRACKED</div></div>
  </div>
  <div class="week-bar">
    <span class="week-label">VIEWING:</span>
    <select class="week-select" onchange="location.href='/jackpot?week='+this.value">
      ${weekOptions}
    </select>
    <span style="font-size:10px;color:var(--muted);letter-spacing:1px">${weekLabel}</span>
  </div>
  <div class="pool-bar">
    <div><div class="pool-label">${isCurrent?"CURRENT JACKPOT POOL":"WEEK JACKPOT POOL"}</div><div class="pool-value">${jkPool}</div><div class="pool-meta">${isCurrent?"LIVE BALANCE":"ARCHIVED WEEK"}</div></div>
    <div><div class="pool-label">POOL STATS</div><div style="display:flex;gap:20px;margin-top:6px">
      <div><div class="pool-label">TOTAL ADDED</div><div style="color:#C8FF00;font-weight:700;font-size:14px">${jkTotalAdded}</div></div>
      <div><div class="pool-label">TOTAL PAID</div><div style="color:#ff4444;font-weight:700;font-size:14px">${jkTotalPaid}</div></div>
    </div></div>
    <div><div class="pool-label">PRIZE TIERS (EST.)</div><div style="display:flex;gap:20px;margin-top:6px">
      <div><div class="pool-label">MEGA 2%</div><div style="color:#FFD700;font-weight:700;font-size:14px">${jkMega}</div></div>
      <div><div class="pool-label">MAJOR 0.5%</div><div style="color:#60a5fa;font-weight:700;font-size:14px">${jkMajor}</div></div>
      <div><div class="pool-label">MINOR 0.1%</div><div style="color:#888;font-size:14px">${jkMinor}</div></div>
    </div></div>
  </div>
  <div class="section-title">WINNER LOG — ${scope.log.length} ENTRIES</div>
  <div class="winner-log">
    <div class="log-header"><span>RECENT WEREWOLF DEFEATS</span><span>${scope.log.length} TOTAL</span></div>
    <div>${logRows}</div>
  </div>
  <div class="section-title">TOP PRIZE EARNERS — SORTED BY TOTAL PRIZE</div>
  <div class="tbl-wrap">
    <table>
      <thead><tr><th>#</th><th>WINNER</th><th>MEGA</th><th>MAJOR</th><th>MINOR</th><th>TOTAL WINS</th><th>TOTAL PRIZE</th></tr></thead>
      <tbody>${jkLbRows}</tbody>
    </table>
  </div>
</div>
${FOOTER}</body></html>`;
}


// ── PLAYER DETAIL ─────────────────────────────────────────────────────────────
async function buildPlayerDetailPage(address, playerName) {
  const { blessingDetails, payoutDetails, spentDetails = [] } = await fetchClaimHistory(address, COOKIE);

  // 1. Summaries
  const formatClaim = (value) => value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const totalBlessing = +blessingDetails.reduce((s,t) => s+t.usdt, 0).toFixed(6);
  const totalPayout   = +payoutDetails.reduce((s,t) => s+t.usdt, 0).toFixed(6);
  const totalSpent    = +spentDetails.reduce((s,t) => s+t.usdc, 0).toFixed(6);
  const totalClaim    = +(totalBlessing + totalPayout).toFixed(6);
  const allTxs        = [...blessingDetails, ...payoutDetails].sort((a,b) => new Date(b.timestamp)-new Date(a.timestamp));
  const playerJackpot = blessingDetails.reduce((acc, tx) => {
    let tier = null;
    if (tx.usdt <= 17) tier = "MINOR";
    else if (tx.usdt > 17 && tx.usdt <= 75) tier = "MAJOR";
    else if (tx.usdt >= 100) tier = "MEGA";
    else return acc;

    acc[tier]++;
    acc.details[tier].push(tx);
    acc.total++;
    acc.totalPrize += tx.usdt;
    return acc;
  }, { MEGA: 0, MAJOR: 0, MINOR: 0, total: 0, totalPrize: 0, details: { MEGA: [], MAJOR: [], MINOR: [] } });
  playerJackpot.totalPrize = +playerJackpot.totalPrize.toFixed(6);

  // 5. Leaderboard & jackpot data
  const lbPlayer  = (leaderboardData||[]).find(p => p.address.toLowerCase() === address.toLowerCase());
  const jkEntry   = playerJackpot.total > 0 ? playerJackpot : null;
  const lbRank    = lbPlayer ? "#"+lbPlayer.rank : "—";
  const lbTreasure= lbPlayer ? lbPlayer.treasure.toLocaleString() : "—";
  const lbRuns    = lbPlayer ? lbPlayer.runCount : "—";
  const lbKeys    = lbPlayer ? lbPlayer.totalKeysSpent : "—";
  const grandTotal= +(totalClaim - totalSpent).toFixed(6);

  // 6. TX table rows
  const txRows = allTxs.map(tx => {
    const dt      = new Date(tx.timestamp);
    const date    = dt.toLocaleDateString("en-GB", {day:"2-digit",month:"short",year:"numeric"});
    const time    = dt.toLocaleTimeString("en-GB");
    const isBless = tx.method === "CLAIM BLESSING";
    const mc      = isBless ? "#C8FF00" : "#60a5fa";
    const expUrl  = `https://explorer.roninchain.com/tx/${tx.hash}`;
    return `<tr>
      <td style="color:var(--muted);font-size:10px;line-height:1.6">${date}<br>${time}</td>
      <td><span style="color:${mc};font-weight:700;font-size:10px;letter-spacing:1px;background:${mc}18;padding:2px 8px;border-radius:2px">${tx.method}</span></td>
      <td style="color:#C8FF00;font-weight:700;font-size:14px">$${formatClaim(tx.usdt)}</td>
      <td><a href="${expUrl}" target="_blank" style="color:var(--muted);font-size:10px;text-decoration:none;letter-spacing:1px;border:1px solid var(--border);padding:3px 8px;display:inline-block" onmouseover="this.style.color='#C8FF00';this.style.borderColor='#C8FF00'" onmouseout="this.style.color='var(--muted)';this.style.borderColor='var(--border)'">VIEW TX ↗</a></td>
    </tr>`;
  }).join("") || `<tr><td colspan="4" class="empty-state" style="padding:28px">NO TRANSACTIONS FOUND</td></tr>`;
  const jackpotTierRows = jkEntry ? [
    ["MEGA", "#FFD700"],
    ["MAJOR", "#60a5fa"],
    ["MINOR", "#888"],
  ].map(([tier, color]) => {
    const details = jkEntry.details[tier];
    const detailRows = details.map(tx => {
      const dt     = new Date(tx.timestamp);
      const date   = dt.toLocaleDateString("en-GB", { day:"2-digit", month:"short", year:"numeric" });
      const time   = dt.toLocaleTimeString("en-GB");
      const expUrl = `https://explorer.roninchain.com/tx/${tx.hash}`;
      return `<div class="tier-tx">
        <span class="tier-date">${date}<br>${time}</span>
        <span class="tier-amount">$${formatClaim(tx.usdt)}</span>
        <a href="${expUrl}" target="_blank" class="tier-link">TX</a>
      </div>`;
    }).join("") || `<div class="tier-empty">NO CLAIMS</div>`;

    return `<details class="tier-breakdown">
      <summary class="info-row tier-summary">
        <span class="info-label tier-name" style="color:${color}">${tier}<span class="tier-hint">DETAIL</span></span>
        <span class="info-val" style="color:${color}">${details.length}</span>
      </summary>
      <div class="tier-list">${detailRows}</div>
    </details>`;
  }).join("") : "";

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MOG_STATS // ${playerName}</title>
<style>
${SHARED_CSS}
.back-btn{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:10px;letter-spacing:2px;text-decoration:none;border:1px solid var(--border);padding:6px 14px;margin-bottom:22px;transition:all .15s}
.back-btn:hover{color:var(--neon);border-color:var(--neon)}
.addr-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:22px}
.addr-full{color:#aaa;font-size:10px;background:var(--surface2);border:1px solid var(--border);padding:5px 10px;letter-spacing:1px;word-break:break-all;font-family:inherit}
.exp-link{color:var(--muted);font-size:10px;letter-spacing:1px;border:1px solid var(--border);padding:5px 12px;text-decoration:none;transition:all .15s;white-space:nowrap}
.exp-link:hover{color:var(--neon);border-color:var(--neon)}
.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:1px;background:var(--border);border:1px solid var(--border);margin-bottom:20px}
.sum-card{background:var(--surface);padding:18px 14px}
.sum-label{font-size:9px;letter-spacing:3px;color:var(--muted);margin-bottom:6px;text-transform:uppercase}
.sum-value{font-size:21px;font-weight:700;color:var(--neon)}
.sum-sub{font-size:10px;color:var(--muted);margin-top:3px;letter-spacing:1px}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px}
@media(max-width:640px){.two-col{grid-template-columns:1fr}}
.info-box{border:1px solid var(--border)}
.info-header{background:var(--surface2);padding:9px 14px;font-size:9px;letter-spacing:3px;color:var(--muted);border-bottom:1px solid var(--border);text-transform:uppercase;display:flex;justify-content:space-between}
.info-row{display:flex;align-items:center;justify-content:space-between;padding:9px 14px;border-bottom:1px solid #1a1a1a;font-size:12px}
.info-row:last-child{border-bottom:none}
.info-label{color:var(--muted);font-size:10px;letter-spacing:1px}
.info-val{font-weight:700}
.tier-breakdown{border-bottom:1px solid #1a1a1a}
.tier-breakdown:last-of-type{border-bottom:none}
.tier-summary{cursor:pointer;list-style:none;user-select:none}
.tier-summary::-webkit-details-marker{display:none}
.tier-summary .tier-name:before{content:"+";display:inline-block;width:14px;color:var(--muted)}
.tier-breakdown[open] .tier-name:before{content:"-"}
.tier-hint{margin-left:8px;color:var(--muted);font-size:8px;letter-spacing:1px}
.tier-list{background:#090909;border-top:1px solid #181818;padding:4px 0}
.tier-tx{display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;padding:8px 14px;border-bottom:1px solid #151515;font-size:11px}
.tier-tx:last-child{border-bottom:none}
.tier-date{color:var(--muted);font-size:10px;line-height:1.45}
.tier-amount{font-weight:700;color:var(--neon)}
.tier-link{color:var(--muted);font-size:9px;letter-spacing:1px;text-decoration:none;border:1px solid var(--border);padding:3px 7px}
.tier-link:hover{color:var(--neon);border-color:var(--neon)}
.tier-empty{padding:9px 14px;color:var(--muted);font-size:10px;text-align:center;letter-spacing:1px}
</style></head><body>
${NAV("")}
<div class="panel">
  <a href="/" class="back-btn">← LEADERBOARD</a>
  <div class="sys-label">PLAYER_PROFILE</div>
  <h1>${playerName.toUpperCase()}<br><span>CLAIM HISTORY</span></h1>
  <div class="addr-row">
    <span class="addr-full">${address}</span>
    <a href="https://explorer.roninchain.com/address/${address}" target="_blank" class="exp-link">RONIN EXPLORER ↗</a>
  </div>

  <div class="summary-grid">
    <div class="sum-card" style="background:#111800">
      <div class="sum-label">TOTAL CLAIM</div>
      <div class="sum-value">$${formatClaim(totalClaim)}</div>
      <div class="sum-sub">BLESSING + PAYOUT</div>
    </div>
    <div class="sum-card">
      <div class="sum-label">CLAIM BLESSING</div>
      <div class="sum-value" style="color:#C8FF00">$${formatClaim(totalBlessing)}</div>
      <div class="sum-sub">${blessingDetails.length} TRANSACTION${blessingDetails.length!==1?"S":""}</div>
    </div>
    <div class="sum-card">
      <div class="sum-label">CLAIM PAYOUT</div>
      <div class="sum-value" style="color:#60a5fa">$${formatClaim(totalPayout)}</div>
      <div class="sum-sub">${payoutDetails.length} TRANSACTION${payoutDetails.length!==1?"S":""}</div>
    </div>
    <div class="sum-card">
      <div class="sum-label">JACKPOT WON</div>
      <div class="sum-value" style="color:#FFD700">${jkEntry?"$"+jkEntry.totalPrize.toFixed(2):"—"}</div>
      <div class="sum-sub">${jkEntry?jkEntry.total+" WIN(S)":"NO MATCHING CLAIMS"}</div>
    </div>
    <div class="sum-card">
      <div class="sum-label">TOTAL USDC SPENT</div>
      <div class="sum-value" style="color:#f97316">$${formatClaim(totalSpent)}</div>
      <div class="sum-sub">${spentDetails.length} CONTRACT TX${spentDetails.length!==1?"S":""}</div>
    </div>
    <div class="sum-card" style="background:#0d1a0d">
      <div class="sum-label">GRAND TOTAL</div>
      <div class="sum-value" style="font-size:26px;color:${grandTotal>=0?"#C8FF00":"#ff4444"}">$${formatClaim(grandTotal)}</div>
      <div class="sum-sub">TOTAL CLAIM - USDC SPENT</div>
    </div>
  </div>

  <div class="two-col">
    <div class="info-box">
      <div class="info-header"><span>LEADERBOARD</span><span>CURRENT WEEK</span></div>
      <div class="info-row"><span class="info-label">RANK</span><span class="info-val" style="color:var(--neon)">${lbRank}</span></div>
      <div class="info-row"><span class="info-label">TREASURE</span><span class="info-val">${lbTreasure}</span></div>
      <div class="info-row"><span class="info-label">RUNS</span><span class="info-val">${lbRuns}</span></div>
      <div class="info-row"><span class="info-label">KEYS SPENT</span><span class="info-val">${lbKeys}</span></div>
    </div>
    <div class="info-box">
      <div class="info-header"><span>JACKPOT WINS</span><span>${jkEntry?jkEntry.total+" WIN(S)":"NO DATA"}</span></div>
      ${jkEntry?`
      ${jackpotTierRows}
      <div class="info-row"><span class="info-label">TOTAL PRIZE</span><span class="info-val" style="color:#FFD700">$${jkEntry.totalPrize.toFixed(2)}</span></div>
      `:`<div class="info-row"><span class="info-label" style="width:100%;text-align:center;color:var(--muted)">NO JACKPOT WINS IN LOG</span></div>`}
    </div>
  </div>

  <div class="section-title">TRANSACTION HISTORY — ${allTxs.length} RECORDS</div>
  <div class="tbl-wrap">
    <table>
      <thead><tr>
        <th>TIMESTAMP</th>
        <th>METHOD</th>
        <th>AMOUNT (USDC)</th>
        <th>EXPLORER</th>
      </tr></thead>
      <tbody>${txRows}</tbody>
    </table>
  </div>
</div>
${FOOTER}</body></html>`;
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get("/",        (req,res) => res.send(buildPage(req.query.week||"current", req.query.sort, req.query.dir)));
app.get("/debug",   (req,res) => res.json({
  leaderboardRows: leaderboardData ? leaderboardData.length : 0,
  poolData:        poolData,
  lastUpdate:      lastUpdate,
  myAddress:       MY_ADDRESS || "(not set)",
  cookieSet:       COOKIE.length > 0,
  cookieLen:       COOKIE.length,
  samplePlayer:    leaderboardData && leaderboardData[0] ? { rank: leaderboardData[0].rank, name: leaderboardData[0].profileName, address: leaderboardData[0].address } : null,
}));
app.get("/shards",  (req,res) => res.send(buildShardsPage(req.query.week||"current")));
app.get("/jackpot", (req,res) => res.send(buildJackpotPage(req.query.week||"current")));
app.get("/player/:address", async (req,res) => {
  const addr   = req.params.address;
  const player = (leaderboardData||[]).find(p => p.address.toLowerCase()===addr.toLowerCase());
  const name   = req.query.name || (player ? player.profileName : null) || addr.slice(0,8)+"...";
  try {
    const html = await buildPlayerDetailPage(addr, name);
    res.send(html);
  } catch(e) {
    res.status(500).send(`<pre style="color:#ff4444;background:#0a0a0a;padding:24px;font-family:monospace">ERROR: ${e.message}</pre>`);
  }
});
app.get("/api/lb",  (req,res) => res.json({ updatedAt:lastUpdate, pool:poolData, data:leaderboardData }));
app.get("/api/jk",  (req,res) => res.json({ jackpot:jackpotData, lastTs:lastWinnerTs, winners:winnerLog.slice(0,50), tally:winnerTally }));
app.get("/api/weeks",(req,res)=> res.json({ weeks: listArchivedWeeks() }));
app.get("/health",  (req,res) => res.json({ ok:true, updatedAt:lastUpdate, winners:winnerLog.length, dataDir:DATA_DIR, volumeMounted:fs.existsSync("/data"), archivedWeeks:listArchivedWeeks() }));

// ── CRON ──────────────────────────────────────────────────────────────────────
cron.schedule("*/5 * * * *", async () => {
  await refreshLeaderboard();
  await refreshJackpot();
});
//tes change
// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log("=== MOG_STATS port", PORT, "===");
  console.log("MY_ADDRESS  :", MY_ADDRESS||"(not set)");
  console.log("AXIE_COOKIE :", COOKIE?`SET (${COOKIE.length} chars)`:"(not set)");
  console.log("DATA_DIR    :", DATA_DIR);
  console.log("Volume /data:", fs.existsSync("/data")?"MOUNTED ✓":"NOT MOUNTED");
  console.log("Archived weeks:", listArchivedWeeks());

  const saved = loadWinners();
  winnerLog    = saved.log   || [];
  winnerTally  = saved.tally || {};
  lastWinnerTs = saved.lastTs || 0;
  jackpotData   = saved.jackpot || jackpotData;
  console.log(`[init] ${winnerLog.length} winners loaded, lastTs=${lastWinnerTs}`);

  if (lastWinnerTs === 0) { await seedChatBaseline(); saveWinners(); }

  await refreshLeaderboard();
  await refreshJackpot();
});
