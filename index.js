const https   = require("https");
const express = require("express");
const cron    = require("node-cron");
const fs      = require("fs");

const app  = express();
const PORT = process.env.PORT || 3000;

const MY_ADDRESS    = process.env.MY_ADDRESS  || "";
const COOKIE        = process.env.AXIE_COOKIE || "";
const SNAPSHOT_FILE = "axiedom_snapshot.json";

let leaderboardData = null;
let poolData        = null;
let jackpotData     = null;
let winnerLog       = [];
let winnerTally     = {};
let lastUpdate      = null;
let lastWinnerTs    = 0;

// ── REQUEST HEADERS ───────────────────────────────────────────────────────────
function getHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://axiedom.xyz/",
    Connection: "keep-alive",
    Cookie: COOKIE,
  };
}

// ── FETCH HELPER ──────────────────────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: getHeaders() }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { reject(new Error(`JSON parse error. Status ${res.statusCode}. Body: ${raw.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Request timeout")); });
  });
}

// ── SNAPSHOT ──────────────────────────────────────────────────────────────────
function loadSnapshot() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8")); }
  catch { return null; }
}

function saveSnapshot(players, weekNumber) {
  const data = { savedAt: new Date().toISOString(), weekNumber, keys: {} };
  players.forEach((p) => { data.keys[p.address.toLowerCase()] = p.totalKeysSpent; });
  try { fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data, null, 2), "utf8"); }
  catch (e) { console.error("Snapshot save error:", e.message); }
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
  for (const p of WINNER_PATTERNS) {
    const m = (text || "").trim().match(p);
    if (m) return m[1].trim();
  }
  return null;
}

// ── REFRESH LEADERBOARD ───────────────────────────────────────────────────────
async function refreshLeaderboard() {
  console.log("[lb]", new Date().toISOString(), "fetching...");
  try {
    const [lbRes, poolRes] = await Promise.all([
      fetchJSON(`https://axiedom.xyz/api/runs?mode=weekly&address=${MY_ADDRESS}`),
      fetchJSON("https://axiedom.xyz/api/weekly-pool"),
    ]);

    if (lbRes.status !== 200) throw new Error("Leaderboard HTTP " + lbRes.status);
    if (poolRes.status !== 200) throw new Error("Pool HTTP " + poolRes.status);

    const lb   = lbRes.body;
    const pool = poolRes.body;

    const poolUSDT      = parseInt(pool.currentPoolWei) / 1_000_000;
    const totalTreasure = lb.totalGlobalTreasure;
    const snapshot      = loadSnapshot();
    const isSameWeek    = snapshot && snapshot.weekNumber === lb.weekNumber;

    let players = [...(lb.leaderboard || [])];
    const addrs = new Set(players.map((p) => p.address.toLowerCase()));
    if (lb.userStats && !addrs.has(lb.userStats.address.toLowerCase())) players.push(lb.userStats);
    players.sort((a, b) => a.rank - b.rank);

    leaderboardData = players.map((p) => {
      const payout  = (poolUSDT / totalTreasure) * p.treasure;
      const cost    = p.totalKeysSpent * 2;
      const earning = payout - cost;
      const prev    = isSameWeek ? snapshot.keys[p.address.toLowerCase()] : undefined;
      const keysDiff = prev !== undefined ? p.totalKeysSpent - prev : null;
      return { ...p, payout: +payout.toFixed(4), cost, earning: +earning.toFixed(4), keysDiff };
    });

    poolData   = { poolUSDT, totalTreasure, weekNumber: lb.weekNumber, weekEnd: pool.weekEnd, total: lb.total };
    lastUpdate = new Date().toISOString();
    saveSnapshot(players, lb.weekNumber);
    console.log("[lb] done,", players.length, "rows");
  } catch (err) {
    console.error("[lb] error:", err.message);
  }
}

