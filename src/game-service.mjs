import { randomBytes, randomUUID } from 'node:crypto';
import { TUNING } from '../public/game-config.js';

const SCENES = ['greenhouse', 'workshop', 'arcade', 'forest', 'field', 'retropc'];
const ROOM_PREFIX = 'rooms/';
const MAX_BODY = 16_000;
const MAX_CAS_ATTEMPTS = 12;
const ROOM_LIFETIME_MS = 12 * 60 * 60 * 1000;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

class GameError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function result(data, status = 200) {
  return { data, status };
}

function problem(status, message, retry = false) {
  return { error: message, status, retry };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
}

function errorResponse(status, message) {
  return jsonResponse({ error: message }, status);
}

function roomKey(code) {
  return `${ROOM_PREFIX}${code}`;
}

function roomCode() {
  return Array.from(randomBytes(5), (value) => CODE_CHARS[value % CODE_CHARS.length]).join('');
}

function cleanName(value) {
  const name = String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18);
  return name || 'Player';
}

function newPlayer(name, isHost = false) {
  return {
    id: randomUUID(),
    name: cleanName(name),
    score: 0,
    ready: false,
    isHost,
    connectedAt: Date.now(),
    found: false,
    foundAt: null,
    foundPlace: null,
    foundTimeRemainingSeconds: null,
    roundPoints: 0,
    lastGuessAt: 0,
    rematchOptIn: false,
    hasHidden: false,
  };
}

function allPlayersOptedIntoRematch(room) {
  return room.players.length > 0 && room.players.every((player) => player.rematchOptIn);
}

function resetRoomForRematch(room, now, preserveResults = false) {
  room.lastResults = preserveResults
    ? room.players.map(({ id, name, score }) => ({ id, name, score }))
    : null;
  room.status = 'lobby';
  room.hiderChangeNotice = null;
  room.singlePlayerNotice = null;
  room.roundIndex = 0;
  room.roundNumber = 0;
  room.roundCount = room.players.length;
  room.hiderId = null;
  room.sceneId = null;
  room.target = { x: 0.5, y: 0.5, size: 1, paint: [] };
  room.phaseStartedAt = now;
  room.deadline = null;
  room.hiderRoundScore = null;
  room.missCount = null;
  room.firstFinderAt = null;
  room.firstFinderId = null;
  room.roundColorAnalysis = null;
  room.roundScoreBreakdown = null;
  for (const player of room.players) {
    player.score = 0;
    player.ready = false;
    player.found = false;
    player.foundAt = null;
    player.foundPlace = null;
    player.foundTimeRemainingSeconds = null;
    player.roundPoints = 0;
    player.lastGuessAt = 0;
    player.rematchOptIn = false;
    player.hasHidden = false;
  }
}

function chooseScene(previous) {
  const options = SCENES.filter((scene) => scene !== previous);
  return options[Math.floor(Math.random() * options.length)];
}

function nextUnhiddenIndex(room, startIndex = 0) {
  return room.players.findIndex((player, index) => index >= startIndex && !player.hasHidden);
}

function createRound(room, index, now, preserveRoundNumber = false) {
  room.roundIndex = index;
  room.hiderId = room.players[index]?.id ?? null;
  if (!preserveRoundNumber) room.roundNumber += 1;
  if (room.players[index]) room.players[index].hasHidden = true;
  room.sceneId = chooseScene(room.previousScene);
  room.previousScene = room.sceneId;
  room.target = { x: 0.5, y: 0.5, size: 1, paint: [] };
  room.status = 'hiding';
  room.phaseStartedAt = now;
  room.deadline = now + TUNING.hideSeconds * 1000;
  room.firstFinderAt = null;
  room.firstFinderId = null;
  room.hiderRoundScore = null;
  room.missCount = null;
  room.roundColorAnalysis = null;
  room.roundScoreBreakdown = null;
  for (const player of room.players) {
    player.found = false;
    player.foundAt = null;
    player.foundPlace = null;
    player.foundTimeRemainingSeconds = null;
    player.roundPoints = 0;
    player.lastGuessAt = 0;
  }
}

function paintThresholdForSize(size) {
  const sizes = TUNING.mimiSizes || [];
  if (!sizes.length) return 0;
  let closest = sizes[0];
  for (const candidate of sizes.slice(1)) {
    if (Math.abs(candidate.scale - size) < Math.abs(closest.scale - size)) closest = candidate;
  }
  return Number(closest.paintThreshold) || 0;
}

