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

function assignRoles(players, counts) {
  // counts = { mafia, doctor, police, joker }
  const roles = [];
  for (let i=0;i<counts.mafia;i++) roles.push("mafia");
  for (let i=0;i<counts.doctor;i++) roles.push("doctor");
  for (let i=0;i<counts.police;i++) roles.push("police");
  for (let i=0;i<counts.joker;i++) roles.push("joker");
  while (roles.length < players.length) roles.push("civilian");
  const shuffled = shuffle(roles);
  // Store original joker order for inheritance (by index in shuffled)
  const jokerOrder = [];
  shuffled.forEach((r,i) => { if (r==="joker") jokerOrder.push(players[i].id); });
  return { 
    assigned: players.map((p, i) => ({ ...p, role: shuffled[i], alive: true, silenced: false })),
    jokerOrder
  };
}

function createRoom(hostWs, hostName, includeJoker) {
  let code = makeCode();
  while (rooms[code]) code = makeCode();

  const room = {
    code,
    phase: "lobby",
    players: [],
    hostId: null,
    includeJoker,
    roleCounts: { mafia:1, doctor:1, police:1, joker:0 },
    jokerOrder: [],      // original joker ids in order for inheritance
    round: 1,
    nightActions: {},
    nightOrder: [],
    nightIdx: 0,
    votes: {},
    votersLeft: [],
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
    roleCounts: room.roleCounts,
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
  const counts = { ...room.roleCounts };
  if (!room.includeJoker) counts.joker = 0;
  const { assigned, jokerOrder } = assignRoles(room.players, counts);
  room.players = assigned;
  room.jokerOrder = jokerOrder;
  room.phase = "night";
  room.round = 1;

  // Tell everyone game started + their role
  broadcast(room, "game_started", { players: publicPlayers(room) });
  sendRoles(room);

  startNight(room);
}

function buildNightOrder(room) {
  // Returns list of player IDs in order: all mafia, then doctors, then police, then jokers
  const alive = room.players.filter(p => p.alive);
  const order = [];
  ["mafia","doctor","police","joker"].forEach(role => {
    alive.filter(p => p.role === role).forEach(p => order.push(p.id));
  });
  return order;
}

function startNight(room) {
  room.phase = "night";
  room.nightActions = {};
  room.nightActionsByPlayer = {};
  room.nightOrder = buildNightOrder(room);
  room.nightIdx = 0;

  broadcast(room, "night_started", { round: room.round });
  promptNightRole(room);
}

function promptNightRole(room) {
  if (room.nightIdx >= room.nightOrder.length) {
    processDawn(room);
    return;
  }

  const currentPlayerId = room.nightOrder[room.nightIdx];
  const currentPlayer = room.players.find(p => p.id === currentPlayerId);
  if (!currentPlayer || !currentPlayer.alive) {
    // Skip dead players
    room.nightIdx++;
    promptNightRole(room);
    return;
  }

  const currentRole = currentPlayer.role;
  const alive = room.players.filter(p => p.alive);

  broadcast(room, "night_role_prompt", {
    role: currentRole,
    roleLabel: ROLES[currentRole].label,
    roleEmoji: ROLES[currentRole].emoji,
    roleColor: ROLES[currentRole].color,
    actingPlayerName: currentPlayer.name,
  });

  const targets = alive.filter(p => {
    if (currentRole === "mafia") return p.role !== "mafia";
    return p.id !== currentPlayer.id;
  }).map(p => ({ id: p.id, name: p.name }));

  send(currentPlayer.ws, "your_turn", {
    role: currentRole,
    targets,
    isPolice: currentRole === "police",
  });
}

function processDawn(room) {
  const actions = room.nightActionsByPlayer || {};

  // Collect all targets by role
  const killTargetIds = new Set();
  const saveTargetIds = new Set();
  const silenceTargetIds = new Set();

  Object.values(actions).forEach(({ role, targetId }) => {
    if (role === "mafia")  killTargetIds.add(targetId);
    if (role === "doctor") saveTargetIds.add(targetId);
    if (role === "joker")  silenceTargetIds.add(targetId);
  });

  // Killed = attacked but NOT saved
  const killedPlayers = room.players.filter(p =>
    killTargetIds.has(p.id) && !saveTargetIds.has(p.id) && p.alive
  );
  // Saved = attacked AND saved
  const savedPlayers = room.players.filter(p =>
    killTargetIds.has(p.id) && saveTargetIds.has(p.id) && p.alive
  );
  // Silenced
  const silencedPlayers = room.players.filter(p =>
    silenceTargetIds.has(p.id) && p.alive
  );

  // Joker takeovers — for each killed mafia, find next joker in order
  const jokerTakeovers = [];
  const promotedJokerIds = new Set();
  killedPlayers.filter(p => p.role === "mafia").forEach(deadMafia => {
    const nextJoker = room.jokerOrder
      .map(jid => room.players.find(p => p.id === jid))
      .find(p => p && p.role === "joker" && p.alive &&
            !killedPlayers.some(k => k.id === p.id) &&
            !promotedJokerIds.has(p.id));
    if (nextJoker) {
      jokerTakeovers.push({ from: deadMafia, to: nextJoker });
      promotedJokerIds.add(nextJoker.id);
    }
  });

  // Apply changes
  room.players = room.players.map(p => {
    if (killedPlayers.some(k => k.id === p.id)) return { ...p, alive: false, silenced: false };
    if (promotedJokerIds.has(p.id)) return { ...p, role: "mafia", silenced: false };
    if (silencedPlayers.some(s => s.id === p.id)) return { ...p, silenced: true };
    return { ...p, silenced: false };
  });

  room.phase = "dawn";
  room.dawnVotes = {};

  broadcast(room, "dawn", {
    killed: killedPlayers.map(p => ({ id: p.id, name: p.name })),
    saved: savedPlayers.map(p => ({ id: p.id, name: p.name })),
    silenced: silencedPlayers.map(p => ({ id: p.id, name: p.name })),
    jokerTakeovers: jokerTakeovers.map(jt => ({ from: jt.from.name, to: jt.to.name })),
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
  // Joker takeover — pick first joker in original order
  const livingJokerAfter = isMafia
    ? room.jokerOrder
        .map(jid => room.players.find(p => p.id === jid))
        .find(p => p && p.role === "joker" && p.alive && p.id !== eliminated.id)
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
    cityWins: isMafia && (room.players.filter(p => p.role === "mafia" && p.alive).length === 0),
    players: publicPlayers(room),
  });

  const remainingMafia2 = room.players.filter(p => p.role === "mafia" && p.alive).length;
  if (isMafia && remainingMafia2 === 0) {
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
      if (room.players.length >= 30) { send(ws, "error", { message: "Soba je puna (max 30 igrača)." }); return; }
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
      if (!room.includeJoker) room.roleCounts.joker = 0;
      else if (room.roleCounts.joker === 0) room.roleCounts.joker = 1;
      broadcastLobby(room);
      return;
    }

    // ── SET ROLE COUNT (host only) ──
    if (type === "set_role_count") {
      if (player.id !== room.hostId) return;
      const { role, count } = msg;
      if (!["mafia","doctor","police","joker"].includes(role)) return;
      const n = Math.max(0, Math.min(10, parseInt(count)||0));
      if (role === "mafia" && n < 1) return; // must have at least 1 mafia
      if (role === "joker" && n > 0) room.includeJoker = true;
      if (role === "joker" && n === 0) room.includeJoker = false;
      room.roleCounts[role] = n;
      broadcastLobby(room);
      return;
    }

    // ── START GAME (host only) ──
    if (type === "start_game") {
      if (player.id !== room.hostId) return;
      const counts = room.roleCounts;
      const totalSpecial = counts.mafia + counts.doctor + counts.police + (room.includeJoker ? counts.joker : 0);
      if (room.players.length < totalSpecial) {
        send(ws, "error", { message: `Nedovoljno igrača. Trebaš najmanje ${totalSpecial} za odabrane uloge.` });
        return;
      }
      startGame(room);
      return;
    }

    // ── NIGHT ACTION (pick target) ──
    if (type === "night_pick") {
      const { targetId } = msg;
      const currentPlayerId = room.nightOrder[room.nightIdx];
      if (player.id !== currentPlayerId || !player.alive) return;
      // Store action per player ID
      if (!room.nightActionsByPlayer) room.nightActionsByPlayer = {};
      room.nightActionsByPlayer[player.id] = { role: player.role, targetId };
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

    // ── DAWN VOTE ──
    if (type === "dawn_vote") {
      if (!player.alive) return;
      if (room.phase !== "dawn") return;
      const { choice } = msg; // "vote" | "continue"
      if (choice !== "vote" && choice !== "continue") return;
      room.dawnVotes = room.dawnVotes || {};
      room.dawnVotes[player.id] = choice;
      broadcast(room, "dawn_vote_update", { votes: room.dawnVotes });
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
