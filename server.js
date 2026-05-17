const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

// ═══════════════════════════════════════
//  IN-MEMORY GAME ROOMS
// ═══════════════════════════════════════
const rooms = {}; // code -> Room

const ROLES = {
  mafia:    { emoji:"🔪", label:"Mafija",    color:"#c0392b", desc:"Ti si ubica. U svakoj rundi biraš koga ćeš da ubiješ i tokom igre moraš da se odbraniš da to nisi ti." },
  doctor:   { emoji:"💊", label:"Lekar",     color:"#27ae60", desc:"Ti spasavaš ljude. U svakoj rundi moraš da izabereš nekog koga ćeš da sačuvaš od ubistava." },
  police:   { emoji:"🔍", label:"Policajac", color:"#2980b9", desc:"Ti proveravaš ko je ubica. U svakoj rundi klikneš na ime nekog igrača i saznaš da li je mafija ili ne." },
  joker:    { emoji:"🃏", label:"Džoker",    color:"#8e44ad", desc:"Ti možeš da ućutkuješ ljude. U svakoj rundi možeš da izabereš koga ćeš da ućutkaš i ta osoba ne može da priča celu tu rundu." },
  civilian: { emoji:"👤", label:"Građanin",  color:"#7f8c8d", desc:"Ti si običan građanin. Nemaš posebne moći, ali tvoj glas na glasanju može biti presudan." },
};

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

function assignRoles(players, includeJoker) {
  const roles = ["mafia","doctor","police"];
  if (includeJoker) roles.push("joker");
  while (roles.length < players.length) roles.push("civilian");
  const shuffled = shuffle(roles);
  return players.map((p, i) => ({ ...p, role: shuffled[i], alive: true, silenced: false }));
}

function createRoom(hostWs, hostName, includeJoker) {
  let code = makeCode();
  while (rooms[code]) code = makeCode();

  const room = {
    code,
    phase: "lobby",      // lobby | night | dawn | voting | gameover
    players: [],         // [{id, name, role, alive, silenced, ws}]
    hostId: null,
    includeJoker,
    round: 1,
    nightActions: {},    // {mafia, doctor, police, joker} -> playerId
    nightOrder: [],      // roles to act this night
    nightIdx: 0,         // which role is currently acting
    votes: {},           // voterId -> targetId
    votersLeft: [],      // ids yet to vote
    dawnResult: null,
  };

  const playerId = addPlayer(room, hostWs, hostName);
  room.hostId = playerId;
  rooms[code] = room;
  return { room, playerId };
}

function addPlayer(room, ws, name) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const player = { id, name, role: null, alive: true, silenced: false, ws };
  room.players.push(player);
  ws.playerId = id;
  ws.roomCode = room.code;
  return id;
}

// Send to one ws
function send(ws, type, data = {}) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

// Broadcast to all alive+dead players in room (public info)
function broadcast(room, type, data = {}) {
  room.players.forEach(p => send(p.ws, type, data));
}

// Send lobby state to all
function broadcastLobby(room) {
  broadcast(room, "lobby_update", {
    players: room.players.map(p => ({ id: p.id, name: p.name })),
    hostId: room.hostId,
    includeJoker: room.includeJoker,
    code: room.code,
  });
}

// Send each player their own role privately
function sendRoles(room) {
  room.players.forEach(p => {
    send(p.ws, "your_role", {
      role: p.role,
      roleInfo: ROLES[p.role],
    });
  });
}

// Public player list (no roles)
function publicPlayers(room) {
  return room.players.map(p => ({ id: p.id, name: p.name, alive: p.alive, silenced: p.silenced }));
}

function startGame(room) {
  room.players = assignRoles(room.players, room.includeJoker);
  room.phase = "night";
  room.round = 1;

  // Tell everyone game started + their role
  broadcast(room, "game_started", { players: publicPlayers(room) });
  sendRoles(room);

  startNight(room);
}

function buildNightOrder(room) {
  const order = [];
  const alive = room.players.filter(p => p.alive);
  if (alive.some(p => p.role === "mafia"))   order.push("mafia");
  if (alive.some(p => p.role === "doctor"))  order.push("doctor");
  if (alive.some(p => p.role === "police"))  order.push("police");
  if (alive.some(p => p.role === "joker"))   order.push("joker");
  return order;
}

function startNight(room) {
  room.phase = "night";
  room.nightActions = {};
  room.nightOrder = buildNightOrder(room);
  room.nightIdx = 0;

  broadcast(room, "night_started", { round: room.round });
  promptNightRole(room);
}

