const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const INDEX = path.join(ROOT, "outputs", "index.html");

const players = new Map();
const clients = new Map();
const chat = [{ id: "SYSTEM", country: "--", text: "온라인 서버가 준비되었습니다." }];

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) req.destroy();
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
    hidden: player.hidden,
    shield: player.shield,
    shieldUntil: player.shieldUntil,
    stunnedUntil: player.stunnedUntil,
    kills: player.kills,
    lives: player.lives
  }));
}

function broadcast(type = "state", extra = {}) {
  const payload = JSON.stringify({
    type,
    players: publicPlayers(),
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
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = ext === ".html" ? "text/html; charset=utf-8"
      : ext === ".js" ? "text/javascript; charset=utf-8"
      : ext === ".css" ? "text/css; charset=utf-8"
      : "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "POST" && url.pathname === "/api/join") {
      const body = await readBody(req);
      const onlineId = crypto.randomUUID();
      const id = String(body.id || "PLAYER").slice(0, 14).replace(/\s+/g, "_");
      const country = String(body.country || "KR").slice(0, 3);
      players.set(onlineId, {
        onlineId,
        id,
        country,
        floor: 0,
        hidden: false,
        shield: false,
        shieldUntil: 0,
        stunnedUntil: 0,
        kills: 0,
        lives: 0,
        lastSeen: Date.now()
      });
      chat.push({ id: "SYSTEM", country: "--", text: `${id}님이 접속했습니다.` });
      while (chat.length > 60) chat.shift();
      broadcast("state");
      sendJson(res, 200, { onlineId, players: publicPlayers(), chat });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/state") {
      const body = await readBody(req);
      const player = players.get(String(body.onlineId || ""));
      if (!player) {
        sendJson(res, 404, { error: "unknown player" });
        return;
      }
      for (const key of ["floor", "stunnedUntil", "shieldUntil", "kills", "lives"]) {
        if (Number.isFinite(Number(body[key]))) player[key] = Number(body[key]);
      }
      for (const key of ["hidden", "shield"]) {
        if (typeof body[key] === "boolean") player[key] = body[key];
      }
      player.lastSeen = Date.now();
      broadcast("state");
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = await readBody(req);
      const player = players.get(String(body.onlineId || ""));
      if (!player) {
        sendJson(res, 404, { error: "unknown player" });
        return;
      }
      const text = String(body.text || "").trim().slice(0, 70);
      if (text) {
        chat.push({ id: player.id, country: player.country, text });
        while (chat.length > 60) chat.shift();
        player.lastSeen = Date.now();
        broadcast("chat");
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/attack") {
      const body = await readBody(req);
      const attacker = players.get(String(body.onlineId || ""));
      const targetId = String(body.targetId || "");
      const target = players.get(targetId);
      if (!attacker || !target) {
        sendJson(res, 404, { error: "unknown player" });
        return;
      }
      attacker.kills += 1;
      attacker.lastSeen = Date.now();
      const reason = String(body.reason || `${attacker.id}에게 당했습니다.`).slice(0, 120);
      const targetClient = clients.get(targetId);
      if (targetClient) {
        targetClient.write(`data: ${JSON.stringify({ type: "attacked", reason, attackerId: attacker.onlineId, players: publicPlayers(), chat })}\n\n`);
      }
      chat.push({ id: "SYSTEM", country: "--", text: `${attacker.id}님이 ${target.id}님을 떨어뜨렸습니다.` });
      while (chat.length > 60) chat.shift();
      broadcast("state");
      sendJson(res, 200, { ok: true, kills: attacker.kills });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/stun") {
      const body = await readBody(req);
      const source = players.get(String(body.onlineId || ""));
      const targetId = String(body.targetId || "");
      const target = players.get(targetId);
      if (!source || !target) {
        sendJson(res, 404, { error: "unknown player" });
        return;
      }
      const ms = Math.max(500, Math.min(5000, Number(body.ms || 3000)));
      const reason = String(body.reason || "스턴").slice(0, 80);
      source.lastSeen = Date.now();
      const targetClient = clients.get(targetId);
      if (targetClient) {
        targetClient.write(`data: ${JSON.stringify({ type: "stunned", reason, ms, sourceId: source.onlineId, players: publicPlayers(), chat })}\n\n`);
      }
      chat.push({ id: "SYSTEM", country: "--", text: `${source.id}님의 ${reason}: ${target.id} 스턴` });
      while (chat.length > 60) chat.shift();
      broadcast("state");
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/events") {
      const onlineId = String(url.searchParams.get("id") || "");
      if (!players.has(onlineId)) {
        res.writeHead(404);
        res.end("unknown player");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*"
      });
      clients.set(onlineId, res);
      res.write(`data: ${JSON.stringify({ type: "state", players: publicPlayers(), chat })}\n\n`);
      req.on("close", () => {
        clients.delete(onlineId);
      });
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: "server error", detail: error.message });
  }
});

setInterval(() => {
  cleanup();
  broadcast("state");
}, 5000).unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Stair game online server: http://localhost:${PORT}`);
  console.log("같은 네트워크 밖 친구에게 공유하려면 Render/Railway/Fly.io 같은 Node 서버 배포 서비스를 사용하세요.");
  if (!fs.existsSync(INDEX)) console.warn("outputs/index.html 파일을 찾지 못했습니다.");
});
