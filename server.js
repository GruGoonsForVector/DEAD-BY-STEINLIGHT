"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

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
  { x: 650, y: 400, w: 500, h: 350 },
  { x: 1450, y: 350, w: 550, h: 400 },
  { x: 350, y: 1250, w: 550, h: 350 },
  { x: 1550, y: 1250, w: 500, h: 400 },
  { x: 1050, y: 900, w: 300, h: 250 },
  { x: 2250, y: 500, w: 180, h: 180 },
  { x: 2250, y: 1450, w: 180, h: 180 }
];

const stationData = [
  { id: "basement", name: "Basement Exit", x: 1200, y: 800 },
  { id: "engine", name: "Boat Engine", x: 2250, y: 1850 },
  { id: "hull", name: "Boat Hull", x: 2420, y: 1850 },
  { id: "electrics", name: "Boat Electrics", x: 2350, y: 1700 }
];

const fuelData = [
  { id: "fuel1", x: 450, y: 950 },
  { id: "fuel2", x: 1900, y: 950 }
];

const hidingSpots = [
  { x: 550, y: 500, type: "Wardrobe" },
  { x: 1200, y: 650, type: "Locker" },
  { x: 1750, y: 500, type: "Wardrobe" },
  { x: 600, y: 1450, type: "Bush" },
  { x: 1750, y: 1450, type: "Bed" },
  { x: 2300, y: 1100, type: "Bush" }
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
    { x: 300, y: 300 },
    { x: 430, y: 350 },
    { x: 300, y: 470 },
    { x: 470, y: 480 },
    { x: 550, y: 350 }
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
    stamina: 100,
    input: {},
    wasHiding: false,
    wasPulse: false,
    wasDisrupt: false,
    cooldown: 0,
    catchCooldown: 0,
    pulse: 0
  };
}

