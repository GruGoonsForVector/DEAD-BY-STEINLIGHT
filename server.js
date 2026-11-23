"use strict";

const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 25000,
  pingTimeout: 20000
});

const PORT = process.env.PORT || 3000;
const rooms = new Map();

app.use(express.static(__dirname));
app.get("/health", (req, res) => {
  res.json({ online: true, rooms: rooms.size });
});

const MAP = { width: 2800, height: 2200 };

const obstacles = [
  { x: 450, y: 300, w: 550, h: 360, name: "Mansion" },
  { x: 1500, y: 300, w: 550, h: 380, name: "Workshop" },
  { x: 350, y: 1250, w: 550, h: 360, name: "Cabin" },
  { x: 1550, y: 1250, w: 500, h: 400, name: "Boathouse" },
  { x: 1050, y: 900, w: 300, h: 250, name: "Ruins" },
  { x: 2250, y: 500, w: 180, h: 180, name: "Shed" },
  { x: 2250, y: 1450, w: 180, h: 180, name: "Dock Store" }
];

// Objectives are deliberately placed outside solid building collision.
const stationTemplate = [
  { id: "basement", name: "Basement Exit", x: 1200, y: 760, kind: "exit" },
  { id: "engine", name: "Boat Engine", x: 2200, y: 1810, kind: "engine" },
  { id: "hull", name: "Boat Hull", x: 2420, y: 1810, kind: "hull" },
  { id: "electrics", name: "Boat Electrics", x: 2110, y: 1690, kind: "electric" }
];

const fuelTemplate = [
  { id: "fuel1", x: 1120, y: 1350, collected: false },
  { id: "fuel2", x: 2150, y: 1050, collected: false }
];

const hidingSpots = [
  { id: "locker1", x: 1120, y: 620, type: "Locker" },
  { id: "locker2", x: 1380, y: 1050, type: "Locker" },
  { id: "locker3", x: 2100, y: 850, type: "Locker" },
  { id: "wardrobe1", x: 1120, y: 430, type: "Wardrobe" },
  { id: "wardrobe2", x: 1380, y: 1450, type: "Wardrobe" },
  { id: "bed1", x: 1120, y: 1550, type: "Bed" },
  { id: "bush1", x: 650, y: 1000, type: "Bush" },
  { id: "bush2", x: 1850, y: 1100, type: "Bush" },
  { id: "bush3", x: 2500, y: 1150, type: "Bush" }
];

function makeCode() {
  let code;
  do {
    code = crypto.randomBytes(3).toString("hex").toUpperCase();
  } while (rooms.has(code));
  return code;
}

function cleanName(value) {
  return String(value || "Player")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 18) || "Player";
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function createPlayer(id, name, index = 0) {
  const spawns = [
    { x: 250, y: 250 },
    { x: 350, y: 850 },
    { x: 1250, y: 1250 },
    { x: 2150, y: 1250 },
    { x: 2500, y: 850 }
  ];

  const spawn = spawns[index % spawns.length];

  return {
    id,
    name,
    role: "escapee",
    x: spawn.x,
    y: spawn.y,
    alive: true,
    escaped: false,
    hidden: false,
    hiddenIn: null,
    stamina: 100,
    input: {},
    wasHide: false,
    wasSearch: false,
    wasPulse: false,
    wasDisrupt: false,
    catchCooldown: 0,
    pulseCooldown: 0,
    disruptCooldown: 0,
    pulse: 0
  };
}

function makeGame(players) {
  const list = players.map((p, i) =>
    createPlayer(p.id, p.name, i)
  );

  const hunter = list[Math.floor(Math.random() * list.length)];
  hunter.role = "hunter";
  hunter.x = 1400;
  hunter.y = 1100;

  return {
    started: true,
    ended: false,
    winner: null,
    players: list,
    tasks: stationTemplate.map(t => ({
      ...t,
      progress: 0
    })),
    fuel: fuelTemplate.map(f => ({ ...f })),
    time: 0
  };
}

function publicPlayers(room) {
  return room.players.map(p => ({
    id: p.id,
    name: p.name,
    role: p.role,
    alive: p.alive,
    escaped: p.escaped
  }));
}

function sendLobby(room) {
  io.to(room.code).emit("lobby", {
    code: room.code,
    host: room.host,
    players: publicPlayers(room)
  });
}

