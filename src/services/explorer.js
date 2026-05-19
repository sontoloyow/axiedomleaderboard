const https = require("https");

const EXPLORER_API = "https://explorer.roninchain.com/api/v2";
const CONTRACT_BLESS = "0xb85b9b814d01a77d661d92852abbfa606d10c591";
const METHOD_BLESS = "0x01608d9c";
const METHOD_PAY = "0x219e0149";

function lower(value) {
  return (value || "").toLowerCase();
}

function fetchExplorer(url, cookie = "") {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0",
        Accept: "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://explorer.roninchain.com/",
        Cookie: cookie,
      },
    }, (res) => {
      let raw = "";
      res.on("data", chunk => raw += chunk);
      res.on("end", () => {
        try {
          const body = JSON.parse(raw);
          if (res.statusCode >= 400) {
            const msg = body.errors?.[0]?.detail || body.message || raw.slice(0, 120);
            reject(new Error(`Explorer HTTP ${res.statusCode}: ${msg}`));
            return;
          }
          resolve(body);
        } catch {
          reject(new Error("JSON parse: " + raw.slice(0, 100)));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function fetchPlayerTxs(address, cookie = "") {
  let items = [];
  let nextParams = null;
  let page = 0;

  while (page < 4) {
    let url = `${EXPLORER_API}/addresses/${address}/transactions`;
    if (nextParams) {
      const qs = Object.entries(nextParams)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&");
      url += `?${qs}`;
    }

    try {
      const data = await fetchExplorer(url, cookie);
      items = items.concat(data.items || []);
      nextParams = data.next_page_params || null;
      if (!nextParams) break;
    } catch (e) {
      console.error("[explorer]", e.message);
      break;
    }

    page++;
  }

  return items;
}

function fetchTxDetail(txHash, cookie = "") {
  return fetchExplorer(`${EXPLORER_API}/transactions/${txHash}`, cookie);
}

function sumIncomingUsdcTransfers(detail, address) {
  const target = lower(address);
  return (detail.token_transfers || [])
    .filter(t => t.token && t.token.symbol === "USDC")
    .filter(t => lower(t.to?.hash) === target)
    .reduce((sum, t) => {
      const value = parseInt(t.total?.value || "0", 10);
      const decimals = parseInt(t.total?.decimals || "6", 10);
      return sum + (value / Math.pow(10, decimals));
    }, 0);
}

async function enrichTxs(txList, methodLabel, address, cookie = "") {
  const capped = txList.slice(0, 20);
  const results = await Promise.all(capped.map(async tx => {
    try {
      const detail = await fetchTxDetail(tx.hash, cookie);
      const usdt = sumIncomingUsdcTransfers(detail, address);
      return { hash: tx.hash, timestamp: tx.timestamp, method: methodLabel, usdt: +usdt.toFixed(6) };
    } catch {
      return { hash: tx.hash, timestamp: tx.timestamp, method: methodLabel, usdt: 0 };
    }
  }));
  return results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

async function fetchClaimHistory(address, cookie = "") {
  const txItems = await fetchPlayerTxs(address, cookie);
  const blessingTxs = txItems.filter(tx =>
    lower(tx.to?.hash) === CONTRACT_BLESS &&
    lower(tx.method) === METHOD_BLESS &&
    tx.status === "ok"
  );
  const payoutTxs = txItems.filter(tx =>
    lower(tx.to?.hash) === CONTRACT_BLESS &&
    lower(tx.method) === METHOD_PAY &&
    tx.status === "ok"
  );

  const [blessingDetails, payoutDetails] = await Promise.all([
    enrichTxs(blessingTxs, "CLAIM BLESSING", address, cookie),
    enrichTxs(payoutTxs, "CLAIM PAYOUT", address, cookie),
  ]);

  return { blessingDetails, payoutDetails };
}

module.exports = {
  fetchClaimHistory,
};
