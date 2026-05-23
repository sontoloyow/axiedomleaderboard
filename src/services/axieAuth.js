const fs = require("fs/promises");
const path = require("path");
const https = require("https");
const { Wallet, getAddress } = require("ethers");

const SITE_ORIGIN = "https://axiedom.xyz";
const SITE_DOMAIN = "axiedom.xyz";
const CHAIN_ID = 2020;
const COOKIE_FILE = process.env.AXIE_COOKIE_FILE || path.join(process.cwd(), "data", "axie_cookie.txt");

let currentCookie = process.env.AXIE_COOKIE || "";
let currentCookieLoaded = false;
let refreshPromise = null;

function lower(value) {
  return (value || "").toLowerCase();
}

function normalizeCookieString(value) {
  return (value || "")
    .split(";")
    .map(part => part.trim())
    .filter(Boolean)
    .join("; ");
}

function parseSetCookieHeaders(headers, existingCookie = "") {
  const jar = new Map();
  const append = (cookieStr) => {
    const first = cookieStr.split(";")[0];
    const idx = first.indexOf("=");
    if (idx <= 0) return;
    const name = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (name) jar.set(name, value);
  };

  normalizeCookieString(existingCookie).split("; ").filter(Boolean).forEach(part => append(part));
  const setCookie = headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const cookie of cookies) append(cookie);

  return Array.from(jar.entries()).map(([name, value]) => `${name}=${value}`).join("; ");
}

function httpRequest(url, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0",
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: SITE_ORIGIN + "/",
        Origin: SITE_ORIGIN,
        ...headers,
      },
    }, (res) => {
      let raw = "";
      res.on("data", chunk => raw += chunk);
      res.on("end", () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        body: raw,
      }));
    });
    req.on("error", reject);
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function readCookieFromDisk() {
  if (currentCookieLoaded) return currentCookie;
  currentCookieLoaded = true;
  try {
    const raw = await fs.readFile(COOKIE_FILE, "utf8");
    const cookie = normalizeCookieString(raw.trim());
    if (cookie) currentCookie = cookie;
  } catch {
    // optional cache
  }
  return currentCookie;
}

async function writeCookieToDisk(cookie) {
  const normalized = normalizeCookieString(cookie);
  if (!normalized) return;
  await fs.mkdir(path.dirname(COOKIE_FILE), { recursive: true });
  await fs.writeFile(COOKIE_FILE, normalized, "utf8");
}

function getAddressFromPrivateKey(privateKey) {
  return getAddress(new Wallet(privateKey).address);
}

function buildSiweMessage({ address, nonce, issuedAt, expirationTime }) {
  return `${SITE_DOMAIN} wants you to sign in with your Ethereum account:\n${address}\n\nSign in with Ethereum to the app.\n\nURI: ${SITE_ORIGIN}\nVersion: 1\nChain ID: ${CHAIN_ID}\nNonce: ${nonce}\nIssued At: ${issuedAt}${expirationTime ? `\nExpiration Time: ${expirationTime}` : ""}`;
}

function extractNonce(body) {
  const text = (body || "").trim();
  if (!text) return "";
  try {
    const json = JSON.parse(text);
    if (typeof json === "string") return json.trim();
    if (json.nonce) return String(json.nonce).trim();
    if (json.data?.nonce) return String(json.data.nonce).trim();
  } catch {
    // fall through
  }
  const hexMatch = text.match(/[a-f0-9]{10,}/i);
  return hexMatch ? hexMatch[0] : text;
}