function endGame(room, winner, message) {
  if (!room.game || room.game.ended) return;

  room.game.ended = true;
  room.game.winner = winner;

  io.to(room.code).emit("gameOver", {
    winner,
    message
  });
}

function rectCollision(x, y, radius, rect) {
  const closestX = Math.max(rect.x, Math.min(x, rect.x + rect.w));
  const closestY = Math.max(rect.y, Math.min(y, rect.y + rect.h));

  return Math.hypot(x - closestX, y - closestY) < radius;
}

function blocked(x, y, radius) {
  if (
    x < radius ||
    y < radius ||
    x > MAP.width - radius ||
    y > MAP.height - radius
  ) return true;

  return obstacles.some(o => rectCollision(x, y, radius, o));
}

function movePlayer(p, dx, dy, speed) {
  const length = Math.hypot(dx, dy);

  if (length > 0) {
    dx /= length;
    dy /= length;
  }

  const nx = p.x + dx * speed;
  const ny = p.y + dy * speed;

  if (!blocked(nx, p.y, 17)) p.x = nx;
  if (!blocked(p.x, ny, 17)) p.y = ny;
}

function allObjectivesComplete(game) {
  return (
    game.tasks.every(t => t.progress >= 100) &&
    game.fuel.every(f => f.collected)
  );
}

// Each player receives only the information their role should know.
function getStateFor(viewer, game) {
  const hunter = game.players.find(p => p.role === "hunter");
  const hunterPulseActive = !!(hunter && hunter.pulse > 0);

  return {
    players: game.players.map(p => {
      let revealPosition = false;

      if (p.id === viewer.id) {
        revealPosition = true;
      } else if (viewer.role === "escapee") {
        revealPosition = p.role === "escapee" && p.alive && !p.escaped;
      } else if (viewer.role === "hunter") {
        revealPosition =
          p.role === "escapee" &&
          p.alive &&
          !p.escaped &&
          hunterPulseActive;
      }

      return {
        id: p.id,
        name: p.name,
        role: p.role,
        x: revealPosition ? p.x : null,
        y: revealPosition ? p.y : null,
        alive: p.alive,
        escaped: p.escaped,
        hidden: p.hidden,
        stamina: p.stamina,
        pulse: p.pulse,
        pulseCooldown: p.pulseCooldown,
        disruptCooldown: p.disruptCooldown,
        hiddenIn: p.hiddenIn
      };
    }),
    tasks: game.tasks,
    fuel: game.fuel,
    time: game.time
  };
}

function broadcastState(room) {
  for (const player of room.players) {
    io.to(player.id).volatile.emit(
      "state",
      getStateFor(player, room.game)
    );
  }
}

function eliminate(room, target, message) {
  if (!target || !target.alive || target.escaped) return;

  target.alive = false;
  target.hidden = false;
  target.hiddenIn = null;
  target.input = {};

  io.to(room.code).emit("notice", message);
}