function makeGame(players) {
  const list = players.map((p, i) => ({
    ...createPlayer(p.id, p.name, i)
  }));

  const hunter = list[Math.floor(Math.random() * list.length)];

  hunter.role = "hunter";

  // Safe spawn outside all building collision areas.
  hunter.x = 1400;
  hunter.y = 1100;

  return {
    started: true,
    ended: false,
    winner: null,
    players: list,
    tasks: stationData.map(t => ({
      ...t,
      progress: 0
    })),
    fuel: fuelData.map(f => ({
      ...f,
      collected: false
    })),
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
  const closestX = Math.max(
    rect.x,
    Math.min(x, rect.x + rect.w)
  );

  const closestY = Math.max(
    rect.y,
    Math.min(y, rect.y + rect.h)
  );

  return Math.hypot(
    x - closestX,
    y - closestY
  ) < radius;
}

function blocked(x, y, radius) {
  if (
    x < radius ||
    y < radius ||
    x > MAP.width - radius ||
    y > MAP.height - radius
  ) {
    return true;
  }

  return obstacles.some(o =>
    rectCollision(x, y, radius, o)
  );
}

function movePlayer(p, dx, dy, speed) {
  const length = Math.hypot(dx, dy);

  if (length > 0) {
    dx /= length;
    dy /= length;
  }

  const nx = p.x + dx * speed;
  const ny = p.y + dy * speed;

  // Separate axis checks allow smooth sliding against walls.
  if (!blocked(nx, p.y, 17)) p.x = nx;
  if (!blocked(p.x, ny, 17)) p.y = ny;
}

function allObjectivesComplete(game) {
  return (
    game.tasks.every(t => t.progress >= 100) &&
    game.fuel.every(f => f.collected)
  );
}

function getState(game) {
  return {
    players: game.players.map(p => ({
      id: p.id,
      name: p.name,
      role: p.role,
      x: p.x,
      y: p.y,
      alive: p.alive,
      escaped: p.escaped,
      hidden: p.hidden,
      stamina: p.stamina,
      pulse: p.pulse,
      cooldown: p.cooldown
    })),
    tasks: game.tasks,
    fuel: game.fuel,
    time: game.time
  };
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

    p.cooldown = Math.max(0, p.cooldown - 1);
    p.catchCooldown = Math.max(0, p.catchCooldown - 1);
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
        p.stamina = Math.min(100, p.stamina + 0.45);
      }

      movePlayer(p, dx, dy, speed);

      // Tracking pulse has its own cooldown.
      if (input.pulse && !p.wasPulse && p.cooldown <= 0) {
        p.cooldown = 240;
        p.pulse = 90;

        io.to(room.code).emit("notice", "The Hunter used a tracking pulse!");
      }

      p.wasPulse = !!input.pulse;

      // Disrupt ability has a separate cooldown.
      if (input.disrupt && !p.wasDisrupt && p.disruptCooldown <= 0) {
        const nearby = game.tasks.find(t =>
          Math.hypot(t.x - p.x, t.y - p.y) < 150
        );

        if (nearby) {
          nearby.progress = Math.max(0, nearby.progress - 15);
          p.disruptCooldown = 180;

          io.to(room.code).emit("notice", "A repair station was disrupted!");
        }
      }

      p.wasDisrupt = !!input.disrupt;

      // Catching players is independent of ability cooldowns.
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
          target.hidden = false;
          p.catchCooldown = 30;

          io.to(room.code).emit(
            "notice",
            `${target.name} was caught!`
          );
        }
      }

    } else {
      // Hide/unhide only on the initial key press.
      if (input.hide && !p.wasHiding) {
        const spot = hidingSpots.find(s =>
          Math.hypot(s.x - p.x, s.y - p.y) < 65
        );

        if (spot) {
          p.hidden = !p.hidden;
        }
      }

      p.wasHiding = !!input.hide;

      if (!p.hidden) {
        let speed = input.crouch ? 1.5 : 2.9;

        if (input.sprint && p.stamina > 0) {
          speed = 4.3;
          p.stamina = Math.max(0, p.stamina - 0.7);
        } else {
          p.stamina = Math.min(100, p.stamina + 0.45);
        }

        movePlayer(p, dx, dy, speed);
      }

      // Repairs and fuel collection.
      if (input.interact && !p.hidden) {
        const task = game.tasks.find(t =>
          Math.hypot(t.x - p.x, t.y - p.y) < 75
        );

        if (task && task.progress < 100) {
          task.progress = Math.min(100, task.progress + 0.18);
        }

        const fuel = game.fuel.find(f =>
          !f.collected &&
          Math.hypot(f.x - p.x, f.y - p.y) < 65
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

    if (escaped) {
      endGame(room, "escapees", "The escapees successfully escaped!");
    } else {
      endGame(room, "hunter", "The Hunter caught everyone.");
    }

    return;
  }

  // Send network updates 15 times per second instead of 30.
  if (game.time % 2 === 0) {
    io.to(room.code).volatile.emit("state", getState(game));
  }
}

function startRoom(room) {
  if (room.players.length < 2) return false;

  room.game = makeGame(room.players);
  room.players = room.game.players;

  // Initialise Hunter ability cooldown.
  for (const p of room.players) {
    p.disruptCooldown = 0;
  }

  io.to(room.code).emit("gameStarted", {
    map: MAP,
    obstacles,
    hidingSpots,
    game: getState(room.game)
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

    io.to(code).emit(
      "notice",
      "The host left. A new host was selected."
    );
  }

  if (room.game) {
    room.game.players = room.players;

    const escapees = room.players.filter(p => p.role === "escapee");
    const remaining = escapees.filter(p => p.alive && !p.escaped);

    if (escapees.length && remaining.length === 0) {
      endGame(
        room,
        escapees.some(p => p.escaped) ? "escapees" : "hunter",
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
      callback({ ok: false, error: "Room not found. Check the code." });
      return;
    }

    if (room.game && !room.game.ended) {
      callback({ ok: false, error: "That game has already started." });
      return;
    }

    if (room.players.length >= 5) {
      callback({ ok: false, error: "Room is full." });
      return;
    }

    if (socket.data.room) removePlayer(socket);

    const player = createPlayer(
      socket.id,
      cleanName(name),
      room.players.length
    );

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
      callback?.({ ok: false, error: "You need at least 2 players." });
      return;
    }

    if (room.game && !room.game.ended) {
      callback?.({ ok: false, error: "The game has already started." });
      return;
    }

    if (!startRoom(room)) {
      callback?.({ ok: false, error: "Could not start game." });
      return;
    }

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
      "hide", "pulse", "disrupt"
    ];

    const clean = {};

    for (const key of allowed) {
      clean[key] = !!input?.[key];
    }

    player.input = clean;
  });

  socket.on("leaveRoom", () => {
    removePlayer(socket);
  });

  socket.on("disconnect", () => {
    removePlayer(socket);
  });
});

server.listen(PORT, () => {
  console.log(`DEAD BY STEINLIGHT running on port ${PORT}`);
});