function srgbToLinear(value) {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function hexToLab(hex) {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  const r = srgbToLinear(red);
  const g = srgbToLinear(green);
  const b = srgbToLinear(blue);
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
  const z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883;
  const pivot = (value) => value > 0.008856451679 ? Math.cbrt(value) : 7.787037037 * value + 16 / 116;
  const fx = pivot(x);
  const fy = pivot(y);
  const fz = pivot(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function colorDistanceBreakdown(colors) {
  if (colors.length < 2) return [];
  const labColors = colors.map((color) => ({ color, lab: hexToLab(color) }));
  const distance = (left, right) => Math.min(20, Math.hypot(
    left.lab[0] - right.lab[0], left.lab[1] - right.lab[1], left.lab[2] - right.lab[2],
  ));
  if (labColors.length === 2) {
    return [{ color: labColors[0].color, nearestColor: labColors[1].color, deltaE: distance(labColors[0], labColors[1]) }];
  }
  return labColors.map((color, index) => {
    let nearest = null;
    let minimum = Infinity;
    for (let otherIndex = 0; otherIndex < labColors.length; otherIndex += 1) {
      if (otherIndex === index) continue;
      const candidate = distance(color, labColors[otherIndex]);
      if (candidate < minimum) {
        nearest = labColors[otherIndex];
        minimum = candidate;
      }
    }
    return { color: color.color, nearestColor: nearest.color, deltaE: minimum };
  });
}

function parseColorAnalysis(input) {
  if (!input || !Array.isArray(input.colors) || input.colors.length > TUNING.paintMaxStrokes + 3) return null;
  const colors = [];
  const seen = new Set();
  for (const entry of input.colors) {
    const color = String(entry?.color || '').toLowerCase();
    const percentage = Number(entry?.percentage);
    if (!/^#[0-9a-f]{6}$/.test(color) || !Number.isFinite(percentage) || percentage < 0 || percentage > 100 || seen.has(color)) return null;
    seen.add(color);
    colors.push({ color, percentage });
  }
  return { colors };
}

function closeSearch(room, now) {
  if (room.status !== 'searching') return;
  const seekers = room.players.filter((player) => player.id !== room.hiderId);
  const misses = seekers.filter((player) => !player.found).length;
  const hider = room.players.find((player) => player.id === room.hiderId);
  const seekerTimes = seekers.map((player) => ({
    playerId: player.id,
    seconds: player.found
      ? Math.min(TUNING.searchSeconds, Math.max(0, Number(player.foundAt) || 0))
      : TUNING.searchSeconds,
  }));
  const averageSeekerSeconds = seekerTimes.length
    ? seekerTimes.reduce((sum, entry) => sum + entry.seconds, 0) / seekerTimes.length
    : 0;
  const threshold = paintThresholdForSize(room.target.size) * 100;
  const meaningfulColors = [...new Set((room.roundColorAnalysis?.colors || [])
    .filter((entry) => entry.percentage >= threshold)
    .map((entry) => entry.color.toLowerCase()))];
  const colorDistances = colorDistanceBreakdown(meaningfulColors);
  const colorScore = colorDistances.reduce((sum, entry) => sum + entry.deltaE, 0);
  const baseScore = averageSeekerSeconds + colorScore;
  const repeatCount = misses + 1;
  const sizeOption = TUNING.mimiSizes.find((entry) => entry.scale === room.target.size) || TUNING.mimiSizes[1];
  const hiderPoints = Math.round(baseScore * repeatCount * sizeOption.hiderMultiplier);
  if (hider) {
    hider.score += hiderPoints;
    hider.roundPoints += hiderPoints;
  }
  const seekerBreakdown = seekers.map((player) => ({
    playerId: player.id,
    found: player.found,
    place: player.foundPlace,
    timeSpentSeconds: seekerTimes.find((entry) => entry.playerId === player.id)?.seconds ?? TUNING.searchSeconds,
    placePoints: player.foundPlace ? TUNING.seekerPlacePoints[player.foundPlace - 1] || 0 : 0,
    timeRemainingSeconds: player.foundTimeRemainingSeconds || 0,
    points: player.roundPoints,
  }));
  room.hiderRoundScore = hiderPoints;
  room.missCount = misses;
  room.roundScoreBreakdown = {
    hiderId: hider?.id || null,
    averageSeekerSeconds,
    seekerTimes,
    colors: meaningfulColors,
    colorDistances,
    colorScore,
    baseScore,
    missCount: misses,
    repeatCount,
    sizeLabel: sizeOption.label,
    sizeMultiplier: sizeOption.hiderMultiplier,
    points: hiderPoints,
    seekers: seekerBreakdown,
  };
  room.status = 'reveal';
  room.phaseStartedAt = now;
  room.deadline = now + TUNING.revealSeconds * 1000;
}

function finishGame(room, now) {
  room.lastResults = room.players.map(({ id, name, score }) => ({ id, name, score }));
  room.status = 'finished';
  room.phaseStartedAt = now;
  room.deadline = null;
  for (const player of room.players) player.rematchOptIn = false;
}

function advanceRoom(room, now) {
  if (room.status === 'hiding' && now >= room.deadline) {
    room.status = 'searching';
    room.phaseStartedAt = now;
    room.deadline = now + TUNING.searchSeconds * 1000;
  } else if (room.status === 'searching') {
    const seekers = room.players.filter((player) => player.id !== room.hiderId);
    if ((seekers.length > 0 && seekers.every((player) => player.found)) || now >= room.deadline) closeSearch(room, now);
  } else if (room.status === 'reveal' && now >= room.deadline) {
    const nextHider = nextUnhiddenIndex(room, room.roundIndex + 1);
    if (nextHider < 0) finishGame(room, now);
    else createRound(room, nextHider, now);
  }
}

function publicState(room, playerId, now) {
  const self = room.players.find((player) => player.id === playerId);
  if (!self) return null;
  const hiderId = room.hiderId;
  const maySeeTarget = room.status === 'searching' || room.status === 'reveal' || room.status === 'finished' ||
    (room.status === 'hiding' && playerId === hiderId);
  return {
    code: room.code,
    visibility: room.visibility,
    status: room.status,
    sceneId: room.sceneId,
    targetRef: 'mimi',
    target: maySeeTarget ? room.target : null,
    currentPlayerId: playerId,
    hostId: room.hostId,
    hiderId,
    roundNumber: room.roundNumber,
    roundCount: room.roundCount,
    deadline: room.deadline,
    phaseStartedAt: room.phaseStartedAt,
    hideSeconds: TUNING.hideSeconds,
    searchSeconds: TUNING.searchSeconds,
    revealSeconds: TUNING.revealSeconds,
    missCooldownMs: TUNING.missCooldownMs,
    firstFinderId: room.firstFinderId,
    firstFinderAt: room.firstFinderAt,
    hiderRoundScore: room.hiderRoundScore ?? null,
    missCount: room.missCount ?? null,
    roundScoreBreakdown: ['reveal', 'finished'].includes(room.status) ? room.roundScoreBreakdown ?? null : null,
    lastResults: room.lastResults?.map((entry) => ({ ...entry, isSelf: entry.id === playerId })) || null,
    hiderChangeNotice: room.hiderChangeNotice?.playerId === playerId ? room.hiderChangeNotice : null,
    singlePlayerNotice: room.singlePlayerNotice?.playerId === playerId ? room.singlePlayerNotice : null,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      ready: player.ready,
      isHost: player.isHost,
      isHider: player.id === hiderId,
      found: player.found,
      foundAt: player.foundAt,
      rematchOptIn: Boolean(player.rematchOptIn),
      isSelf: player.id === playerId,
    })),
    self: {
      found: self.found,
      isHider: playerId === hiderId,
      rematchOptIn: Boolean(self.rematchOptIn),
      cooldownUntil: self.lastGuessAt ? self.lastGuessAt + TUNING.missCooldownMs : 0,
    },
    mimiSizes: TUNING.mimiSizes,
    now,
  };
}

function createRoom(name, visibility, now) {
  const player = newPlayer(name, true);
  const code = roomCode();
  const room = {
    code,
    visibility,
    status: 'lobby',
    players: [player],
    hostId: player.id,
    roundIndex: 0,
    roundNumber: 0,
    roundCount: 1,
    sceneId: null,
    previousScene: null,
    target: { x: 0.5, y: 0.5, size: 1, paint: [] },
    phaseStartedAt: now,
    deadline: null,
    hiderRoundScore: null,
    missCount: null,
    roundColorAnalysis: null,
    roundScoreBreakdown: null,
    createdAt: now,
    hiderChangeNotice: null,
    singlePlayerNotice: null,
    lastResults: null,
  };
  return { room, player };
}

async function readRoom(store, code) {
  const entry = await store.getWithMetadata(roomKey(code), { consistency: 'strong', type: 'json' });
  if (!entry || !entry.data) return null;
  return { room: entry.data, etag: entry.etag };
}

async function writeRoom(store, code, room, etag) {
  const expiresAt = room.createdAt + ROOM_LIFETIME_MS;
  const write = await store.setJSON(roomKey(code), room, {
    onlyIfMatch: etag,
    metadata: { expiresAt },
  });
  // Some Blobs client releases can report modified=true without an ETag for
  // non-412 service errors. Never treat that ambiguous result as a saved write.
  if (write.modified && !write.etag) throw new GameError(503, 'Room storage did not confirm the save. Please try again.');
  return Boolean(write.modified);
}

async function mutateRoom(store, code, operation, now = Date.now()) {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await readRoom(store, code);
    if (!current) return problem(404, 'That room is no longer available.');
    if (current.room.closedAt || now - current.room.createdAt > ROOM_LIFETIME_MS) {
      if (!current.room.closedAt) await store.delete(roomKey(code));
      return problem(404, 'That room is no longer available.');
    }

    const room = structuredClone(current.room);
    let outcome;
    try {
      outcome = await operation(room, now);
    } catch (error) {
      outcome = problem(error instanceof GameError ? error.status : 400,
        error?.message || 'The game ran into a hiccup.');
    }

    const changed = JSON.stringify(room) !== JSON.stringify(current.room);
    if (!changed) return outcome;

    if (await writeRoom(store, code, room, current.etag)) return outcome;
  }
  return problem(409, 'The room changed at the same time. Please try again.');
}