function promptNightRole(room) {
  if (room.nightIdx >= room.nightOrder.length) {
    // All roles done — process dawn
    processDawn(room);
    return;
  }

  const currentRole = room.nightOrder[room.nightIdx];
  const actingPlayers = room.players.filter(p => p.role === currentRole && p.alive);
  const alive = room.players.filter(p => p.alive);

  // Tell everyone who is acting (no sensitive info)
  broadcast(room, "night_role_prompt", {
    role: currentRole,
    roleLabel: ROLES[currentRole].label,
    roleEmoji: ROLES[currentRole].emoji,
    roleColor: ROLES[currentRole].color,
  });

  // Tell the acting player(s) to pick
  const targets = alive.filter(p => {
    if (currentRole === "mafia") return p.role !== "mafia";
    return !actingPlayers.some(a => a.id === p.id);
  }).map(p => ({ id: p.id, name: p.name }));

  actingPlayers.forEach(p => {
    send(p.ws, "your_turn", {
      role: currentRole,
      targets,
      isPolice: currentRole === "police",
    });
  });
}

function processDawn(room) {
  const { mafia, doctor, police, joker } = room.nightActions;

  const mafiaTarget = mafia ? room.players.find(p => p.id === mafia) : null;
  const doctorTarget = doctor ? room.players.find(p => p.id === doctor) : null;
  const jokerTarget = joker ? room.players.find(p => p.id === joker) : null;

  const killed = mafiaTarget && (!doctorTarget || doctorTarget.id !== mafiaTarget.id) ? mafiaTarget : null;
  const savedAttempt = mafiaTarget && doctorTarget && doctorTarget.id === mafiaTarget.id;

  // Joker takeover?
  const killedIsMafia = killed && killed.role === "mafia";
  const livingJoker = killedIsMafia
    ? room.players.find(p => p.role === "joker" && p.alive && p.id !== killed.id)
    : null;

  // Apply changes
  room.players = room.players.map(p => {
    if (killed && p.id === killed.id) return { ...p, alive: false };
    if (livingJoker && p.id === livingJoker.id) return { ...p, role: "mafia", silenced: false };
    if (jokerTarget && p.id === jokerTarget.id) return { ...p, silenced: true };
    return { ...p, silenced: false };
  });

  room.phase = "dawn";

  broadcast(room, "dawn", {
    killed: killed ? { id: killed.id, name: killed.name } : null,
    savedAttempt,
    silenced: jokerTarget ? { id: jokerTarget.id, name: jokerTarget.name } : null,
    jokerTakeover: livingJoker ? { id: livingJoker.id, name: livingJoker.name } : null,
    players: publicPlayers(room),
    round: room.round,
  });
}

function startVoting(room) {
  room.phase = "voting";
  room.votes = {};
  room.votersLeft = room.players.filter(p => p.alive).map(p => p.id);

  broadcast(room, "voting_started", {
    players: publicPlayers(room),
  });

  promptNextVoter(room);
}

function promptNextVoter(room) {
  if (room.votersLeft.length === 0) {
    processVoteResult(room);
    return;
  }

  const voterId = room.votersLeft[0];
  const voter = room.players.find(p => p.id === voterId);
  const alive = room.players.filter(p => p.alive);

  broadcast(room, "voting_turn", {
    voterId,
    voterName: voter.name,
    remaining: room.votersLeft.length,
    total: room.players.filter(p => p.alive).length,
  });

  send(voter.ws, "your_vote_turn", {
    targets: alive.filter(p => p.id !== voterId).map(p => ({ id: p.id, name: p.name })),
  });
}

function processVoteResult(room) {
  const tally = {};
  Object.values(room.votes).forEach(tid => { tally[tid] = (tally[tid] || 0) + 1; });

  const alive = room.players.filter(p => p.alive);
  const max = Math.max(...Object.values(tally));
  const topIds = Object.keys(tally).filter(id => tally[id] === max);
  const isTie = topIds.length > 1;

  const tallyPublic = alive.map(p => ({ id: p.id, name: p.name, votes: tally[p.id] || 0 }));

  if (isTie) {
    broadcast(room, "vote_result", { tie: true, tally: tallyPublic });
    return;
  }

  const eliminated = room.players.find(p => p.id === topIds[0]);
  const isMafia = eliminated.role === "mafia";
  const livingJokerAfter = isMafia
    ? room.players.find(p => p.role === "joker" && p.alive && p.id !== eliminated.id)
    : null;

  room.players = room.players.map(p => p.id === eliminated.id ? { ...p, alive: false } : p);

  if (isMafia && livingJokerAfter) {
    room.players = room.players.map(p => p.id === livingJokerAfter.id ? { ...p, role: "mafia" } : p);
  }

  broadcast(room, "vote_result", {
    tie: false,
    tally: tallyPublic,
    eliminated: { id: eliminated.id, name: eliminated.name, role: eliminated.role, roleLabel: ROLES[eliminated.role].label, roleEmoji: ROLES[eliminated.role].emoji },
    isMafia,
    jokerTakeover: livingJokerAfter ? { id: livingJokerAfter.id, name: livingJokerAfter.name } : null,
    cityWins: isMafia && !livingJokerAfter,
    players: publicPlayers(room),
  });

  if (isMafia && !livingJokerAfter) {
    room.phase = "gameover";
  }
}

