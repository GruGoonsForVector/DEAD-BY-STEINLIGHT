const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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

const stations = [
  { id: "basement", name: "Basement Exit", x: 900, y: 600, progress: 0 },
  { id: "engine", name: "Boat Engine", x: 2250, y: 1850, progress: 0 },
  { id: "hull", name: "Boat Hull", x: 2420, y: 1850, progress: 0 },
  { id: "electrics", name: "Boat Electrics", x: 2350, y: 1700, progress: 0 }
];

const fuelLocations = [
  { id: "fuel1", x: 450, y: 950, collected: false },
  { id: "fuel2", x: 1900, y: 950, collected: false }
];

const hidingSpots = [
  { x: 550, y: 500, type: "Wardrobe" },
  { x: 1200, y: 650, type: "Locker" },
  { x: 1750, y: 500, type: "Wardrobe" },
  { x: 600, y: 1450, type: "Bush" },
  { x: 1750, y: 1450, type: "Bed" },
  { x: 2300, y: 1100, type: "Bush" }
];

function roomCode() {
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
    x: 300 + Math.random() * 150,
    y: 300 + Math.random() * 150,
    alive: true,
    escaped: false,
    hidden: false,
    stamina: 100,
    input: {},
    cooldown: 0,
    pulse: 0,
    disrupt: 0
  };
}