async function createStoredRoom(store, name, visibility, now) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { room, player } = createRoom(name, visibility, now);
    const write = await store.setJSON(roomKey(room.code), room, {
      onlyIfNew: true,
      metadata: { expiresAt: room.createdAt + ROOM_LIFETIME_MS },
    });
    if (write.modified && write.etag) {
      return result({ code: room.code, playerId: player.id, state: publicState(room, player.id, now) }, 201);
    }
    if (write.modified && !write.etag) throw new GameError(503, 'Room storage did not confirm the save. Please try again.');
  }
  throw new GameError(503, 'A room could not be created just now. Please try again.');
}

async function publicRoomCandidates(store, now) {
  const { blobs } = await store.list({ prefix: ROOM_PREFIX });
  const candidates = [];
  for (const entry of blobs) {
    const code = entry.key.slice(ROOM_PREFIX.length);
    const saved = await readRoom(store, code);
    if (!saved) continue;
    const room = saved.room;
    if (room.closedAt || now - room.createdAt > ROOM_LIFETIME_MS) {
      await store.delete(roomKey(code));
      continue;
    }
    if (room.visibility === 'public' && room.status === 'lobby' && room.players.length < TUNING.playersMax) candidates.push(room);
  }
  return candidates.sort((left, right) => left.createdAt - right.createdAt);
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new GameError(413, 'Request is too large.');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new GameError(400, 'Please send valid game data.');
  }
}

