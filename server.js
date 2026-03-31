const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const queues = {
  axis4: [],
  gomoku: [],
  quoridor: [],
  dab: []
};

const rooms = {};
const players = {};

const QUEUE_TTL_MS = 20 * 1000;
const MATCHED_NO_SSE_TTL_MS = 45 * 1000;
const ENDED_PLAYER_TTL_MS = 60 * 1000;

function uuid() {
  return crypto.randomUUID();
}

function now() {
  return Date.now();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendEvent(player, eventName, data) {
  const res = player && player.res;
  if (!res || res.writableEnded) return false;
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  return true;
}

function broadcast(roomId, eventName, data) {
  const room = rooms[roomId];
  if (!room) return;
  room.players.forEach((playerId) => {
    const player = players[playerId];
    if (player) sendEvent(player, eventName, data);
  });
}

function removeFromQueue(gameType, playerId) {
  if (!gameType || !queues[gameType]) return;
  queues[gameType] = queues[gameType].filter(entry => entry.playerId !== playerId);
}

function deletePlayer(playerId) {
  const player = players[playerId];
  if (!player) return;
  if (player.res && !player.res.writableEnded) {
    try { player.res.end(); } catch (_) {}
  }
  removeFromQueue(player.gameType, playerId);
  delete players[playerId];
}

function endRoom(roomId, reason, message) {
  const room = rooms[roomId];
  if (!room) return;
  room.players.forEach((pid) => {
    const player = players[pid];
    if (!player) return;
    player.roomId = null;
    player.playerIndex = null;
    player.status = 'ended';
    player.endedAt = now();
    if (player.res && !player.res.writableEnded) {
      sendEvent(player, 'end', {
        reason: reason || 'room_closed',
        message: message || '게임이 종료되었어.'
      });
      try { player.res.end(); } catch (_) {}
    }
  });
  delete rooms[roomId];
}

function cleanupPlayer(playerId, reason) {
  const player = players[playerId];
  if (!player) return;

  if (player.status === 'queued') {
    deletePlayer(playerId);
    return;
  }

  if (player.roomId && rooms[player.roomId]) {
    const roomId = player.roomId;
    const room = rooms[roomId];
    const otherId = room.players.find(pid => pid !== playerId);
    endRoom(roomId, reason || 'opponent_disconnected', '상대가 연결을 종료했어.');
    deletePlayer(playerId);
    const other = players[otherId];
    if (other && !other.res) deletePlayer(otherId);
    return;
  }

  deletePlayer(playerId);
}

function pruneStaleState() {
  const t = now();

  Object.keys(queues).forEach((gameType) => {
    queues[gameType] = queues[gameType].filter((entry) => {
      const player = players[entry.playerId];
      if (!player) return false;
      const stale = player.status === 'queued' && (t - player.joinedAt > QUEUE_TTL_MS);
      if (stale) {
        deletePlayer(entry.playerId);
        return false;
      }
      return true;
    });
  });

  Object.keys(players).forEach((playerId) => {
    const player = players[playerId];
    if (!player) return;

    if (player.status === 'matched' && !player.res && t - (player.matchedAt || t) > MATCHED_NO_SSE_TTL_MS) {
      if (player.roomId && rooms[player.roomId]) {
        endRoom(player.roomId, 'match_timeout', '매칭 후 연결이 완료되지 않아 방이 종료되었어.');
      }
      deletePlayer(playerId);
      return;
    }

    if (player.status === 'ended' && (!player.res || player.res.writableEnded) && t - (player.endedAt || t) > 1000) {
      deletePlayer(playerId);
      return;
    }
    if (player.status === 'ended' && t - (player.endedAt || t) > ENDED_PLAYER_TTL_MS) {
      deletePlayer(playerId);
    }
  });
}

setInterval(pruneStaleState, 5 * 1000).unref();

function maybeStartRoom(roomId) {
  const room = rooms[roomId];
  if (!room || room.startedAt) return;
  const everyoneConnected = room.players.every(pid => {
    const p = players[pid];
    return p && p.status === 'matched' && p.res && !p.res.writableEnded;
  });
  if (!everyoneConnected) return;

  room.startedAt = now();
  room.players.forEach((pid) => {
    const player = players[pid];
    if (!player) return;
    sendEvent(player, 'start', {
      roomId,
      playerIndex: player.playerIndex,
      gameType: room.gameType
    });
  });
}

async function handleJoin(req, res) {
  try {
    pruneStaleState();
    const body = await readJsonBody(req);
    const gameType = body.gameType;
    if (!gameType || !queues[gameType]) {
      return sendJson(res, 400, { error: 'invalid game type' });
    }

    const playerId = uuid();
    const player = {
      playerId,
      gameType,
      roomId: null,
      playerIndex: null,
      res: null,
      status: 'queued',
      joinedAt: now()
    };
    players[playerId] = player;

    const queue = queues[gameType];
    let matched = false;
    let roomId = null;
    let playerIndex = null;

    while (queue.length > 0) {
      const otherEntry = queue.shift();
      const otherPlayer = players[otherEntry.playerId];
      if (!otherPlayer || otherPlayer.status !== 'queued') continue;

      roomId = uuid();
      rooms[roomId] = {
        roomId,
        gameType,
        players: [otherPlayer.playerId, playerId],
        createdAt: now(),
        startedAt: 0
      };

      otherPlayer.roomId = roomId;
      otherPlayer.playerIndex = 0;
      otherPlayer.status = 'matched';
      otherPlayer.matchedAt = now();

      player.roomId = roomId;
      player.playerIndex = 1;
      player.status = 'matched';
      player.matchedAt = now();

      matched = true;
      playerIndex = 1;
      break;
    }

    if (!matched) {
      queue.push({ playerId });
    }

    return sendJson(res, 200, {
      playerId,
      matched,
      roomId: matched ? roomId : null,
      playerIndex: matched ? playerIndex : null
    });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: 'internal error' });
  }
}

