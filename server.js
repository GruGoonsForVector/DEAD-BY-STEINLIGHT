"use strict";

const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
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

const hidingSpots = [
  { id: "locker1", x: 550, y: 500, type: "Locker" },
  { id: "locker2", x: 1200, y: 650, type: "Locker" },
  { id: "locker3", x: 1750, y: 500, type: "Locker" },
  { id: "wardrobe1", x: 750, y: 750, type: "Wardrobe" },
  { id: "wardrobe2", x: 1850, y: 750, type: "Wardrobe" },
  { id: "bed1", x: 600, y: 1450, type: "Bed" },
  { id: "bush1", x: 600, y: 1050, type: "Bush" },
  { id: "bush2", x: 1750, y: 1450, type: "Bush" },
  { id: "bush3", x: 2300, y: 1100, type: "Bush" }
];

const stationTemplate = [
  { id: "basement", name: "Basement Exit", x: 900, y: 600 },
  { id: "engine", name: "Boat Engine", x: 2250, y: 1850 },
  { id: "hull", name: "Boat Hull", x: 2420, y: 1850 },
  { id: "electrics", name: "Boat Electrics", x: 2350, y: 1700 }
];

const fuelTemplate = [
  { id: "fuel1", x: 450, y: 950, collected: false },
  { id: "fuel2", x: 1900, y: 950, collected: false }
];

function makeCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
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