// ── REFRESH JACKPOT / CHAT ────────────────────────────────────────────────────
async function refreshJackpot() {
  console.log("[jk]", new Date().toISOString(), "fetching...");
  try {
    const poolRes = await fetchJSON("https://axiedom.xyz/api/jackpot/pool");
    if (poolRes.status !== 200) throw new Error("Jackpot pool HTTP " + poolRes.status);
    const pool    = poolRes.body;
    // balanceWei uses 6 decimals (USDC) → divide by 1_000_000
    const usdt    = parseInt(pool.balanceWei) / 1_000_000;

    jackpotData = {
      poolUSDT:      usdt,
      balanceWei:    pool.balanceWei,
      totalAddedWei: pool.totalAddedWei,
      totalPaidWei:  pool.totalPaidWei,
      totalAdded:    +(parseInt(pool.totalAddedWei)  / 1_000_000).toFixed(2),
      totalPaid:     +(parseInt(pool.totalPaidWei)   / 1_000_000).toFixed(2),
      mega:          +(usdt * 0.02).toFixed(2),
      major:         +(usdt * 0.005).toFixed(2),
      minor:         +(usdt * 0.001).toFixed(2),
    };

    const chatRes = await fetchJSON("https://axiedom.xyz/api/chat/history?limit=50");
    if (chatRes.status === 200) {
      const msgs = (chatRes.body.messages || [])
        .filter((m) => m.sender === "system" && m.messageType === "event")
        .sort((a, b) => a.timestamp - b.timestamp)
        .filter((m) => m.timestamp > lastWinnerTs);

      msgs.forEach((m) => {
        const winner = extractWinner(m.text || "");
        if (!winner) return;
        const rand  = Math.random();
        const tier  = rand < 0.05 ? "MEGA" : rand < 0.25 ? "MAJOR" : "MINOR";
        const prize = usdt * { MEGA: 0.02, MAJOR: 0.005, MINOR: 0.001 }[tier];
        winnerLog.push({ ts: m.timestamp, name: winner, tier, prize: +prize.toFixed(2) });
        if (!winnerTally[winner]) winnerTally[winner] = { MEGA: 0, MAJOR: 0, MINOR: 0, total: 0, totalPrize: 0 };
        winnerTally[winner][tier]++;
        winnerTally[winner].total++;
        winnerTally[winner].totalPrize = +(winnerTally[winner].totalPrize + prize).toFixed(2);
        if (m.timestamp > lastWinnerTs) lastWinnerTs = m.timestamp;
      });

      winnerLog.sort((a, b) => b.ts - a.ts);
      if (winnerLog.length > 100) winnerLog = winnerLog.slice(0, 100);
    }
    console.log("[jk] done, pool=$" + usdt.toFixed(2) + ", winners=" + winnerLog.length);
  } catch (err) {
    console.error("[jk] error:", err.message);
  }
}

