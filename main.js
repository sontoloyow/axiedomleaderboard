const express = require("express");
const cron    = require("node-cron");
const https   = require("https");
const fs      = require("fs");

const app  = express();
const PORT = process.env.PORT || 3000;

const MY_ADDRESS    = process.env.MY_ADDRESS  || "0xed48ed14dc76df9bc404f1e21d6f71c977c71c19";
const COOKIE        = process.env.AXIE_COOKIE || "";
const SNAPSHOT_FILE = "axiedom_snapshot.json";

let lastData   = null;
let lastUpdate = null;

// ── REQUEST HEADERS ───────────────────────────────────────────────────────────
function getHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://axiedom.xyz/",
    "Connection": "keep-alive",
    "Cookie": COOKIE,
  };
}

// ── FETCH HELPER ──────────────────────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: getHeaders() }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error("Failed to parse JSON: " + raw.slice(0, 300)));
        }
      });
    });
    req.on("error", reject);
  });
}

// ── SNAPSHOT HELPERS ──────────────────────────────────────────────────────────
function loadSnapshot() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveSnapshot(players, weekNumber) {
  const data = { savedAt: new Date().toISOString(), weekNumber, keys: {} };
  players.forEach((p) => {
    data.keys[p.address.toLowerCase()] = p.totalKeysSpent;
  });
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data, null, 2), "utf8");
}

// ── CALCULATE ─────────────────────────────────────────────────────────────────
function calc(player, poolUSDT, totalTreasure) {
  const payout  = (poolUSDT / totalTreasure) * player.treasure;
  const cost    = player.totalKeysSpent * 2;
  const earning = payout - cost;
  return {
    payout:  +payout.toFixed(4),
    cost,
    earning: +earning.toFixed(4),
  };
}

// ── MAIN FETCH & PROCESS ──────────────────────────────────────────────────────
async function refreshData() {
  console.log("[cron]", new Date().toISOString(), "fetching...");
  try {
    const lb   = await fetchJSON(`https://axiedom.xyz/api/runs?mode=weekly&address=${MY_ADDRESS}`);
    const pool = await fetchJSON("https://axiedom.xyz/api/weekly-pool");

    const poolUSDT      = parseInt(pool.currentPoolWei) / 1_000_000;
    const totalTreasure = lb.totalGlobalTreasure;
    const snapshot      = loadSnapshot();
    const isSameWeek    = snapshot && snapshot.weekNumber === lb.weekNumber;

    let players = [...(lb.leaderboard || [])];
    const addrs = new Set(players.map((p) => p.address.toLowerCase()));
    if (lb.userStats && !addrs.has(lb.userStats.address.toLowerCase())) {
      players.push(lb.userStats);
    }
    players.sort((a, b) => a.rank - b.rank);

    lastData = players.map((p) => {
      const { payout, cost, earning } = calc(p, poolUSDT, totalTreasure);
      const prev    = isSameWeek ? snapshot.keys[p.address.toLowerCase()] : undefined;
      const keysDiff = prev !== undefined ? p.totalKeysSpent - prev : null;
      return { ...p, poolUSDT, totalTreasure, payout, cost, earning, keysDiff };
    });

    lastUpdate = new Date().toISOString();
    saveSnapshot(players, lb.weekNumber);
    console.log("[cron] done,", players.length, "rows");
  } catch (err) {
    console.error("[cron] error:", err.message);
  }
}

// ── HTML PAGE ─────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  if (!lastData) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
      <meta http-equiv="refresh" content="10">
      <title>Loading...</title>
      <style>body{font-family:sans-serif;padding:32px;color:#333}</style>
      </head><body><h2>Memuat data...</h2><p>Halaman akan refresh otomatis.</p></body></html>`);
  }

  const first      = lastData[0];
  const poolUSDT   = first ? first.poolUSDT : 0;
  const totalTreas = first ? first.totalTreasure : 0;

  const rows = lastData.map((p) => {
    const isMe     = p.address.toLowerCase() === MY_ADDRESS.toLowerCase();
    const rowBg    = isMe ? "#fffbe6" : "";
    const earnColor = p.earning >= 0 ? "#155724" : "#721c24";
    const diffColor = p.keysDiff > 0 ? "#4a148c" : p.keysDiff < 0 ? "#c62828" : "#333";
    const diffText  = p.keysDiff === null ? "—" : p.keysDiff > 0 ? `+${p.keysDiff}` : `${p.keysDiff}`;
    return `<tr style="background:${rowBg}">
      <td>${p.rank}</td>
      <td>${p.profileName || p.address.slice(0, 10) + "…"}${isMe ? " ★" : ""}</td>
      <td>${p.treasure.toLocaleString()}</td>
      <td>${p.marbles.toLocaleString()}</td>
      <td>${p.runCount}</td>
      <td>${p.totalKeysSpent}</td>
      <td style="color:${diffColor};font-weight:${p.keysDiff > 0 ? "bold" : "normal"}">${diffText}</td>
      <td>${p.payout.toFixed(2)}</td>
      <td>${p.cost}</td>
      <td style="color:${earnColor};font-weight:bold">${p.earning >= 0 ? "+" : ""}${p.earning.toFixed(2)}</td>
    </tr>`;
  }).join("");

  res.send(`<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="300">
  <title>Axie Dom Leaderboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; padding: 16px; background: #f5f5f5; color: #222; }
    h2 { margin-bottom: 6px; font-size: 20px; }
    .meta { font-size: 12px; color: #666; margin-bottom: 12px; }
    .info { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 14px; }
    .card { background: #fff; border-radius: 8px; padding: 10px 16px; font-size: 13px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    .card b { display: block; font-size: 18px; }
    .wrap { overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    th { background: #2E86AB; color: #fff; padding: 9px 10px; font-size: 12px; text-align: left; white-space: nowrap; }
    td { padding: 7px 10px; font-size: 12px; border-bottom: 1px solid #eee; white-space: nowrap; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #f0f7ff; }
    .legend { font-size: 11px; color: #888; margin-top: 10px; }
  </style>
</head><body>
  <h2>Axie Dom Weekly Leaderboard</h2>
  <p class="meta">Update terakhir: <b>${lastUpdate}</b> — auto-refresh tiap 5 menit</p>
  <div class="info">
    <div class="card"><span>Pool</span><b>${poolUSDT.toLocaleString()} USDT</b></div>
    <div class="card"><span>Total Treasure</span><b>${totalTreas.toLocaleString()}</b></div>
    <div class="card"><span>Total Pemain</span><b>${lastData.length}</b></div>
  </div>
  <div class="wrap">
    <table>
      <thead><tr>
        <th>Rank</th><th>Name</th><th>Treasure</th><th>Marbles</th>
        <th>Runs</th><th>Keys</th><th>Keys Diff</th>
        <th>Payout (USDT)</th><th>Cost (USDT)</th><th>Earning (USDT)</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <p class="legend">★ = akun kamu | Keys Diff = selisih keys vs run sebelumnya | Earning = Payout − Cost</p>
</body></html>`);
});

// ── JSON API ──────────────────────────────────────────────────────────────────
app.get("/api", (req, res) => {
  res.json({ updatedAt: lastUpdate, count: lastData ? lastData.length : 0, data: lastData });
});

// ── CRON: tiap 5 menit ────────────────────────────────────────────────────────
cron.schedule("*/5 * * * *", refreshData);

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log("Server running on port", PORT);
  await refreshData();
});