function candidateRequests({ message, signature, address }) {
  const jsonHeaders = { "Content-Type": "application/json", Accept: "application/json, text/plain, */*" };
  const formHeaders = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json, text/plain, */*" };
  const jsonBase = { message, signature, address };
  const formBase = new URLSearchParams(jsonBase).toString();
  return [
    { url: `${SITE_ORIGIN}/api/auth/verify`, method: "POST", headers: jsonHeaders, body: JSON.stringify(jsonBase) },
    { url: `${SITE_ORIGIN}/api/auth/verify`, method: "POST", headers: formHeaders, body: formBase },
    { url: `${SITE_ORIGIN}/api/auth/login`, method: "POST", headers: jsonHeaders, body: JSON.stringify(jsonBase) },
    { url: `${SITE_ORIGIN}/api/auth/login`, method: "POST", headers: formHeaders, body: formBase },
    { url: `${SITE_ORIGIN}/api/auth/signin`, method: "POST", headers: jsonHeaders, body: JSON.stringify(jsonBase) },
    { url: `${SITE_ORIGIN}/api/auth/callback/credentials`, method: "POST", headers: jsonHeaders, body: JSON.stringify({
      message,
      signature,
      address,
      redirect: false,
      callbackUrl: SITE_ORIGIN,
    }) },
    { url: `${SITE_ORIGIN}/api/auth/callback/credentials`, method: "POST", headers: formHeaders, body: new URLSearchParams({
      message,
      signature,
      address,
      redirect: "false",
      callbackUrl: SITE_ORIGIN,
    }).toString() },
    { url: `${SITE_ORIGIN}/api/auth/callback/siwe`, method: "POST", headers: jsonHeaders, body: JSON.stringify(jsonBase) },
  ];
}

async function refreshCookie() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const privateKey = process.env.AXIE_PRIVATE_KEY || "";
    if (!privateKey) throw new Error("AXIE_PRIVATE_KEY is not set");

    const wallet = new Wallet(privateKey);
    const envAddress = process.env.MY_ADDRESS || "";
    const derivedAddress = getAddress(wallet.address);
    if (envAddress && lower(envAddress) !== lower(derivedAddress)) {
      console.warn(`[auth] MY_ADDRESS mismatch; using derived signer address ${derivedAddress}`);
    }

    const nonceRes = await httpRequest(`${SITE_ORIGIN}/api/auth/nonce`, {
      headers: { Accept: "application/json, text/plain, */*" },
    });
    if (nonceRes.status >= 400) {
      throw new Error(`nonce HTTP ${nonceRes.status}`);
    }
    const nonce = extractNonce(nonceRes.body);
    if (!nonce) throw new Error("nonce missing");

    const issuedAt = new Date().toISOString();
    const expirationTime = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const message = buildSiweMessage({ address: derivedAddress, nonce, issuedAt, expirationTime });
    const signature = await wallet.signMessage(message);

    let lastError = null;
    for (const req of candidateRequests({ message, signature, address: derivedAddress })) {
      try {
        const res = await httpRequest(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
        });
        const mergedCookie = parseSetCookieHeaders(res.headers, currentCookie);
        if (mergedCookie.includes("siwe-session=")) {
          currentCookie = mergedCookie;
          await writeCookieToDisk(currentCookie);
          return currentCookie;
        }
        if (res.status < 400 && res.body && /siwe-session|success|signed in|authenticated/i.test(res.body)) {
          currentCookie = mergedCookie || currentCookie;
          if (currentCookie) await writeCookieToDisk(currentCookie);
          return currentCookie;
        }
        lastError = new Error(`auth ${res.status}`);
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError || new Error("auth refresh failed");
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function ensureCookie() {
  await readCookieFromDisk();
  if (currentCookie && currentCookie.includes("siwe-session=")) return currentCookie;
  return refreshCookie();
}

function getCookie() {
  return normalizeCookieString(currentCookie);
}

async function setCookie(cookie) {
  currentCookie = normalizeCookieString(cookie);
  currentCookieLoaded = true;
  if (currentCookie) await writeCookieToDisk(currentCookie);
  return currentCookie;
}

async function invalidateCookie() {
  currentCookie = "";
  currentCookieLoaded = true;
  try {
    await fs.unlink(COOKIE_FILE);
  } catch {
    // ignore
  }
}

module.exports = {
  ensureCookie,
  getCookie,
  getAddressFromPrivateKey,
  invalidateCookie,
  refreshCookie,
  setCookie,
};