// ── HTML PAGE ─────────────────────────────────────────────────────────────────
function buildPage() {
  const myAddr = (MY_ADDRESS || "").toLowerCase();

  // leaderboard rows
  let lbRows = "";
  if (leaderboardData && poolData) {
    leaderboardData.forEach((p) => {
      const isMe      = p.address.toLowerCase() === myAddr;
      const rowStyle  = isMe ? ' style="background:#1a1c00"' : "";
      const rankClass = p.rank === 1 ? "rank-gold" : p.rank === 2 ? "rank-silver" : p.rank === 3 ? "rank-bronze" : "rank-num";
      const diffHtml  = p.keysDiff === null
        ? '<span style="color:#666">—</span>'
        : p.keysDiff > 0  ? `<span style="color:#a78bfa;font-weight:700">+${p.keysDiff}</span>`
        : p.keysDiff === 0 ? '<span style="color:#666">0</span>'
        : `<span style="color:#ff4444">${p.keysDiff}</span>`;
      const earnColor = p.earning >= 0 ? "#C8FF00" : "#ff4444";
      lbRows += `<tr${rowStyle}>
        <td class="${rankClass}">${p.rank}</td>
        <td class="name-cell">${p.profileName || p.address.slice(0,8)+"…"}${isMe ? ' <span style="color:#C8FF00">★</span>' : ""}</td>
        <td>${p.treasure.toLocaleString()}</td>
        <td>${p.marbles.toLocaleString()}</td>
        <td>${p.runCount}</td>
        <td>${p.totalKeysSpent}</td>
        <td>${diffHtml}</td>
        <td>${p.payout.toFixed(2)}</td>
        <td>${p.cost.toFixed(2)}</td>
        <td style="color:${earnColor};font-weight:700">${p.earning >= 0 ? "+" : ""}${p.earning.toFixed(2)}</td>
      </tr>`;
    });
  }

  // summary cards
  let summaryCards = "";
  if (poolData) {
    const me = leaderboardData ? leaderboardData.find(p => p.address.toLowerCase() === myAddr) : null;
    summaryCards = `
      <div class="stat-card"><div class="stat-label">POOL (USDT)</div><div class="stat-value">$${poolData.poolUSDT.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div></div>
      <div class="stat-card"><div class="stat-label">TOTAL TREASURE</div><div class="stat-value">${(poolData.totalTreasure/1e6).toFixed(1)}M</div></div>
      <div class="stat-card"><div class="stat-label">TOTAL PLAYERS</div><div class="stat-value">${poolData.total}</div></div>
      <div class="stat-card"><div class="stat-label">YOUR RANK</div><div class="stat-value">${me ? "#"+me.rank : "—"}</div></div>
      <div class="stat-card"><div class="stat-label">YOUR EARNING</div><div class="stat-value" style="color:${me && me.earning>=0?"#C8FF00":"#ff4444"}">${me ? (me.earning>=0?"+":"")+me.earning.toFixed(2) : "—"}</div></div>`;
  }

  // winner log rows
  let logRows = winnerLog.length === 0
    ? '<div class="empty-state">NO WINNERS DETECTED YET</div>'
    : winnerLog.slice(0, 30).map(e => {
        const t = new Date(e.ts).toLocaleString("en-GB");
        const tc = e.tier === "MEGA" ? "#FFD700" : e.tier === "MAJOR" ? "#60a5fa" : "#666";
        return `<div class="log-row">
          <span class="log-time">${t}</span>
          <span class="log-name">${e.name}</span>
          <span style="color:${tc};font-weight:700;font-size:10px;letter-spacing:1px">${e.tier}</span>
          <span class="log-prize">$${e.prize.toFixed(2)}</span>
        </div>`;
      }).join("");

  // jackpot leaderboard
  const jkSorted = Object.entries(winnerTally).sort((a, b) => b[1].total - a[1].total);
  let jkLbRows = jkSorted.length === 0
    ? '<tr><td colspan="7" class="empty-state" style="padding:20px;text-align:center">NO DATA YET</td></tr>'
    : jkSorted.map(([name, d], i) => {
        const rc = i === 0 ? "rank-gold" : i === 1 ? "rank-silver" : i === 2 ? "rank-bronze" : "rank-num";
        return `<tr>
          <td class="${rc}">${i+1}</td>
          <td class="name-cell">${name}</td>
          <td style="color:#FFD700;font-weight:700">${d.MEGA}</td>
          <td style="color:#60a5fa;font-weight:700">${d.MAJOR}</td>
          <td style="color:#666">${d.MINOR}</td>
          <td>${d.total}</td>
          <td style="color:#C8FF00;font-weight:700">$${d.totalPrize.toFixed(2)}</td>
        </tr>`;
      }).join("");

  const jkPool  = jackpotData ? `$${jackpotData.poolUSDT.toFixed(2)}` : "—";
  const jkMeta  = jackpotData ? `WEEK #${jackpotData.weekNumber} — ENDS ${new Date(jackpotData.weekEnd).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}).toUpperCase()}` : "LOADING...";
  const jkMega  = jackpotData ? `$${jackpotData.mega.toFixed(2)}` : "—";
  const jkMajor = jackpotData ? `$${jackpotData.major.toFixed(2)}` : "—";
  const jkMinor = jackpotData ? `$${jackpotData.minor.toFixed(2)}` : "—";
  const updated = lastUpdate ? new Date(lastUpdate).toLocaleString("en-GB") : "NOT LOADED YET";
  const weekNum = poolData ? "WEEK #"+poolData.weekNumber : "";

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="300">
<title>MOG_STATS // Axie Dom</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--neon:#C8FF00;--dark:#0a0a0a;--surface:#111;--surface2:#181818;--border:#2a2a2a;--muted:#666;--red:#ff4444}
body{background:var(--dark);color:#fff;font-family:'Courier New',monospace;min-height:100vh;display:flex;flex-direction:column}
nav{display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:56px;border-bottom:1px solid var(--border);background:var(--dark);flex-shrink:0}
.logo{font-size:13px;font-weight:700;letter-spacing:3px;color:var(--neon)}
.nav-links{display:flex}
.nav-btn{background:none;border:none;color:var(--muted);font-family:inherit;font-size:11px;letter-spacing:2px;padding:0 20px;height:56px;cursor:pointer;border-bottom:2px solid transparent;transition:color .15s;text-decoration:none;display:flex;align-items:center}
.nav-btn:hover{color:#fff}
.nav-btn.active{color:var(--neon);border-bottom:2px solid var(--neon)}
.play-btn{background:var(--neon);color:#000;border:none;font-family:inherit;font-size:11px;letter-spacing:2px;padding:8px 20px;cursor:pointer;font-weight:700;text-decoration:none}
.panel{display:none;padding:32px 24px;flex:1}
.panel.active{display:block}
.sys-label{font-size:10px;letter-spacing:3px;color:var(--muted);margin-bottom:12px;display:flex;align-items:center;gap:8px}
.sys-label::before{content:'';display:inline-block;width:24px;height:1px;background:var(--muted)}
h1{font-size:48px;font-weight:900;letter-spacing:-1px;line-height:1;margin-bottom:4px;text-transform:uppercase}
h1 span{color:var(--neon)}
.subtitle{font-size:11px;letter-spacing:2px;color:var(--muted);margin-bottom:28px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.version-tag{border:1px solid var(--border);padding:2px 10px;font-size:10px;color:var(--muted)}
.dot{width:6px;height:6px;border-radius:50%;background:var(--neon);display:inline-block;animation:blink 1.5s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}
.update-bar{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;gap:8px;flex-wrap:wrap}
.update-time{font-size:10px;color:var(--muted);letter-spacing:1px;margin-top:3px}
.status-live{display:flex;align-items:center;gap:6px;font-size:10px;letter-spacing:2px;color:var(--muted)}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:1px;background:var(--border);border:1px solid var(--border);margin-bottom:20px}
.stat-card{background:var(--surface);padding:18px 16px}
.stat-label{font-size:9px;letter-spacing:3px;color:var(--muted);margin-bottom:6px;text-transform:uppercase}
.stat-value{font-size:20px;font-weight:700;color:var(--neon)}
.tbl-wrap{border:1px solid var(--border);overflow-x:auto}
table{width:100%;border-collapse:collapse;min-width:700px}
th{background:var(--surface2);color:var(--muted);font-size:9px;letter-spacing:2px;padding:10px 12px;text-align:left;border-bottom:1px solid var(--border);white-space:nowrap;text-transform:uppercase}
td{padding:9px 12px;font-size:12px;border-bottom:1px solid #1a1a1a;white-space:nowrap;color:#fff}
tr:last-child td{border-bottom:none}
tr:hover td{background:#141400}
.rank-num{color:var(--muted);font-size:11px}
.rank-gold{color:var(--neon);font-weight:700}
.rank-silver{color:#c0c0c0;font-weight:700}
.rank-bronze{color:#cd7f32;font-weight:700}
.name-cell{font-weight:700;font-size:12px}
.pool-bar{background:var(--surface2);border:1px solid var(--border);padding:16px 20px;margin-bottom:20px;display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:16px}
.pool-label{font-size:9px;letter-spacing:3px;color:var(--muted);text-transform:uppercase;margin-bottom:6px}
.pool-value{font-size:28px;font-weight:700;color:var(--neon);line-height:1}
.pool-meta{font-size:10px;color:var(--muted);margin-top:4px;letter-spacing:1px}
.winner-log{border:1px solid var(--border);background:var(--surface);margin-bottom:20px}
.log-header{background:var(--surface2);padding:10px 16px;font-size:9px;letter-spacing:3px;color:var(--muted);border-bottom:1px solid var(--border);text-transform:uppercase;display:flex;justify-content:space-between;align-items:center}
.log-row{padding:9px 16px;border-bottom:1px solid #161616;display:grid;grid-template-columns:160px 1fr 80px 90px;gap:12px;align-items:center;font-size:11px}
.log-row:last-child{border-bottom:none}
.log-time{color:var(--muted);font-size:10px;letter-spacing:1px}
.log-name{font-weight:700;color:#fff}
.log-prize{color:var(--neon);text-align:right;font-weight:700}
.empty-state{padding:32px;text-align:center;color:var(--muted);font-size:10px;letter-spacing:2px}
.section-title{font-size:9px;letter-spacing:3px;color:var(--muted);text-transform:uppercase;margin-bottom:10px;margin-top:20px}
footer{padding:16px 24px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;flex-shrink:0}
.footer-copy{font-size:9px;letter-spacing:2px;color:var(--muted)}
.footer-rpc{font-size:9px;letter-spacing:1px;color:var(--muted);display:flex;align-items:center;gap:6px}
</style>
</head><body>

<nav>
  <span class="logo">MOG_STATS</span>
  <div class="nav-links">
    <a href="/" class="nav-btn ${lbRows || summaryCards ? 'active' : 'active'}" id="nav-lb">LEADERBOARD</a>
    <a href="/jackpot" class="nav-btn" id="nav-jk">JACKPOT</a>
  </div>
  <a href="https://axiedom.xyz" target="_blank" class="play-btn">PLAY NOW</a>
</nav>

<div class="panel active" id="tab-leaderboard">
  <div class="sys-label">SYSTEM_ACCESS_GRANTED</div>
  <h1>GLOBAL<br><span>LEADERBOARD</span></h1>
  <div class="subtitle">
    <span>RANKING THE TOP PLAYERS BY ACCUMULATED REWARDS</span>
    <span class="version-tag">V.2.0.4</span>
  </div>
  <div class="update-bar">
    <div>
      <div class="status-live"><span class="dot"></span>AUTO REFRESH EVERY 5 MIN</div>
      <div class="update-time">LAST UPDATE: ${updated} ${weekNum ? "— "+weekNum : ""}</div>
    </div>
  </div>
  ${summaryCards ? `<div class="stats-grid">${summaryCards}</div>` : ""}
  ${lbRows
    ? `<div class="tbl-wrap"><table>
        <thead><tr>
          <th>#</th><th>PLAYER</th><th>TREASURE</th><th>MARBLES</th>
          <th>RUNS</th><th>KEYS</th><th>KEYS DIFF</th>
          <th>PAYOUT (USDT)</th><th>COST (USDT)</th><th>EARNING (USDT)</th>
        </tr></thead>
        <tbody>${lbRows}</tbody>
      </table></div>`
    : `<div class="empty-state" style="border:1px solid var(--border)">LOADING DATA — PLEASE WAIT OR CHECK COOKIE SETTINGS</div>`}
</div>

<footer>
  <span class="footer-copy">© 2026 MOG_STATS // TECHNICAL_SERVICES_DIV</span>
  <div style="display:flex;gap:24px;align-items:center">
    <div class="footer-rpc"><span class="dot" style="animation:none"></span>BLACK_GREEN // V2.0_LIVE</div>
    <div class="footer-rpc">RPC: ABS_MAINNET</div>
  </div>
</footer>
</body></html>`;
}

function buildJackpotPage() {
  const jkPool       = jackpotData ? `${jackpotData.poolUSDT.toFixed(2)}` : "—";
  const jkTotalAdded = jackpotData ? `${jackpotData.totalAdded.toLocaleString()}` : "—";
  const jkTotalPaid  = jackpotData ? `${jackpotData.totalPaid.toLocaleString()}` : "—";
  const jkMega       = jackpotData ? `${jackpotData.mega.toFixed(2)}` : "—";
  const jkMajor      = jackpotData ? `${jackpotData.major.toFixed(2)}` : "—";
  const jkMinor      = jackpotData ? `${jackpotData.minor.toFixed(2)}` : "—";

  const logRows = winnerLog.length === 0
    ? '<div class="empty-state">NO WINNERS DETECTED YET — MONITORING ACTIVE</div>'
    : winnerLog.slice(0, 30).map(e => {
        const t  = new Date(e.ts).toLocaleString("en-GB");
        const tc = e.tier === "MEGA" ? "#FFD700" : e.tier === "MAJOR" ? "#60a5fa" : "#666";
        return `<div class="log-row">
          <span class="log-time">${t}</span>
          <span class="log-name">${e.name}</span>
          <span style="color:${tc};font-weight:700;font-size:10px;letter-spacing:1px">${e.tier}</span>
          <span class="log-prize">$${e.prize.toFixed(2)}</span>
        </div>`;
      }).join("");

  const jkSorted = Object.entries(winnerTally).sort((a, b) => b[1].total - a[1].total);
  const jkLbRows = jkSorted.length === 0
    ? '<tr><td colspan="7" class="empty-state" style="padding:20px;text-align:center">NO DATA YET</td></tr>'
    : jkSorted.map(([name, d], i) => {
        const rc = i === 0 ? "rank-gold" : i === 1 ? "rank-silver" : i === 2 ? "rank-bronze" : "rank-num";
        return `<tr>
          <td class="${rc}">${i+1}</td>
          <td class="name-cell">${name}</td>
          <td style="color:#FFD700;font-weight:700">${d.MEGA}</td>
          <td style="color:#60a5fa;font-weight:700">${d.MAJOR}</td>
          <td style="color:#666">${d.MINOR}</td>
          <td>${d.total}</td>
          <td style="color:#C8FF00;font-weight:700">$${d.totalPrize.toFixed(2)}</td>
        </tr>`;
      }).join("");

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="300">
<title>MOG_STATS // Jackpot</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--neon:#C8FF00;--dark:#0a0a0a;--surface:#111;--surface2:#181818;--border:#2a2a2a;--muted:#666;--red:#ff4444}
body{background:var(--dark);color:#fff;font-family:'Courier New',monospace;min-height:100vh;display:flex;flex-direction:column}
nav{display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:56px;border-bottom:1px solid var(--border);background:var(--dark);flex-shrink:0}
.logo{font-size:13px;font-weight:700;letter-spacing:3px;color:var(--neon)}
.nav-links{display:flex}
.nav-btn{background:none;border:none;color:var(--muted);font-family:inherit;font-size:11px;letter-spacing:2px;padding:0 20px;height:56px;cursor:pointer;border-bottom:2px solid transparent;transition:color .15s;text-decoration:none;display:flex;align-items:center}
.nav-btn:hover{color:#fff}
.nav-btn.active{color:var(--neon);border-bottom:2px solid var(--neon)}
.play-btn{background:var(--neon);color:#000;border:none;font-family:inherit;font-size:11px;letter-spacing:2px;padding:8px 20px;cursor:pointer;font-weight:700;text-decoration:none}
.panel{padding:32px 24px;flex:1}
.sys-label{font-size:10px;letter-spacing:3px;color:var(--muted);margin-bottom:12px;display:flex;align-items:center;gap:8px}
.sys-label::before{content:'';display:inline-block;width:24px;height:1px;background:var(--muted)}
h1{font-size:48px;font-weight:900;letter-spacing:-1px;line-height:1;margin-bottom:4px;text-transform:uppercase}
h1 span{color:var(--neon)}
.subtitle{font-size:11px;letter-spacing:2px;color:var(--muted);margin-bottom:28px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.version-tag{border:1px solid var(--border);padding:2px 10px;font-size:10px;color:var(--muted)}
.dot{width:6px;height:6px;border-radius:50%;background:var(--neon);display:inline-block;animation:blink 1.5s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}
.pool-bar{background:var(--surface2);border:1px solid var(--border);padding:16px 20px;margin-bottom:20px;display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:16px}
.pool-label{font-size:9px;letter-spacing:3px;color:var(--muted);text-transform:uppercase;margin-bottom:6px}
.pool-value{font-size:28px;font-weight:700;color:var(--neon);line-height:1}
.pool-meta{font-size:10px;color:var(--muted);margin-top:4px;letter-spacing:1px}
.winner-log{border:1px solid var(--border);background:var(--surface);margin-bottom:20px}
.log-header{background:var(--surface2);padding:10px 16px;font-size:9px;letter-spacing:3px;color:var(--muted);border-bottom:1px solid var(--border);text-transform:uppercase;display:flex;justify-content:space-between;align-items:center}
.log-row{padding:9px 16px;border-bottom:1px solid #161616;display:grid;grid-template-columns:160px 1fr 80px 90px;gap:12px;align-items:center;font-size:11px}
.log-row:last-child{border-bottom:none}
.log-time{color:var(--muted);font-size:10px;letter-spacing:1px}
.log-name{font-weight:700;color:#fff}
.log-prize{color:var(--neon);text-align:right;font-weight:700}
.empty-state{padding:32px;text-align:center;color:var(--muted);font-size:10px;letter-spacing:2px}
.section-title{font-size:9px;letter-spacing:3px;color:var(--muted);text-transform:uppercase;margin-bottom:10px;margin-top:20px}
.tbl-wrap{border:1px solid var(--border);overflow-x:auto}
table{width:100%;border-collapse:collapse;min-width:500px}
th{background:var(--surface2);color:var(--muted);font-size:9px;letter-spacing:2px;padding:10px 12px;text-align:left;border-bottom:1px solid var(--border);white-space:nowrap;text-transform:uppercase}
td{padding:9px 12px;font-size:12px;border-bottom:1px solid #1a1a1a;white-space:nowrap;color:#fff}
tr:last-child td{border-bottom:none}
tr:hover td{background:#141400}
.rank-num{color:var(--muted);font-size:11px}
.rank-gold{color:var(--neon);font-weight:700}
.rank-silver{color:#c0c0c0;font-weight:700}
.rank-bronze{color:#cd7f32;font-weight:700}
.name-cell{font-weight:700;font-size:12px}
footer{padding:16px 24px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;flex-shrink:0}
.footer-copy{font-size:9px;letter-spacing:2px;color:var(--muted)}
.footer-rpc{font-size:9px;letter-spacing:1px;color:var(--muted);display:flex;align-items:center;gap:6px}
</style>
</head><body>

<nav>
  <span class="logo">MOG_STATS</span>
  <div class="nav-links">
    <a href="/" class="nav-btn">LEADERBOARD</a>
    <a href="/jackpot" class="nav-btn active">JACKPOT</a>
  </div>
  <a href="https://axiedom.xyz" target="_blank" class="play-btn">PLAY NOW</a>
</nav>

<div class="panel">
  <div class="sys-label">SYSTEM_ACCESS_GRANTED</div>
  <h1>JACKPOT<br><span>MONITOR</span></h1>
  <div class="subtitle">
    <span>REAL-TIME WEREWOLF PRIZE TRACKER</span>
    <span class="version-tag">V.2.0.4</span>
  </div>

  <div class="pool-bar">
    <div>
      <div class="pool-label">CURRENT JACKPOT POOL</div>
      <div class="pool-value">${jkPool}</div>
      <div class="pool-meta">USDC (6 DECIMALS) — LIVE BALANCE</div>
    </div>
    <div>
      <div class="pool-label">POOL STATS</div>
      <div style="display:flex;gap:20px;margin-top:6px">
        <div><div class="pool-label">TOTAL ADDED</div><div style="color:#C8FF00;font-weight:700;font-size:14px">${jkTotalAdded}</div></div>
        <div><div class="pool-label">TOTAL PAID</div><div style="color:#ff4444;font-weight:700;font-size:14px">${jkTotalPaid}</div></div>
      </div>
    </div>
    <div>
      <div class="pool-label">PRIZE TIERS</div>
      <div style="display:flex;gap:20px;margin-top:6px">
        <div><div class="pool-label">MEGA 2%</div><div style="color:#FFD700;font-weight:700;font-size:14px">${jkMega}</div></div>
        <div><div class="pool-label">MAJOR 0.5%</div><div style="color:#60a5fa;font-weight:700;font-size:14px">${jkMajor}</div></div>
        <div><div class="pool-label">MINOR 0.1%</div><div style="color:#666;font-size:14px">${jkMinor}</div></div>
      </div>
    </div>
  </div>

  <div class="section-title">WINNER LOG — ${winnerLog.length} ENTRIES</div>
  <div class="winner-log">
    <div class="log-header"><span>RECENT WEREWOLF DEFEATS</span><span>${winnerLog.length} TOTAL</span></div>
    <div>${logRows}</div>
  </div>

  <div class="section-title">TOP PRIZE EARNERS</div>
  <div class="tbl-wrap">
    <table>
      <thead><tr>
        <th>#</th><th>WINNER</th><th>MEGA</th><th>MAJOR</th><th>MINOR</th><th>TOTAL WINS</th><th>TOTAL PRIZE</th>
      </tr></thead>
      <tbody>${jkLbRows}</tbody>
    </table>
  </div>
</div>

<footer>
  <span class="footer-copy">© 2026 MOG_STATS // TECHNICAL_SERVICES_DIV</span>
  <div style="display:flex;gap:24px;align-items:center">
    <div class="footer-rpc"><span class="dot" style="animation:none"></span>BLACK_GREEN // V2.0_LIVE</div>
    <div class="footer-rpc">RPC: ABS_MAINNET</div>
  </div>
</footer>
</body></html>`;
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send(buildPage()));
app.get("/jackpot", (req, res) => res.send(buildJackpotPage()));
app.get("/api/leaderboard", (req, res) => res.json({ updatedAt: lastUpdate, pool: poolData, data: leaderboardData }));
app.get("/api/jackpot", (req, res) => res.json({ jackpot: jackpotData, winners: winnerLog, tally: winnerTally }));
app.get("/health", (req, res) => res.json({ ok: true, updatedAt: lastUpdate }));

// ── CRON ──────────────────────────────────────────────────────────────────────
cron.schedule("*/5 * * * *", async () => {
  await refreshLeaderboard();
  await refreshJackpot();
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log("Server running on port", PORT);
  console.log("MY_ADDRESS:", MY_ADDRESS || "(not set)");
  console.log("AXIE_COOKIE:", COOKIE ? "SET (" + COOKIE.length + " chars)" : "(not set)");
  await refreshLeaderboard();
  await refreshJackpot();
});