function handleEvents(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const playerId = url.searchParams.get('playerId');
  const player = players[playerId];
  if (!playerId || !player) {
    res.writeHead(404);
    res.end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write('\n');

  player.res = res;
  sendEvent(player, 'hello', { playerId });

  if (player.roomId && rooms[player.roomId]) {
    maybeStartRoom(player.roomId);
  }

  req.on('close', () => {
    const current = players[playerId];
    if (!current || current.res !== res) return;
    current.res = null;
    cleanupPlayer(playerId, 'opponent_disconnected');
  });
}

function normalizeIncomingMove(move) {
  if (!move) return null;
  if (move.kind && Object.prototype.hasOwnProperty.call(move, 'payload')) return move;
  if (Object.prototype.hasOwnProperty.call(move, 'data')) {
    const payload = move.data;
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.kind && Object.prototype.hasOwnProperty.call(payload, 'payload')) {
      return payload;
    }
    return { kind: 'legacy', payload };
  }
  return { kind: 'legacy', payload: move };
}

async function handleMove(req, res) {
  try {
    const body = await readJsonBody(req);
    const { playerId, move } = body;
    const player = players[playerId];
    if (!player) return sendJson(res, 400, { error: 'invalid player' });

    const roomId = player.roomId;
    const room = roomId ? rooms[roomId] : null;
    if (!room) return sendJson(res, 400, { error: 'invalid room' });
    if (!room.startedAt || player.status !== 'matched') return sendJson(res, 409, { error: 'room not ready' });

    const normalized = normalizeIncomingMove(move);
    if (!normalized || !normalized.kind) return sendJson(res, 400, { error: 'invalid move' });

    const payload = {
      move: normalized,
      playerId,
      playerIndex: player.playerIndex,
      roomId,
      gameType: room.gameType,
      timestamp: now()
    };
    broadcast(roomId, 'move', payload);
    return sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: 'internal error' });
  }
}

async function handleChat(req, res) {
  try {
    const body = await readJsonBody(req);
    const { playerId, message } = body;
    const player = players[playerId];
    if (!player) return sendJson(res, 400, { error: 'invalid player' });

    const roomId = player.roomId;
    const room = roomId ? rooms[roomId] : null;
    if (!room) return sendJson(res, 400, { error: 'invalid room' });

    const cleanMessage = String(message || '').slice(0, 300).trim();
    if (!cleanMessage) return sendJson(res, 400, { error: 'empty message' });

    broadcast(roomId, 'chat', {
      roomId,
      message: cleanMessage,
      playerIndex: player.playerIndex,
      timestamp: now()
    });
    return sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: 'internal error' });
  }
}

async function handleLeave(req, res) {
  try {
    const body = await readJsonBody(req);
    const { playerId } = body;
    if (playerId && players[playerId]) cleanupPlayer(playerId, 'player_left');
    return sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: 'internal error' });
  }
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  const publicRoot = path.join(__dirname, 'public');
  const filePath = path.join(publicRoot, urlPath);
  if (!filePath.startsWith(publicRoot)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    };

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(500);
        res.end('Internal error');
        return;
      }
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/join') return void handleJoin(req, res);
  if (req.method === 'GET' && req.url.startsWith('/events')) return void handleEvents(req, res);
  if (req.method === 'POST' && req.url === '/move') return void handleMove(req, res);
  if (req.method === 'POST' && req.url === '/chat') return void handleChat(req, res);
  if (req.method === 'POST' && req.url === '/leave') return void handleLeave(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