function gameTick(room) {
  const game = room.game;

  if (!game || !game.started || game.ended) return;

  game.time++;

  const players = game.players;
  const hunter = players.find(p => p.role === "hunter");

  if (!hunter || !hunter.alive) {
    endGame(room, "escapees", "The Hunter is out of the game.");
    return;
  }

  for (const p of players) {
    if (!p.alive || p.escaped) continue;

    const input = p.input || {};

    p.catchCooldown = Math.max(0, p.catchCooldown - 1);
    p.pulseCooldown = Math.max(0, p.pulseCooldown - 1);
    p.disruptCooldown = Math.max(0, p.disruptCooldown - 1);
    p.pulse = Math.max(0, p.pulse - 1);

    const dx =
      (input.right ? 1 : 0) -
      (input.left ? 1 : 0);

    const dy =
      (input.down ? 1 : 0) -
      (input.up ? 1 : 0);

    if (p.role === "hunter") {
      let speed = 3.5;

      // Q or Shift sprint.
      if (input.sprint && p.stamina > 0) {
        speed = 5.8;
        p.stamina = Math.max(0, p.stamina - 0.65);
      } else {
        p.stamina = Math.min(100, p.stamina + 0.4);
      }

      movePlayer(p, dx, dy, speed);

      // R: tracking pulse. Escapees become visible to the Hunter.
      if (input.pulse && !p.wasPulse) {
        if (p.pulseCooldown <= 0) {
          p.pulseCooldown = 300;
          p.pulse = 90;

          io.to(p.id).emit("notice", "TRACKING PULSE ACTIVATED!");
          io.to(room.code).except(p.id).emit(
            "notice",
            "The Hunter has activated a tracking pulse!"
          );
        } else {
          io.to(p.id).emit(
            "notice",
            `Tracking pulse recharging: ${Math.ceil(p.pulseCooldown / 30)}s`
          );
        }
      }
      p.wasPulse = !!input.pulse;

      // F: disrupt the nearest repair station.
      if (input.disrupt && !p.wasDisrupt) {
        if (p.disruptCooldown <= 0) {
          const task = game.tasks.find(t => distance(p, t) < 175);

          if (task && task.progress > 0) {
            task.progress = Math.max(0, task.progress - 25);
            p.disruptCooldown = 240;

            io.to(room.code).emit(
              "notice",
              `EPSTEIN DISRUPTED ${task.name.toUpperCase()}!`
            );
          } else if (task) {
            io.to(p.id).emit("notice", "That station has no progress to disrupt.");
          } else {
            io.to(p.id).emit("notice", "Get closer to a repair station.");
          }
        } else {
          io.to(p.id).emit(
            "notice",
            `Disruption recharging: ${Math.ceil(p.disruptCooldown / 30)}s`
          );
        }
      }
      p.wasDisrupt = !!input.disrupt;

      // E: search the nearest locker.
      if (input.search && !p.wasSearch) {
        const locker = hidingSpots.find(s =>
          s.type === "Locker" && distance(p, s) < 90
        );

        if (!locker) {
          io.to(p.id).emit("notice", "Stand closer to a locker to search it.");
        } else {
          const target = players.find(t =>
            t.role === "escapee" &&
            t.alive &&
            t.hidden &&
            t.hiddenIn === locker.id
          );

          if (target) {
            eliminate(
              room,
              target,
              `EPSTEIN FOUND ${target.name} IN A LOCKER!`
            );
          } else {
            io.to(p.id).emit("notice", "EMPTY LOCKER");
          }
        }
      }
      p.wasSearch = !!input.search;

      // Normal catching works only when an escapee is not hiding.
      for (const target of players) {
        if (
          target.role !== "escapee" ||
          !target.alive ||
          target.escaped ||
          target.hidden
        ) continue;

        if (distance(p, target) < 42 && p.catchCooldown <= 0) {
          eliminate(room, target, `${target.name} was caught!`);
          p.catchCooldown = 35;
          break;
        }
      }
    } else {
      // Escapee E: hide if close to a hiding spot, otherwise repair/collect.
      if (input.interact && !p.wasHide) {
        if (p.hidden) {
          p.hidden = false;
          p.hiddenIn = null;
          io.to(p.id).emit("notice", "You left your hiding place.");
        } else {
          const spot = hidingSpots.find(s => distance(p, s) < 65);

          if (spot) {
            p.hidden = true;
            p.hiddenIn = spot.id;
            p.x = spot.x;
            p.y = spot.y;

            io.to(p.id).emit(
              "notice",
              `Hiding in ${spot.type.toLowerCase()}.`
            );
          }
        }
      }

      p.wasHide = !!input.interact;

      if (!p.hidden) {
        let speed = input.crouch ? 1.5 : 2.9;

        if (input.sprint && p.stamina > 0) {
          speed = 4.3;
          p.stamina = Math.max(0, p.stamina - 0.7);
        } else {
          p.stamina = Math.min(100, p.stamina + 0.45);
        }

        movePlayer(p, dx, dy, speed);
      } else {
        p.stamina = Math.min(100, p.stamina + 0.5);
      }

      // Repair while E is held, but do not repair while hidden.
      if (input.interact && !p.hidden) {
        const task = game.tasks.find(t => distance(p, t) < 90);

        if (task && task.progress < 100) {
          task.progress = Math.min(100, task.progress + 0.16);
        }

        const fuel = game.fuel.find(f =>
          !f.collected && distance(p, f) < 65
        );

        if (fuel) {
          fuel.collected = true;
          io.to(room.code).emit(
            "notice",
            `${p.name} collected a fuel can.`
          );
        }

        if (
          allObjectivesComplete(game) &&
          Math.hypot(2350 - p.x, 1850 - p.y) < 150
        ) {
          p.escaped = true;
          p.alive = false;
          p.hidden = false;
          p.hiddenIn = null;

          io.to(room.code).emit(
            "notice",
            `${p.name} escaped by boat!`
          );
        }
      }
    }
  }

  const escapees = players.filter(p => p.role === "escapee");
  const remaining = escapees.filter(p => p.alive && !p.escaped);

  if (escapees.length && remaining.length === 0) {
    const anyoneEscaped = escapees.some(p => p.escaped);

    endGame(
      room,
      anyoneEscaped ? "escapees" : "hunter",
      anyoneEscaped
        ? "The escapees who survived made it off the island!"
        : "EPSTEIN caught everyone."
    );
    return;
  }

  if (game.time % 2 === 0) {
    broadcastState(room);
  }
}

