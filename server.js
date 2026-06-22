const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let MongoClient = null;
try {
  ({ MongoClient } = require("mongodb"));
} catch (error) {
  MongoClient = null;
}

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const INDEX = path.join(ROOT, "outputs", "index.html");
const KILL_GOLD_REWARD = 50;
const MONGODB_URI = process.env.MONGODB_URI || "";
const MONGODB_DB = process.env.MONGODB_DB || "stairgame";
const ALLOWED_ORIGINS = new Set(
  String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);
const BODY_LIMIT = 64 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMITS = {
  api: { limit: 240, windowMs: RATE_LIMIT_WINDOW_MS },
  join: { limit: 30, windowMs: RATE_LIMIT_WINDOW_MS },
  state: { limit: 180, windowMs: RATE_LIMIT_WINDOW_MS },
  chat: { limit: 30, windowMs: RATE_LIMIT_WINDOW_MS },
  action: { limit: 120, windowMs: RATE_LIMIT_WINDOW_MS },
  events: { limit: 60, windowMs: RATE_LIMIT_WINDOW_MS }
};
const MAX_FLOOR = 1000000;
const MAX_GOLD = 10000000;
const MAX_LIVES = 999;
const MAX_KILLS = 100000;
const MAX_DEATHS = 100000;
const MAX_STATE_FLOOR_JUMP = 250;
const MAX_STATE_GOLD_GAIN = 1000;
const MAX_STATE_KILL_GAIN = 20;
const MAX_STATE_DEATH_GAIN = 20;
const MAX_STATE_LIFE_GAIN = 20;

const players = new Map();
const clients = new Map();
const rateBuckets = new Map();
let dbPromise = null;
let records = null;
let leaderboard = [];
const chat = [];

async function getRecords() {
  if (!MONGODB_URI || !MongoClient) return null;
  if (!dbPromise) {
    dbPromise = MongoClient.connect(MONGODB_URI)
      .then(async (client) => {
        const collection = client.db(MONGODB_DB).collection("players");
        await collection.createIndex({ playerKey: 1 }, { unique: true });
        await collection.createIndex({ bestFloor: -1, updatedAt: -1 });
        records = collection;
        await refreshLeaderboard();
        console.log("MongoDB connected");
        return collection;
      })
      .catch((error) => {
        console.warn("MongoDB disabled:", error.message);
        records = null;
        return null;
      });
  }
  return dbPromise;
}

function clampNumber(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function cleanId(value) {
  return String(value || "PLAYER").trim().replace(/\s+/g, "_").replace(/[^\w가-힣-]/g, "").slice(0, 14) || "PLAYER";
}

function cleanCountry(value) {
  return String(value || "KR").replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase() || "KR";
}

function cleanTitle(value) {
  return String(value || "").trim().slice(0, 16);
}

function cleanPlayerKey(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
    .split(",")[0]
    .trim() || "unknown";
}

function isLocalOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin || "");
}

function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (!process.env.ALLOWED_ORIGINS && isLocalOrigin(origin)) return true;
  return false;
}

function securityHeaders(req, extra = {}) {
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    ...extra
  };
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(req)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