// ═══════════════════════════════════════
//  WEBSOCKET HANDLER
// ═══════════════════════════════════════
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { type } = msg;

    // ── CREATE ROOM ──
    if (type === "create_room") {
      const { name, includeJoker } = msg;
      const { room, playerId } = createRoom(ws, name, includeJoker || false);
      send(ws, "room_created", { code: room.code, playerId, isHost: true });
      broadcastLobby(room);
      return;
    }

    // ── JOIN ROOM ──
    if (type === "join_room") {
      const { code, name } = msg;
      const room = rooms[code.toUpperCase()];
      if (!room) { send(ws, "error", { message: "Soba ne postoji. Proveri kod." }); return; }
      if (room.phase !== "lobby") { send(ws, "error", { message: "Igra je već počela." }); return; }
      if (room.players.length >= 12) { send(ws, "error", { message: "Soba je puna (max 12 igrača)." }); return; }
      if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
        send(ws, "error", { message: "Ime je već zauzeto." }); return;
      }
      const playerId = addPlayer(room, ws, name);
      send(ws, "room_joined", { code: room.code, playerId, isHost: false });
      broadcastLobby(room);
      return;
    }

    // ── All messages below require being in a room ──
    const room = ws.roomCode ? rooms[ws.roomCode] : null;
    if (!room) return;
    const player = room.players.find(p => p.id === ws.playerId);
    if (!player) return;

    // ── TOGGLE JOKER (host only) ──
    if (type === "toggle_joker") {
      if (player.id !== room.hostId) return;
      room.includeJoker = !room.includeJoker;
      broadcastLobby(room);
      return;
    }

    // ── START GAME (host only) ──
    if (type === "start_game") {
      if (player.id !== room.hostId) return;
      const min = room.includeJoker ? 4 : 3;
      if (room.players.length < min) {
        send(ws, "error", { message: `Potrebno je najmanje ${min} igrača.` });
        return;
      }
      startGame(room);
      return;
    }

    // ── NIGHT ACTION (pick target) ──
    if (type === "night_pick") {
      const { targetId } = msg;
      const currentRole = room.nightOrder[room.nightIdx];
      if (player.role !== currentRole || !player.alive) return;
      room.nightActions[currentRole] = targetId;
      room.nightIdx++;
      promptNightRole(room);
      return;
    }

    // ── POLICE CHECK ──
    if (type === "police_check") {
      const { targetId } = msg;
      if (player.role !== "police" || !player.alive) return;
      const target = room.players.find(p => p.id === targetId);
      if (!target) return;
      send(ws, "police_result", {
        targetId,
        targetName: target.name,
        isMafia: target.role === "mafia",
      });
      return;
    }

    // ── DAWN ACTION (host presses next round or vote) ──
    if (type === "next_round") {
      if (player.id !== room.hostId) return;
      room.round++;
      startNight(room);
      return;
    }

    if (type === "start_voting") {
      if (player.id !== room.hostId) return;
      startVoting(room);
      return;
    }

    // ── VOTE ──
    if (type === "cast_vote") {
      const { targetId } = msg;
      if (!player.alive) return;
      if (!room.votersLeft.includes(player.id)) return;
      room.votes[player.id] = targetId;
      room.votersLeft = room.votersLeft.filter(id => id !== player.id);
      broadcast(room, "vote_cast", { voterId: player.id, voterName: player.name });
      promptNextVoter(room);
      return;
    }

    // ── REDO VOTE (tie) ──
    if (type === "redo_vote") {
      if (player.id !== room.hostId) return;
      startVoting(room);
      return;
    }

    // ── NEW GAME (gameover) ──
    if (type === "new_game") {
      if (player.id !== room.hostId) return;
      room.phase = "lobby";
      room.players = room.players.map(p => ({ ...p, role: null, alive: true, silenced: false }));
      room.round = 1;
      room.nightActions = {};
      room.votes = {};
      broadcastLobby(room);
      return;
    }
  });

  ws.on("close", () => {
    const room = ws.roomCode ? rooms[ws.roomCode] : null;
    if (!room) return;
    room.players = room.players.filter(p => p.id !== ws.playerId);
    if (room.players.length === 0) {
      delete rooms[ws.roomCode];
      return;
    }
    // If host left, assign new host
    if (room.hostId === ws.playerId && room.players.length > 0) {
      room.hostId = room.players[0].id;
    }
    if (room.phase === "lobby") broadcastLobby(room);
    else broadcast(room, "player_left", {
      players: publicPlayers(room),
      leftId: ws.playerId,
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Mafija server radi na portu ${PORT}`));