function findRoomPlayer(room, playerId) {
  return room.players.find((player) => player.id === playerId);
}

async function joinPublicRoom(store, name, now) {
  const player = newPlayer(name, false);
  const candidates = await publicRoomCandidates(store, now);
  for (const candidate of candidates) {
    const joined = await mutateRoom(store, candidate.code, (room) => {
      advanceRoom(room, now);
      if (room.visibility !== 'public' || room.status !== 'lobby' || room.players.length >= TUNING.playersMax) {
        return problem(409, 'That public room is full. Try another.', true);
      }
      room.players.push(player);
      room.roundCount += 1;
      return result({ code: room.code, playerId: player.id, state: publicState(room, player.id, now) }, 201);
    }, now);
    if (!joined.retry) return joined;
  }
  return createStoredRoom(store, name, 'public', now);
}

function setPlayerAsHost(room, player) {
  room.hostId = player.id;
  for (const member of room.players) {
    member.isHost = member.id === room.hostId;
    if (member.isHost) member.ready = true;
  }
}

function leaveRoom(room, player, now) {
  const leavingIndex = room.players.findIndex((member) => member.id === player.id);
  const leaveStatus = room.status;
  const wasCurrentHider = player.id === room.hiderId;
  const wasFutureHider = leaveStatus !== 'lobby' && !player.hasHidden;
  room.players.splice(leavingIndex, 1);

  if (!room.players.length) {
    room.status = 'closed';
    room.closedAt = now;
    room.hostId = null;
    return;
  }
  if (room.players.length === 1 && leaveStatus !== 'lobby') {
    const remainingPlayer = room.players[0];
    resetRoomForRematch(room, now);
    setPlayerAsHost(room, remainingPlayer);
    room.singlePlayerNotice = { id: randomUUID(), playerId: remainingPlayer.id };
    return;
  }
  if (player.id === room.hostId) setPlayerAsHost(room, room.players[0]);

  if (leaveStatus === 'lobby') {
    room.roundCount = Math.max(0, room.roundCount - 1);
    room.roundIndex = 0;
  } else if (leaveStatus === 'hiding' && wasCurrentHider) {
    room.roundCount = Math.max(0, room.roundCount - 1);
    const nextHider = nextUnhiddenIndex(room, Math.max(0, leavingIndex));
    if (nextHider < 0) resetRoomForRematch(room, now);
    else {
      createRound(room, nextHider, now, true);
      room.hiderChangeNotice = {
        id: randomUUID(),
        playerId: room.players[nextHider].id,
        departedName: player.name,
      };
    }
  } else if (leaveStatus === 'hiding') {
    if (!player.hasHidden) room.roundCount = Math.max(0, room.roundCount - 1);
    if (leavingIndex < room.roundIndex) room.roundIndex -= 1;
  } else if (leaveStatus === 'searching' || leaveStatus === 'reveal') {
    if (wasFutureHider) room.roundCount = Math.max(0, room.roundCount - 1);
    if (leavingIndex < room.roundIndex) room.roundIndex -= 1;
    if (wasCurrentHider) room.hiderId = null;
    if (leaveStatus === 'searching') {
      const seekers = room.players.filter((member) => member.id !== room.hiderId);
      if (!seekers.length || seekers.every((member) => member.found)) closeSearch(room, now);
    }
  }
  if (leaveStatus === 'finished' && allPlayersOptedIntoRematch(room)) resetRoomForRematch(room, now);
}