function startRoom(room) {
  if (room.players.length < 2) return false;

  room.game = makeGame(room.players);
  room.players = room.game.players;

  const hunter = room.game.players.find(p => p.role === "hunter");

  io.to(room.code).emit("gameStarted", {
    map: MAP,
    obstacles,
    hidingSpots,
    hunterId: hunter.id,
    playerNames: room.game.players.map(p => ({
      id: p.id,
      name: p.name
    })),
    game: getStateFor(hunter, room.game)
  });

  broadcastState(room);
  return true;
}

function removePlayer(socket) {
  const code = socket.data.room;
  if (!code) return;

  const room = rooms.get(code);
  socket.data.room = null;

  if (!room) return;

  socket.leave(code);
  room.players = room.players.filter(p => p.id !== socket.id);

  if (room.players.length === 0) {
    clearInterval(room.timer);
    rooms.delete(code);
    return;
  }

  if (room.host === socket.id) {
    room.host = room.players[0].id;
  }

  if (room.game) {
    room.game.players = room.players;

    const escapees = room.players.filter(p => p.role === "escapee");
    const remaining = escapees.filter(p => p.alive && !p.escaped);

    if (escapees.length && remaining.length === 0) {
      const escaped = escapees.some(p => p.escaped);
      endGame(
        room,
        escaped ? "escapees" : "hunter",
        "The match has ended."
      );
    }
  }

  sendLobby(room);
}

io.on("connection", socket => {
  socket.on("createRoom", ({ name } = {}, callback = () => {}) => {
    if (socket.data.room) removePlayer(socket);

    const code = makeCode();
    const player = createPlayer(socket.id, cleanName(name));

    const room = {
      code,
      host: socket.id,
      players: [player],
      game: null,
      timer: null
    };

    rooms.set(code, room);
    socket.join(code);
    socket.data.room = code;

    room.timer = setInterval(
      () => gameTick(room),
      1000 / 30
    );

    callback({ ok: true, code });
    sendLobby(room);
  });

  socket.on("joinRoom", ({ code, name } = {}, callback = () => {}) => {
    code = String(code || "").trim().toUpperCase();

    const room = rooms.get(code);

    if (!room) {
      callback({ ok: false, error: "Room not found." });
      return;
    }

    if (room.game && !room.game.ended) {
      callback({ ok: false, error: "The game has already started." });
      return;
    }

    if (room.players.length >= 5) {
      callback({ ok: false, error: "Room is full." });
      return;
    }

    if (socket.data.room) removePlayer(socket);

    const player = createPlayer(socket.id, cleanName(name));

    room.players.push(player);
    socket.join(code);
    socket.data.room = code;

    callback({ ok: true, code });
    sendLobby(room);
  });

  socket.on("startGame", callback => {
    const room = rooms.get(socket.data.room);

    if (!room || room.host !== socket.id) {
      callback?.({ ok: false, error: "Only the host can start." });
      return;
    }

    if (room.players.length < 2) {
      callback?.({ ok: false, error: "At least 2 players are required." });
      return;
    }

    if (room.game && !room.game.ended) {
      callback?.({ ok: false, error: "Game already running." });
      return;
    }

    startRoom(room);
    callback?.({ ok: true });
  });

  socket.on("input", input => {
    const room = rooms.get(socket.data.room);
    if (!room || !room.game || room.game.ended) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.alive || player.escaped) return;

    const allowed = [
      "up", "down", "left", "right",
      "sprint", "crouch", "interact",
      "pulse", "disrupt", "search"
    ];

    const clean = {};

    for (const key of allowed) {
      clean[key] = !!input?.[key];
    }

    player.input = clean;
  });

  socket.on("leaveRoom", () => removePlayer(socket));
  socket.on("disconnect", () => removePlayer(socket));
});

server.listen(PORT, () => {
  console.log(`DEAD BY STEINLIGHT running on port ${PORT}`);
});