function checkRateLimit(req, bucket = "api") {
  const config = RATE_LIMITS[bucket] || RATE_LIMITS.api;
  const now = Date.now();
  const key = `${clientIp(req)}:${bucket}`;
  const current = rateBuckets.get(key);
  if (!current || now > current.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + config.windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= config.limit;
}

function rejectRateLimited(req, res) {
  sendJson(req, res, 429, { error: "too many requests" });
}

function clampPlayerNumber(value, previous, maxIncrease, maxValue) {
  if (!Number.isFinite(Number(value))) return previous;
  const next = clampNumber(value, 0, maxValue);
  if (!Number.isFinite(Number(previous))) return next;
  return Math.min(next, clampNumber(previous, 0, maxValue) + maxIncrease);
}

function publicRecord(record) {
  return {
    id: cleanId(record.id),
    country: cleanCountry(record.country),
    floor: clampNumber(record.currentFloor || 0),
    bestFloor: clampNumber(record.bestFloor || 0),
    selectedTitle: cleanTitle(record.selectedTitle),
    hidden: false,
    shield: false,
    shieldUntil: 0,
    stunnedUntil: 0,
    kills: clampNumber(record.kills || 0),
    deaths: clampNumber(record.deaths || 0),
    gold: clampNumber(record.gold || 0),
    lives: clampNumber(record.lives || 0),
    bestTimeMs: clampNumber(record.bestTimeMs || 0),
    record: true
  };
}

async function refreshLeaderboard() {
  const collection = records || await getRecords();
  if (!collection) {
    leaderboard = [];
    return leaderboard;
  }
  const rows = await collection
    .find({}, { projection: { _id: 0, playerKey: 0 } })
    .sort({ bestFloor: -1, updatedAt: -1 })
    .limit(25)
    .toArray();
  leaderboard = rows.map(publicRecord);
  return leaderboard;
}

async function loadRecord(playerKey) {
  const key = cleanPlayerKey(playerKey);
  if (!key) return null;
  const collection = await getRecords();
  if (!collection) return null;
  return collection.findOne({ playerKey: key });
}

async function saveRecord(player, force = false) {
  if (!player.playerKey) return;
  const now = Date.now();
  if (!force && player.lastSavedAt && now - player.lastSavedAt < 5000) return;
  const collection = await getRecords();
  if (!collection) return;
  const bestFloor = Math.max(clampNumber(player.bestFloor), clampNumber(player.floor));
  const bestTimeMs = clampNumber(player.bestTimeMs || 0);
  const setFields = {
    playerKey: player.playerKey,
    id: cleanId(player.id),
    country: cleanCountry(player.country),
    selectedTitle: cleanTitle(player.selectedTitle),
    currentFloor: clampNumber(player.floor),
    gold: clampNumber(player.gold),
    lives: clampNumber(player.lives),
    deaths: clampNumber(player.deaths),
    updatedAt: new Date()
  };
  if (bestTimeMs > 0) setFields.bestTimeMs = bestTimeMs;
  await collection.updateOne(
    { playerKey: player.playerKey },
    {
      $set: setFields,
      $max: {
        bestFloor,
        kills: clampNumber(player.kills)
      },
      $setOnInsert: {
        createdAt: new Date()
      }
    },
    { upsert: true }
  );
  player.lastSavedAt = now;
  await refreshLeaderboard();
}

function sendJson(req, res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, securityHeaders(req, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  }));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > BODY_LIMIT) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function publicPlayers() {
  return [...players.values()].map((player) => ({
    onlineId: player.onlineId,
    id: player.id,
    country: player.country,
    floor: player.floor,
    bestFloor: player.bestFloor || player.floor || 0,
    selectedTitle: cleanTitle(player.selectedTitle),
    hidden: player.hidden,
    shield: player.shield,
    shieldUntil: player.shieldUntil,
    stunnedUntil: player.stunnedUntil,
    kills: player.kills,
    deaths: player.deaths || 0,
    gold: player.gold || 0,
    lives: player.lives,
    bestTimeMs: player.bestTimeMs || 0,
    runElapsedMs: player.runElapsedMs || 0
  }));
}

function broadcast(type = "state", extra = {}) {
  const payload = JSON.stringify({
    type,
    players: publicPlayers(),
    leaderboard,
    chat,
    ...extra
  });
  for (const [onlineId, res] of clients) {
    res.write(`data: ${payload}\n\n`);
    if (players.has(onlineId)) players.get(onlineId).lastSeen = Date.now();
  }
}

function cleanup() {
  const now = Date.now();
  let changed = false;
  for (const [onlineId, player] of players) {
    if (now - player.lastSeen > 30000) {
      players.delete(onlineId);
      clients.delete(onlineId);
      changed = true;
    }
  }
  if (changed) broadcast("state");
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname === "/" ? "/outputs/index.html" : url.pathname);
  const filePath = path.resolve(ROOT, `.${pathname}`);
  if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${path.sep}`)) {
    res.writeHead(403, securityHeaders(req));
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, securityHeaders(req));
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = ext === ".html" ? "text/html; charset=utf-8"
      : ext === ".js" ? "text/javascript; charset=utf-8"
      : ext === ".css" ? "text/css; charset=utf-8"
      : "application/octet-stream";
    res.writeHead(200, securityHeaders(req, { "Content-Type": type, "Cache-Control": "no-store" }));
    res.end(data);
  });
}

function siteOrigin(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  const forwardedProto = req.headers["x-forwarded-proto"];
  const isLocal = /^localhost(?::\d+)?$|^127\.0\.0\.1(?::\d+)?$/.test(host);
  const proto = forwardedProto || (isLocal ? "http" : "https");
  return `${proto}://${host}`;
}