async function mutateRoomAction(store, code, body, now) {
  return mutateRoom(store, code, (room) => {
    advanceRoom(room, now);
    const player = findRoomPlayer(room, body.playerId);
    if (!player) return problem(403, 'This device is not in that room.');

    switch (body.type) {
      case 'ready': {
        if (room.status !== 'lobby') return problem(409, 'The game has already started.');
        player.ready = Boolean(body.value);
        break;
      }
      case 'set-visibility': {
        if (room.status !== 'lobby') return problem(409, 'Room visibility can only change before the game starts.');
        if (player.id !== room.hostId) return problem(403, 'Only the host can change room visibility.');
        if (!['public', 'private'].includes(body.visibility)) return problem(400, 'Choose public or private visibility.');
        room.visibility = body.visibility;
        break;
      }
      case 'leave': {
        leaveRoom(room, player, now);
        return result({ left: true });
      }
      case 'kick-player': {
        if (room.status !== 'lobby') return problem(409, 'Players can only be removed before the game starts.');
        if (player.id !== room.hostId) return problem(403, 'Only the host can remove players.');
        const targetId = String(body.targetPlayerId || '');
        const targetIndex = room.players.findIndex((member) => member.id === targetId);
        if (targetIndex < 0) return problem(404, 'That player is no longer in the room.');
        if (targetId === player.id) return problem(400, 'The host cannot remove themselves.');
        room.players.splice(targetIndex, 1);
        room.roundCount = Math.max(0, room.roundCount - 1);
        break;
      }
      case 'play-again': {
        if (room.status !== 'finished') return problem(409, 'This game is still in progress.');
        player.rematchOptIn = !player.rematchOptIn;
        if (allPlayersOptedIntoRematch(room)) resetRoomForRematch(room, now);
        break;
      }
      case 'return-to-lobby': {
        if (room.status !== 'finished') return problem(409, 'This game is still in progress.');
        resetRoomForRematch(room, now);
        break;
      }
      case 'start': {
        if (room.status !== 'lobby') return problem(409, 'The game has already started.');
        if (player.id !== room.hostId) return problem(403, 'Only the host can start the game.');
        if (room.players.length < TUNING.playersMin) return problem(409, 'Invite one more player to start.');
        if (!room.players.every((member) => member.ready)) return problem(409, 'Everyone needs to be ready first.');
        room.lastResults = null;
        createRound(room, 0, now);
        break;
      }
      case 'move-target': {
        if (room.status !== 'hiding' || player.id !== room.players[room.roundIndex]?.id) return problem(403, 'Only the current hider can place the target.');
        const x = Number(body.x);
        const y = Number(body.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return problem(400, 'That placement was not valid.');
        room.target.x = Math.min(TUNING.placementMaxX, Math.max(TUNING.placementMinX, x));
        room.target.y = Math.min(TUNING.placementMaxY, Math.max(TUNING.placementMinY, y));
        break;
      }
      case 'resize-target': {
        if (room.status !== 'hiding' || player.id !== room.players[room.roundIndex]?.id) return problem(403, 'Only the current hider can resize the target.');
        const size = TUNING.mimiSizes.find((item) => item.scale === Number(body.size));
        if (!size) return problem(400, 'Choose one of the available target sizes.');
        room.target.size = size.scale;
        break;
      }
      case 'paint-stroke': {
        if (room.status !== 'hiding' || player.id !== room.players[room.roundIndex]?.id) return problem(403, 'Only the current hider can paint Mimi.');
        const color = String(body.color || '');
        const width = Number(body.width);
        const points = body.points;
        const erase = body.erase === true;
        if (!/^#[0-9a-f]{6}$/i.test(color) || !TUNING.paintBrushSizes.includes(width) ||
            !Array.isArray(points) || points.length < 1 || points.length > TUNING.paintMaxPoints) return problem(400, 'That brush stroke was not valid.');
        const cleanPoints = [];
        for (const point of points) {
          const x = Number(point?.x);
          const y = Number(point?.y);
          if (!Number.isFinite(x) || !Number.isFinite(y) || x < -30 || x > 30 || y < -47 || y > 32) return problem(400, 'Keep paint on Mimi.');
          cleanPoints.push({ x, y });
        }
        room.target.paint ??= [];
        if (room.target.paint.length >= TUNING.paintMaxStrokes) return problem(409, 'Mimi is covered in paint. Undo a stroke to add another.');
        room.target.paint.push({ color, width, erase, points: cleanPoints });
        break;
      }
      case 'undo-paint': {
        if (room.status !== 'hiding' || player.id !== room.players[room.roundIndex]?.id) return problem(403, 'Only the current hider can change Mimi’s paint.');
        room.target.paint?.pop();
        break;
      }
      case 'clear-paint': {
        if (room.status !== 'hiding' || player.id !== room.players[room.roundIndex]?.id) return problem(403, 'Only the current hider can change Mimi’s paint.');
        room.target.paint = [];
        break;
      }
      case 'lock-in': {
        if (room.status !== 'hiding' || player.id !== room.players[room.roundIndex]?.id) return problem(403, 'Only the current hider can start the search.');
        const colorAnalysis = body.colorAnalysis === undefined ? null : parseColorAnalysis(body.colorAnalysis);
        if (body.colorAnalysis !== undefined && !colorAnalysis) return problem(400, 'Mimi’s color analysis was not valid.');
        room.roundColorAnalysis = colorAnalysis;
        room.status = 'searching';
        room.phaseStartedAt = now;
        room.deadline = now + TUNING.searchSeconds * 1000;
        break;
      }
      case 'update-color-analysis': {
        if (room.status !== 'searching' || player.id !== room.players[room.roundIndex]?.id) return problem(403, 'Only the hider can save Mimi’s color analysis.');
        const colorAnalysis = parseColorAnalysis(body.colorAnalysis);
        if (!colorAnalysis) return problem(400, 'Mimi’s color analysis was not valid.');
        room.roundColorAnalysis = colorAnalysis;
        break;
      }
      case 'guess': {
        if (room.status !== 'searching' || player.id === room.hiderId || player.found) return problem(409, 'You cannot search right now.');
        if (player.lastGuessAt && now < player.lastGuessAt + TUNING.missCooldownMs) return problem(429, 'Take a breath, then try another spot.');
        const x = Number(body.x);
        const y = Number(body.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return problem(400, 'That guess was outside the scene.');
        player.lastGuessAt = now;
        const dx = x - room.target.x;
        const dy = y - room.target.y;
        const rx = TUNING.hitRadiusX * room.target.size + TUNING.hitPaddingX;
        const ry = TUNING.hitRadiusY * room.target.size + TUNING.hitPaddingY;
        const hit = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
        if (!hit) return result({ hit: false, cooldownUntil: player.lastGuessAt + TUNING.missCooldownMs });
        const elapsed = Math.min(TUNING.searchSeconds, Math.max(0, (now - room.phaseStartedAt) / 1000));
        const first = room.firstFinderId === null;
        const place = room.players.filter((member) => member.id !== room.hiderId && member.found).length + 1;
        const placePoints = TUNING.seekerPlacePoints[place - 1] || 0;
        const timeRemainingSeconds = Math.max(0, Math.ceil(TUNING.searchSeconds - elapsed));
        const points = placePoints + timeRemainingSeconds;
        player.found = true;
        player.foundAt = elapsed;
        player.foundPlace = place;
        player.foundTimeRemainingSeconds = timeRemainingSeconds;
        player.roundPoints += points;
        player.score += points;
        if (first) {
          room.firstFinderId = player.id;
          room.firstFinderAt = elapsed;
        }
        if (room.players.filter((member) => member.id !== room.hiderId).every((member) => member.found)) closeSearch(room, now);
        return result({ hit: true, first, points, state: publicState(room, player.id, now) });
      }
      default:
        return problem(400, 'That game action is not recognized.');
    }

    return result(publicState(room, player.id, now));
  }, now);
}

export async function handleGameRequest(request, store) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  } });

  const now = Date.now();
  try {
    const url = new URL(request.url);
    if (request.method === 'GET') {
      const code = String(url.searchParams.get('room') || '').toUpperCase();
      const playerId = url.searchParams.get('playerId');
      if (!/^[A-Z0-9]{5}$/.test(code) || !playerId) return errorResponse(400, 'A valid room and player are required.');
      const outcome = await mutateRoom(store, code, (room) => {
        advanceRoom(room, now);
        const state = publicState(room, playerId, now);
        return state ? result(state) : problem(403, 'This device is not in that room.');
      }, now);
      return outcome.error ? errorResponse(outcome.status, outcome.error) : jsonResponse(outcome.data, outcome.status);
    }

    if (request.method !== 'POST') return errorResponse(405, 'Use GET or POST for this game endpoint.');
    let body;
    try {
      body = await readBody(request);
    } catch (error) {
      return errorResponse(error.status || 400, error.message);
    }

    let outcome;
    if (body.type === 'create-room') {
      outcome = await createStoredRoom(store, body.name, 'private', now);
    } else if (body.type === 'join-public') {
      outcome = await joinPublicRoom(store, body.name, now);
    } else if (body.type === 'join-room') {
      const code = String(body.code || '').toUpperCase();
      if (!/^[A-Z0-9]{5}$/.test(code)) return errorResponse(400, 'A room code has five letters or numbers.');
      const player = newPlayer(body.name, false);
      outcome = await mutateRoom(store, code, (room) => {
        advanceRoom(room, now);
        if (room.status !== 'lobby') return problem(409, 'This game has already started.');
        if (room.players.length >= TUNING.playersMax) return problem(409, 'This room is full.');
        room.players.push(player);
        room.roundCount += 1;
        return result({ code, playerId: player.id, state: publicState(room, player.id, now) }, 201);
      }, now);
    } else {
      const code = String(body.code || '').toUpperCase();
      if (!/^[A-Z0-9]{5}$/.test(code) || !body.playerId) return errorResponse(400, 'A valid room and player are required.');
      outcome = await mutateRoomAction(store, code, body, now);
    }

    if (outcome.error) return errorResponse(outcome.status, outcome.error);
    return jsonResponse(outcome.data, outcome.status);
  } catch (error) {
    console.error('MIMIC function error', error);
    const status = error instanceof GameError ? error.status : 503;
    return errorResponse(status, error?.message || 'The game ran into a hiccup. Please try again.');
  }
}

export { ROOM_PREFIX, ROOM_LIFETIME_MS };
