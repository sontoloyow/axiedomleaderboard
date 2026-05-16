const express = require("express");
const cron    = require("node-cron");
const https   = require("https");
const fs      = require("fs");
const ExcelJS = require("exceljs");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── simpan data terakhir di memory ──
let lastData   = null;
let lastUpdate = null;

// ── cookie dari environment variable (lebih aman) ──
const COOKIE     = process.env.AXIE_COOKIE || "";
const MY_ADDRESS = process.env.MY_ADDRESS  || "0xed48ed14dc76df9bc404f1e21d6f71c977c71c19";
const SNAPSHOT_FILE = "axiedom_snapshot.json";

// ... (paste fungsi fetchJSON, calc, loadSnapshot, saveSnapshot dari script lama)

async function refreshData() {
  console.log("[cron]", new Date().toISOString(), "fetching...");
  const lb   = await fetchJSON(`https://axiedom.xyz/api/runs?mode=weekly&address=${MY_ADDRESS}`);
  const pool = await fetchJSON("https://axiedom.xyz/api/weekly-pool");

  const poolUSDT      = parseInt(pool.currentPoolWei) / 1_000_000;
  const totalTreasure = lb.totalGlobalTreasure;
  const snapshot      = loadSnapshot();
  const isSameWeek    = snapshot && snapshot.weekNumber === lb.weekNumber;

  let players = [...(lb.leaderboard || [])];
  if (lb.userStats && !players.find(p => p.address.toLowerCase() === lb.userStats.address.toLowerCase()))
    players.push(lb.userStats);
  players.sort((a, b) => a.rank - b.rank);

  lastData = players.map(p => {
    const payout  = (poolUSDT / totalTreasure) * p.treasure;
    const cost    = p.totalKeysSpent * 2;
    const earning = payout - cost;
    const prev    = isSameWeek ? snapshot.keys[p.address.toLowerCase()] : undefined;
    const diff    = prev !== undefined ? p.totalKeysSpent - prev : null;
    return { ...p, payout: +payout.toFixed(4), cost, earning: +earning.toFixed(4), keysDiff: diff };
  });

  lastUpdate = new Date().toISOString();
  saveSnapshot(players, lb.weekNumber);
  console.log("[cron] done,", players.length, "players");
}

// ── endpoint: tabel HTML ──
app.get("/", (req, res) => {
  if (!lastData) return res.send("<p>Loading... coba refresh 30 detik lagi.</p>");
  const rows = lastData.map(p => `
    <tr style="background:${p.address.toLowerCase()===MY_ADDRESS.toLowerCase()?"#fffbe6":""}">
      <td>${p.rank}</td>
      <td>${p.profileName||p.address.slice(0,10)+"…"}</td>
      <td>${p.treasure.toLocaleString()}</td>
      <td>${p.runCount}</td>
      <td>${p.totalKeysSpent}</td>
      <td style="color:${p.keysDiff>0?"purple":p.keysDiff<0?"red":"inherit"}">${p.keysDiff===null?"—":p.keysDiff>0?"+"+p.keysDiff:p.keysDiff}</td>
      <td>${p.payout.toFixed(2)}</td>
      <td>${p.cost}</td>
      <td style="color:${p.earning>=0?"green":"red"}">${p.earning>=0?"+":""}${p.earning.toFixed(2)}</td>
    </tr>`).join("");

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>Axie Dom Leaderboard</title>
    <meta http-equiv="refresh" content="300">
    <style>body{font-family:sans-serif;padding:16px}table{border-collapse:collapse;width:100%}th,td{padding:6px 10px;border:1px solid #ddd;font-size:13px}th{background:#2E86AB;color:#fff}</style>
  </head><body>
    <h2>Axie Dom Leaderboard</h2>
    <p>Update terakhir: <b>${lastUpdate}</b> — auto-refresh tiap 5 menit</p>
    <table><thead><tr><th>Rank</th><th>Name</th><th>Treasure</th><th>Runs</th><th>Keys</th><th>Keys Diff</th><th>Payout</th><th>Cost</th><th>Earning</th></tr></thead>
    <tbody>${rows}</tbody></table>
  </body></html>`);
});

// ── endpoint: JSON mentah ──
app.get("/api", (req, res) => res.json({ updatedAt: lastUpdate, data: lastData }));

// ── jalankan cron tiap 5 menit ──
cron.schedule("*/5 * * * *", refreshData);

app.listen(PORT, async () => {
  console.log("Server running on port", PORT);
  await refreshData(); // langsung fetch saat pertama start
});