function serveRobots(req, res) {
  const origin = siteOrigin(req);
  res.writeHead(200, securityHeaders(req, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" }));
  res.end([
    "User-agent: *",
    "Allow: /",
    `Sitemap: ${origin}/sitemap.xml`,
    ""
  ].join("\n"));
}

function serveSitemap(req, res) {
  const origin = siteOrigin(req);
  const today = new Date().toISOString().slice(0, 10);
  res.writeHead(200, securityHeaders(req, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" }));
  res.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${origin}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${origin}/privacy.html</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.4</priority>
  </url>
  <url>
    <loc>${origin}/contact.html</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.4</priority>
  </url>
</urlset>
`);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    if (!isAllowedOrigin(req)) {
      res.writeHead(403, securityHeaders(req));
      res.end();
      return;
    }
    res.writeHead(204, securityHeaders(req, {
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    }));
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (!isAllowedOrigin(req)) {
      sendJson(req, res, 403, { error: "origin not allowed" });
      return;
    }

    if (url.pathname.startsWith("/api/") && !checkRateLimit(req, "api")) {
      rejectRateLimited(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/robots.txt") {
      serveRobots(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/sitemap.xml") {
      serveSitemap(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/join") {
      if (!checkRateLimit(req, "join")) {
        rejectRateLimited(req, res);
        return;
      }
      const body = await readBody(req);
      const requestedId = String(body.onlineId || "");
      const onlineId = requestedId && players.has(requestedId) ? requestedId : crypto.randomUUID();
      const id = cleanId(body.id);
      const country = cleanCountry(body.country);
      const playerKey = cleanPlayerKey(body.playerKey || onlineId);
      const saved = await loadRecord(playerKey);
      const startFloor = saved && cleanId(saved.id) === id ? clampNumber(saved.currentFloor || 0, 0, MAX_FLOOR) : 0;
      const player = {
        onlineId,
        playerKey,
        id,
        country,
        floor: startFloor,
        bestFloor: Math.max(saved ? 0 : clampNumber(body.bestFloor || 0, 0, 500), startFloor, clampNumber(saved && saved.bestFloor, 0, MAX_FLOOR)),
        selectedTitle: saved ? cleanTitle(saved.selectedTitle) : cleanTitle(body.selectedTitle),
        bestTimeMs: saved ? clampNumber(saved.bestTimeMs || 0) : clampNumber(body.bestTimeMs || 0),
        hidden: Boolean(body.hidden),
        shield: Boolean(body.shield),
        shieldUntil: clampNumber(body.shieldUntil || 0),
        stunnedUntil: clampNumber(body.stunnedUntil || 0),
        kills: Math.max(saved ? 0 : clampNumber(body.kills || 0, 0, 20), clampNumber(saved && saved.kills, 0, MAX_KILLS)),
        deaths: Math.max(saved ? 0 : clampNumber(body.deaths || 0, 0, 10), clampNumber(saved && saved.deaths, 0, MAX_DEATHS)),
        gold: saved ? clampNumber(saved.gold, 0, MAX_GOLD) : clampNumber(body.gold || 0, 0, 500),
        lives: saved ? clampNumber(saved.lives, 0, MAX_LIVES) : clampNumber(body.lives || 0, 0, 10),
        lastSeen: Date.now()
      };
      players.set(onlineId, player);
      await saveRecord(player, true);
      broadcast("state");
      sendJson(req, res, 200, { onlineId, players: publicPlayers(), leaderboard, chat });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/state") {
      if (!checkRateLimit(req, "state")) {
        rejectRateLimited(req, res);
        return;
      }
      const body = await readBody(req);
      const player = players.get(String(body.onlineId || ""));
      if (!player) {
        sendJson(req, res, 404, { error: "unknown player" });
        return;
      }
      const previousGold = player.gold;
      const previousLives = player.lives;
      const previousKills = player.kills;
      const previousDeaths = player.deaths || 0;
      const previousBestFloor = player.bestFloor;
      const previousBestTimeMs = player.bestTimeMs || 0;
      const previousSelectedTitle = player.selectedTitle || "";
      const incomingBestFloor = Number.isFinite(Number(body.bestFloor)) ? clampNumber(body.bestFloor) : 0;
      if (Number.isFinite(Number(body.floor))) player.floor = clampPlayerNumber(body.floor, player.floor, MAX_STATE_FLOOR_JUMP, MAX_FLOOR);
      if (Number.isFinite(Number(body.kills))) player.kills = clampPlayerNumber(body.kills, player.kills, MAX_STATE_KILL_GAIN, MAX_KILLS);
      if (Number.isFinite(Number(body.deaths))) player.deaths = clampPlayerNumber(body.deaths, player.deaths || 0, MAX_STATE_DEATH_GAIN, MAX_DEATHS);
      if (Number.isFinite(Number(body.gold))) player.gold = clampPlayerNumber(body.gold, player.gold, MAX_STATE_GOLD_GAIN, MAX_GOLD);
      if (Number.isFinite(Number(body.lives))) player.lives = clampPlayerNumber(body.lives, player.lives, MAX_STATE_LIFE_GAIN, MAX_LIVES);
      if (Number.isFinite(Number(body.stunnedUntil))) player.stunnedUntil = clampNumber(body.stunnedUntil, 0, Date.now() + 30000);
      if (Number.isFinite(Number(body.shieldUntil))) player.shieldUntil = clampNumber(body.shieldUntil, 0, Date.now() + 30000);
      if (Number.isFinite(Number(body.bestTimeMs))) {
        const incomingBestTime = clampNumber(body.bestTimeMs || 0);
        if (incomingBestTime > 0 && (incomingBestFloor > (player.bestFloor || 0) || !player.bestTimeMs || (incomingBestFloor === (player.bestFloor || 0) && incomingBestTime < player.bestTimeMs))) {
          player.bestTimeMs = incomingBestTime;
        }
      }
      if (incomingBestFloor > 0) {
        player.bestFloor = Math.max(player.bestFloor || 0, Math.min(incomingBestFloor, player.floor + MAX_STATE_FLOOR_JUMP));
      }
      if (Number.isFinite(Number(body.runElapsedMs))) player.runElapsedMs = clampNumber(body.runElapsedMs || 0);
      if (typeof body.selectedTitle === "string") player.selectedTitle = cleanTitle(body.selectedTitle);
      player.bestFloor = Math.max(player.bestFloor || 0, player.floor || 0);
      for (const key of ["hidden", "shield"]) {
        if (typeof body[key] === "boolean") player[key] = body[key];
      }
      player.lastSeen = Date.now();
      await saveRecord(player, player.gold !== previousGold || player.lives !== previousLives || player.kills !== previousKills || (player.deaths || 0) !== previousDeaths || player.bestFloor !== previousBestFloor || (player.bestTimeMs || 0) !== previousBestTimeMs || (player.selectedTitle || "") !== previousSelectedTitle);
      broadcast("state");
      sendJson(req, res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      if (!checkRateLimit(req, "chat")) {
        rejectRateLimited(req, res);
        return;
      }
      const body = await readBody(req);
      const player = players.get(String(body.onlineId || ""));
      if (!player) {
        sendJson(req, res, 404, { error: "unknown player" });
        return;
      }
      const text = String(body.text || "").trim().slice(0, 70);
      if (text) {
        chat.push({ id: player.id, country: player.country, text });
        while (chat.length > 60) chat.shift();
        player.lastSeen = Date.now();
        broadcast("chat");
      }
      sendJson(req, res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/attack") {
      if (!checkRateLimit(req, "action")) {
        rejectRateLimited(req, res);
        return;
      }
      const body = await readBody(req);
      const attacker = players.get(String(body.onlineId || ""));
      const targetId = String(body.targetId || "");
      const target = players.get(targetId);
      if (!attacker || !target) {
        sendJson(req, res, 404, { error: "unknown player" });
        return;
      }
      const reason = String(body.reason || `${attacker.id}이 ${target.id}을 공격했습니다.`).slice(0, 120);
      const targetLives = Math.max(0, Number(target.lives || 0));
      const fell = targetLives <= 0;
      if (fell) {
        target.floor = 0;
        target.hidden = false;
        attacker.kills += 1;
        attacker.gold = (attacker.gold || 0) + KILL_GOLD_REWARD;
      } else {
        target.lives = targetLives - 1;
        target.hidden = false;
      }
      attacker.lastSeen = Date.now();
      target.lastSeen = Date.now();
      await saveRecord(attacker, true);
      await saveRecord(target, true);
      const targetClient = clients.get(targetId);
      const payload = { type: "attacked", reason, attackerId: attacker.onlineId, fell, lives: target.lives || 0, players: publicPlayers(), leaderboard, chat };
      if (targetClient) {
        targetClient.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
      broadcast("state");
      sendJson(req, res, 200, { ok: true, kills: attacker.kills, gold: attacker.gold, target: { id: target.id, lives: target.lives || 0, fell } });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/stun") {
      if (!checkRateLimit(req, "action")) {
        rejectRateLimited(req, res);
        return;
      }
      const body = await readBody(req);
      const source = players.get(String(body.onlineId || ""));
      const targetId = String(body.targetId || "");
      const target = players.get(targetId);
      if (!source || !target) {
        sendJson(req, res, 404, { error: "unknown player" });
        return;
      }
      const ms = Math.max(500, Math.min(5000, Number(body.ms || 3000)));
      const reason = String(body.reason || "스턴").slice(0, 80);
      source.lastSeen = Date.now();
      const targetClient = clients.get(targetId);
      if (targetClient) {
        targetClient.write(`data: ${JSON.stringify({ type: "stunned", reason, ms, sourceId: source.onlineId, players: publicPlayers(), leaderboard, chat })}\n\n`);
      }
      broadcast("state");
      sendJson(req, res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/leave") {
      const body = await readBody(req);
      const onlineId = String(body.onlineId || "");
      if (onlineId) {
        const leaving = players.get(onlineId);
        if (leaving) await saveRecord(leaving, true);
        players.delete(onlineId);
        clients.delete(onlineId);
        await refreshLeaderboard();
        broadcast("state");
      }
      sendJson(req, res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/events") {
      if (!checkRateLimit(req, "events")) {
        res.writeHead(429, securityHeaders(req));
        res.end("too many requests");
        return;
      }
      const onlineId = String(url.searchParams.get("id") || "");
      if (!players.has(onlineId)) {
        res.writeHead(404, securityHeaders(req));
        res.end("unknown player");
        return;
      }
      res.writeHead(200, securityHeaders(req, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive"
      }));
      clients.set(onlineId, res);
      res.write(`data: ${JSON.stringify({ type: "state", players: publicPlayers(), leaderboard, chat })}\n\n`);
      req.on("close", () => {
        if (clients.get(onlineId) === res) {
          const leaving = players.get(onlineId);
          clients.delete(onlineId);
          Promise.resolve()
            .then(() => leaving ? saveRecord(leaving, true) : null)
            .then(() => {
              players.delete(onlineId);
              return refreshLeaderboard();
            })
            .then(() => broadcast("state"))
            .catch(() => {
              players.delete(onlineId);
              broadcast("state");
            });
        }
      });
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    console.error(error);
    sendJson(req, res, 500, { error: "server error" });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now > bucket.resetAt + RATE_LIMIT_WINDOW_MS) rateBuckets.delete(key);
  }
  cleanup();
  refreshLeaderboard().catch(() => {});
  broadcast("state");
}, 5000).unref();

server.listen(PORT, "0.0.0.0", () => {
  getRecords().catch(() => {});
  console.log(`Stair game online server: http://localhost:${PORT}`);
  console.log("같은 네트워크 밖 친구에게 공유하려면 Render/Railway/Fly.io 같은 Node 서버 배포 서비스를 사용하세요.");
  if (!fs.existsSync(INDEX)) console.warn("outputs/index.html 파일을 찾지 못했습니다.");
});