function createPlayer(id, name) {
  return {
    id,
    name,
    role: "escapee",
    x: 250 + Math.random() * 150,
    y: 250 + Math.random() * 150,
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
  const list = players.map(p => ({
    ...createPlayer(p.id, p.name)
  }));

  const hunter = list[Math.floor(Math.random() * list.length)];
  hunter.role = "hunter";
  hunter.x = 1300;
  hunter.y = 800;

  return {
    started: true,
    ended: false,
    players: list,
    tasks: stationTemplate.map(t => ({
      ...t,
      progress: 0
    })),
    fuel: fuelTemplate.map(f => ({ ...f })),
    time: 0
  };
}

function publicLobby(room) {
  return room.players.map(p => ({
    id: p.id,
    name: p.name
  }));
}

function sendLobby(room) {
  io.to(room.code).emit("lobby", {
    code: room.code,
    host: room.host,
    players: publicLobby(room)
  });
}

function endGame(room, winner, message) {
  if (!room.game || room.game.ended) return;

  room.game.ended = true;

  io.to(room.code).emit("gameOver", {
    winner,
    message
  });
}

function blocked(x, y, radius) {
  if (
    x < radius ||
    y < radius ||
    x > MAP.width - radius ||
    y > MAP.height - radius
  ) return true;

  return obstacles.some(o => {
    const cx = Math.max(o.x, Math.min(x, o.x + o.w));
    const cy = Math.max(o.y, Math.min(y, o.y + o.h));
    return Math.hypot(x - cx, y - cy) < radius;
  });
}

function movePlayer(p, dx, dy, speed) {
  const len = Math.hypot(dx, dy);

  if (len > 0) {
    dx /= len;
    dy /= len;
  }

  const nx = p.x + dx * speed;
  const ny = p.y + dy * speed;

  if (!blocked(nx, p.y, 18)) p.x = nx;
  if (!blocked(p.x, ny, 18)) p.y = ny;
}

function allObjectivesComplete(game) {
  return game.tasks.every(t => t.progress >= 100) &&
    game.fuel.every(f => f.collected);
}

function getStateFor(viewer, game) {
  return {
    players: game.players.map(p => {
      const teammate = p.role === viewer.role;
      const hiddenFromViewer = p.hidden && !teammate;

      return {
        id: p.id,
        name: p.name,
        role: p.role,
        x: hiddenFromViewer ? null : p.x,
        y: hiddenFromViewer ? null : p.y,
        alive: p.alive,
        escaped: p.escaped,
        hidden: p.hidden,
        stamina: p.stamina,
        pulse: p.pulse,
        cooldown: p.pulseCooldown
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

      if (input.sprint && p.stamina > 0) {
        speed = 5.8;
        p.stamina = Math.max(0, p.stamina - 0.65);
      } else {
        p.stamina = Math.min(100, p.stamina + 0.4);
      }

      movePlayer(p, dx, dy, speed);

      if (
        input.pulse &&
        !p.wasPulse &&
        p.pulseCooldown <= 0
      ) {
        p.pulseCooldown = 240;
        p.pulse = 90;

        io.to(room.code).emit(
          "notice",
          "EPSTEIN used a tracking pulse!"
        );
      }

      p.wasPulse = !!input.pulse;

      if (
        input.disrupt &&
        !p.wasDisrupt &&
        p.disruptCooldown <= 0
      ) {
        const task = game.tasks.find(t =>
          distance(p, t) < 150
        );

        if (task) {
          task.progress = Math.max(0, task.progress - 15);
          p.disruptCooldown = 180;

          io.to(room.code).emit(
            "notice",
            "A repair station was disrupted!"
          );
        }
      }

      p.wasDisrupt = !!input.disrupt;

      // Locker search. Only lockers can be searched.
      if (input.search && !p.wasSearch) {
        const locker = hidingSpots.find(s =>
          s.type === "Locker" && distance(p, s) < 85
        );

        if (locker) {
          const target = players.find(t =>
            t.role === "escapee" &&
            t.alive &&
            t.hidden &&
            t.hiddenIn === locker.id
          );

          if (target) {
            target.alive = false;
            target.hidden = false;
            target.hiddenIn = null;

            io.to(room.code).emit(
              "notice",
              `${target.name} was found in a locker!`
            );
          } else {
            io.to(p.id).emit(
              "notice",
              "The locker is empty."
            );
          }
        } else {
          io.to(p.id).emit(
            "notice",
            "Move closer to a locker to search it."
          );
        }
      }

      p.wasSearch = !!input.search;

      // Catch escapees who are not hiding.
      for (const target of players) {
        if (
          target.role !== "escapee" ||
          !target.alive ||
          target.escaped ||
          target.hidden
        ) continue;

        if (
          distance(p, target) < 42 &&
          p.catchCooldown <= 0
        ) {
          target.alive = false;
          p.catchCooldown = 35;

          io.to(room.code).emit(
            "notice",
            `${target.name} was caught!`
          );
        }
      }
    } else {
      // Hide or leave a hiding spot.
      if (input.hide && !p.wasHide) {
        if (p.hidden) {
          p.hidden = false;
          p.hiddenIn = null;
        } else {
          const spot = hidingSpots.find(s =>
            distance(p, s) < 65
          );

          if (spot) {
            p.hidden = true;
            p.hiddenIn = spot.id;
            p.x = spot.x;
            p.y = spot.y;
          }
        }
      }

      p.wasHide = !!input.hide;

      if (!p.hidden) {
        let speed = input.crouch ? 1.5 : 2.9;

        if (input.sprint && p.stamina > 0) {
          speed = 4.3;
          p.stamina = Math.max(0, p.stamina - 0.7);
        } else {
          p.stamina = Math.min(100, p.stamina + 0.4);
        }

        movePlayer(p, dx, dy, speed);
      }

      if (input.interact && !p.hidden) {
        const task = game.tasks.find(t =>
          distance(p, t) < 75
        );

        if (task && task.progress < 100) {
          task.progress = Math.min(
            100,
            task.progress + 0.18
          );
        }

        const fuel = game.fuel.find(f =>
          !f.collected && distance(p, f) < 65
        );

        if (fuel) {
          fuel.collected = true;

          io.to(room.code).emit(
            "notice",
            `${p.name} found a fuel can.`
          );
        }

        if (
          allObjectivesComplete(game) &&
          Math.hypot(2350 - p.x, 1850 - p.y) < 130
        ) {
          p.escaped = true;
          p.alive = false;

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
    const escaped = escapees.some(p => p.escaped);

    endGame(
      room,
      escaped ? "escapees" : "hunter",
      escaped
        ? "The escapees successfully escaped!"
        : "EPSTEIN caught everyone."
    );

    return;
  }

  // Send 15 state updates per second.
  if (game.time % 2 === 0) {
    broadcastState(room);
  }
}

function startRoom(room) {
  if (room.players.length < 2) return false;

  room.game = makeGame(room.players);
  room.players = room.game.players;

  const hunter = room.game.players.find(p => p.role === "hunter");

  // Every client receives the same selected Hunter.
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
      endGame(room, "hunter", "The match has ended.");
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
    if (!player || !player.alive) return;

    const allowed = [
      "up", "down", "left", "right",
      "sprint", "crouch", "interact",
      "hide", "pulse", "disrupt", "search"
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