function makeGame(players) {
  const list = players.map(p => ({
    ...p,
    role: "escapee",
    x: 300 + Math.random() * 150,
    y: 300 + Math.random() * 150,
    alive: true,
    escaped: false,
    hidden: false,
    stamina: 100,
    input: {},
    cooldown: 0,
    pulse: 0,
    disrupt: 0
  }));

  const hunter = list[Math.floor(Math.random() * list.length)];
  hunter.role = "hunter";
  hunter.x = 1300;
  hunter.y = 1050;

  return {
    started: true,
    ended: false,
    winner: null,
    players: list,
    tasks: stations.map(t => ({ ...t })),
    fuel: fuelLocations.map(f => ({ ...f })),
    boatReady: false,
    time: 0,
    message: "Escape the island."
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
  room.game.message = message;

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

  if (!blocked(nx, p.y, 18)) p.x = nx;
  if (!blocked(p.x, ny, 18)) p.y = ny;
}

function allObjectivesComplete(game) {
  return game.tasks.every(t => t.progress >= 100) &&
    game.fuel.every(f => f.collected);
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
    p.pulse = Math.max(0, p.pulse - 1);
    p.disrupt = Math.max(0, p.disrupt - 1);

    if (p.role === "hunter") {
      let speed = 3.2;

      if (input.sprint && p.stamina > 0) {
        speed = 5.2;
        p.stamina = Math.max(0, p.stamina - 0.65);
      } else {
        p.stamina = Math.min(100, p.stamina + 0.35);
      }

      movePlayer(
        p,
        (input.right ? 1 : 0) - (input.left ? 1 : 0),
        (input.down ? 1 : 0) - (input.up ? 1 : 0),
        speed
      );

      if (input.pulse && p.cooldown <= 0) {
        p.cooldown = 240;
        p.pulse = 90;
      }

      if (input.disrupt && p.cooldown <= 0) {
        const nearby = game.tasks.find(t =>
          Math.hypot(t.x - p.x, t.y - p.y) < 150
        );

        if (nearby) {
          nearby.progress = Math.max(0, nearby.progress - 15);
          p.cooldown = 180;
        }
      }

      for (const target of players) {
        if (
          target.role !== "escapee" ||
          !target.alive ||
          target.escaped ||
          target.hidden
        ) continue;

        if (distance(p, target) < 42 && p.cooldown <= 0) {
          target.alive = false;
          target.hidden = false;
          p.cooldown = 45;
          io.to(room.code).emit("notice", `${target.name} was caught!`);
        }
      }
    } else {
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
        let speed = input.crouch ? 1.5 : 2.8;

        if (input.sprint && p.stamina > 0) {
          speed = 4.2;
          p.stamina = Math.max(0, p.stamina - 0.7);
        } else {
          p.stamina = Math.min(100, p.stamina + 0.35);
        }

        movePlayer(
          p,
          (input.right ? 1 : 0) - (input.left ? 1 : 0),
          (input.down ? 1 : 0) - (input.up ? 1 : 0),
          speed
        );
      }

      if (input.interact && !p.hidden) {
        const task = game.tasks.find(t =>
          Math.hypot(t.x - p.x, t.y - p.y) < 75
        );

        if (task && task.progress < 100) {
          task.progress = Math.min(100, task.progress + 0.22);
        }

        const fuel = game.fuel.find(f =>
          !f.collected && Math.hypot(f.x - p.x, f.y - p.y) < 65
        );

        if (fuel) {
          fuel.collected = true;
          io.to(room.code).emit("notice", `${p.name} found a fuel can.`);
        }

        if (
          allObjectivesComplete(game) &&
          Math.hypot(2350 - p.x, 1850 - p.y) < 130
        ) {
          p.escaped = true;
          p.alive = false;
          io.to(room.code).emit("notice", `${p.name} escaped by boat!`);
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

  io.to(room.code).volatile.emit("state", {
    players: players.map(p => ({
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
    time: game.time,
    message: game.message
  });
}

function startRoom(room) {
  if (room.players.length < 2) return false;
  room.game = makeGame(room.players);
  room.players = room.game.players;
  io.to(room.code).emit("gameStarted", {
    map: MAP,
    obstacles,
    hidingSpots,
    game: {
      players: room.game.players.map(p => ({
        id: p.id,
        name: p.name,
        role: p.role,
        x: p.x,
        y: p.y,
        alive: p.alive,
        escaped: p.escaped,
        hidden: p.hidden,
        stamina: p.stamina
      })),
      tasks: room.game.tasks,
      fuel: room.game.fuel
    }
  });
  return true;
}

io.on("connection", socket => {
  socket.on("createRoom", ({ name } = {}, callback = () => {}) => {
    const code = roomCode();
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

    room.timer = setInterval(() => gameTick(room), 1000 / 30);

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

    if (room.game && room.game.started && !room.game.ended) {
      callback({ ok: false, error: "That game has already started." });
      return;
    }

    if (room.players.length >= 5) {
      callback({ ok: false, error: "Room is full." });
      return;
    }

    if (room.players.some(p => p.id === socket.id)) {
      callback({ ok: true, code });
      return;
    }

    room.players.push(createPlayer(socket.id, cleanName(name)));
    socket.join(code);
    socket.data.room = code;

    callback({ ok: true, code });
    sendLobby(room);
  });

  socket.on("startGame", callback => {
    const room = rooms.get(socket.data.room);
    if (!room || room.host !== socket.id) {
      if (callback) callback({ ok: false, error: "Only the host can start." });
      return;
    }

    if (room.players.length < 2) {
      if (callback) callback({ ok: false, error: "You need at least 2 players." });
      return;
    }

    if (!startRoom(room)) {
      if (callback) callback({ ok: false, error: "Could not start game." });
      return;
    }

    if (callback) callback({ ok: true });
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
    for (const key of allowed) clean[key] = !!input?.[key];

    player.input = clean;
  });

  socket.on("leaveRoom", () => {
    removePlayer(socket);
  });

  socket.on("disconnect", () => {
    removePlayer(socket);
  });
});

function removePlayer(socket) {
  const code = socket.data.room;
  if (!code) return;

  const room = rooms.get(code);
  socket.data.room = null;
  if (!room) return;

  room.players = room.players.filter(p => p.id !== socket.id);

  if (room.players.length === 0) {
    clearInterval(room.timer);
    rooms.delete(code);
    return;
  }

  if (room.host === socket.id) {
    room.host = room.players[0].id;
    io.to(code).emit("notice", "The host left. A new host was selected.");
  }

  if (room.game) {
    room.game.players = room.players;

    const escapees = room.players.filter(p => p.role === "escapee");
    const remaining = escapees.filter(p => p.alive && !p.escaped);

    if (escapees.length && remaining.length === 0) {
      if (escapees.some(p => p.escaped)) {
        endGame(room, "escapees", "The escapees successfully escaped!");
      } else {
        endGame(room, "hunter", "The Hunter caught everyone.");
      }
    }
  }

  sendLobby(room);
}

server.listen(PORT, () => {
  console.log(`DEAD BY STEINLIGHT running on port ${PORT}`);
});
