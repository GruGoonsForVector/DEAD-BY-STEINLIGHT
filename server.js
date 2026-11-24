
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"]
});

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));
app.get("/", (req, res) => res.sendFile(__dirname + "/index.html"));
app.get("/health", (req, res) => res.json({ status: "ok" }));

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
  { id: "basement", name: "Basement Exit", x: 1000, y: 700 },
  { id: "engine", name: "Boat Engine", x: 2200, y: 1900 },
  { id: "hull", name: "Boat Hull", x: 2480, y: 1900 },
  { id: "electrics", name: "Boat Electrics", x: 2350, y: 1700 }
];

const fuelTemplate = [
  { id: "fuel1", x: 450, y: 950 },
  { id: "fuel2", x: 1900, y: 950 }
];

const rooms = new Map();

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function makeCode() {
  let code;
  do {
    code = crypto.randomBytes(3).toString("hex").toUpperCase();
  } while (rooms.has(code));
  return code;
}

function makePlayer(socket, name) {
  return {
    id: socket.id,
    name: String(name).slice(0, 18),
    role: "escapee",
    x: 300,
    y: 500,
    alive: true,
    escaped: false,
    hidden: false,
    hiddenIn: null,
    stamina: 100,
    pulse: 0,
    pulseCooldown: 0,
    disruptCooldown: 0,
    input: {},
    previous: {},
    notice: ""
  };
}

function makeRoom(code, hostId) {
  return {
    code,
    hostId,
    players: [],
    game: null
  };
}

function lobbyData(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name
    })),
    maxPlayers: 5,
    started: !!room.game && !room.game.ended
  };
}

function updateLobby(room) {
  io.to(room.code).emit("lobbyUpdate", lobbyData(room));
}

function notice(player, message) {
  io.to(player.id).emit("notice", message);
}

function circleRectCollision(x, y, radius, rect) {
  const closestX = Math.max(rect.x, Math.min(x, rect.x + rect.w));
  const closestY = Math.max(rect.y, Math.min(y, rect.y + rect.h));
  return Math.hypot(x - closestX, y - closestY) < radius;
}

function canMoveTo(x, y) {
  const r = 18;

  if (
    x < r || y < r ||
    x > MAP.width - r ||
    y > MAP.height - r
  ) return false;

  return !obstacles.some(o => circleRectCollision(x, y, r, o));
}

function movePlayer(p, dx, dy, speed) {
  const length = Math.hypot(dx, dy);
  if (!length) return;

  dx /= length;
  dy /= length;

  const nx = p.x + dx * speed;
  const ny = p.y + dy * speed;

  if (canMoveTo(nx, p.y)) p.x = nx;
  if (canMoveTo(p.x, ny)) p.y = ny;
}

function makeGame(room) {
  const players = room.players.map(p => ({
    ...p,
    role: "escapee",
    x: 300 + Math.random() * 500,
    y: 400 + Math.random() * 500,
    alive: true,
    escaped: false,
    hidden: false,
    hiddenIn: null,
    stamina: 100,
    pulse: 0,
    pulseCooldown: 0,
    disruptCooldown: 0,
    input: {},
    previous: {}
  }));

  const hunter = players[Math.floor(Math.random() * players.length)];
  hunter.role = "hunter";
  hunter.name = "EPSTEIN";
  hunter.x = 1350;
  hunter.y = 1050;

  return {
    players,
    tasks: stationTemplate.map(t => ({
      ...t,
      progress: 0
    })),
    fuel: fuelTemplate.map(f => ({
      ...f,
      collected: false
    })),
    time: 0,
    ended: false,
    winner: null
  };
}

function objectivesComplete(game) {
  return (
    game.tasks.every(t => t.progress >= 100) &&
    game.fuel.every(f => f.collected)
  );
}

function endGame(room, winner, reason) {
  if (!room.game || room.game.ended) return;

  room.game.ended = true;
  room.game.winner = winner;

  io.to(room.code).emit("gameOver", {
    winner,
    reason
  });

  updateLobby(room);
}

function stateFor(viewer, game) {
  const hunter = viewer.role === "hunter";

  return {
    time: game.time,
    map: MAP,
    tasks: game.tasks,
    fuel: game.fuel,
    objectivesComplete: objectivesComplete(game),
    players: game.players.map(p => {
      const teammate = p.role === viewer.role;
      const revealToHunter =
        hunter && viewer.pulse > 0 &&
        p.role === "escapee" && p.alive && !p.escaped;

      const visible =
        p.id === viewer.id ||
        teammate ||
        revealToHunter;

      return {
        id: p.id,
        name: p.name,
        role: p.role,
        x: visible ? p.x : null,
        y: visible ? p.y : null,
        alive: p.alive,
        escaped: p.escaped,
        hidden: p.hidden,
        stamina: p.stamina,
        pulse: p.pulse,
        pulseCooldown: p.pulseCooldown
      };
    })
  };
}

function broadcastState(room) {
  if (!room.game || room.game.ended) return;

  for (const player of room.game.players) {
    io.to(player.id).volatile.emit(
      "state",
      stateFor(player, room.game)
    );
  }
}

function startRoom(room) {
  if (room.players.length < 2) {
    io.to(room.code).emit("notice", "You need at least 2 players.");
    return;
  }

  if (room.players.length > 5) return;

  room.game = makeGame(room);

  const hunter = room.game.players.find(p => p.role === "hunter");

  for (const player of room.game.players) {
    io.to(player.id).emit("gameStarted", {
      hunterId: hunter.id,
      state: stateFor(player, room.game)
    });
  }

  broadcastState(room);
  updateLobby(room);
}

function eliminate(room, target, message) {
  if (!target || !target.alive || target.role !== "escapee") return;

  target.alive = false;
  target.hidden = false;
  target.hiddenIn = null;
  target.input = {};

  io.to(room.code).emit("notice", message);
}

function handleHunter(room, game, p) {
  const input = p.input;
  const old = p.previous;

  let dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  let dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);

  let speed = input.sprint && p.stamina > 0 ? 5.8 : 3.5;

  if (input.sprint && p.stamina > 0) {
    p.stamina = Math.max(0, p.stamina - 0.65);
  } else {
    p.stamina = Math.min(100, p.stamina + 0.35);
  }

  movePlayer(p, dx, dy, speed);

  if (input.pulse && !old.pulse && p.pulseCooldown <= 0) {
    p.pulse = 180;
    p.pulseCooldown = 360;
    notice(p, "Tracking pulse activated.");
  }

  if (input.disrupt && !old.disrupt && p.disruptCooldown <= 0) {
    const task = game.tasks
      .filter(t => t.progress > 0)
      .sort((a, b) => distance(p, a) - distance(p, b))[0];

    if (task && distance(p, task) < 180) {
      task.progress = Math.max(0, task.progress - 25);
      p.disruptCooldown = 240;
      notice(p, `You disrupted ${task.name}.`);
    } else {
      notice(p, "No repair station nearby.");
    }
  }

  if (input.search && !old.search) {
    const locker = hidingSpots
      .filter(s => s.type === "Locker")
      .sort((a, b) => distance(p, a) - distance(p, b))[0];

    if (locker && distance(p, locker) < 95) {
      const victim = game.players.find(target =>
        target.role === "escapee" &&
        target.alive &&
        target.hidden &&
        target.hiddenIn === locker.id
      );

      if (victim) {
        eliminate(room, victim, `${victim.name} was found by the Hunter!`);
      } else {
        notice(p, "The locker is empty.");
      }
    } else {
      notice(p, "Move closer to a locker to search it.");
    }
  }

  for (const target of game.players) {
    if (
      target.role === "escapee" &&
      target.alive &&
      !target.hidden &&
      distance(p, target) < 48
    ) {
      eliminate(room, target, `${target.name} was caught!`);
    }
  }

  if (p.pulse > 0) p.pulse--;
  if (p.pulseCooldown > 0) p.pulseCooldown--;
  if (p.disruptCooldown > 0) p.disruptCooldown--;

  p.previous = { ...input };
}

function handleEscapee(room, game, p) {
  const input = p.input;
  const old = p.previous;

  if (input.hide && !old.hide) {
    if (p.hidden) {
      p.hidden = false;
      p.hiddenIn = null;
      notice(p, "You left your hiding place.");
    } else {
      const spot = hidingSpots
        .filter(s => s.type !== "Bush" || true)
        .sort((a, b) => distance(p, a) - distance(p, b))[0];

      if (spot && distance(p, spot) < 65) {
        p.hidden = true;
        p.hiddenIn = spot.id;
        p.x = spot.x;
        p.y = spot.y;
        notice(p, `Hiding in ${spot.type.toLowerCase()}.`);
      } else {
        notice(p, "Move closer to a hiding place.");
      }
    }
  }

  if (!p.hidden) {
    let speed = input.crouch ? 1.5 : 2.9;

    if (input.sprint && p.stamina > 0) {
      speed = 4.3;
      p.stamina = Math.max(0, p.stamina - 0.7);
    } else {
      p.stamina = Math.min(100, p.stamina + 0.45);
    }

    const dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);

    movePlayer(p, dx, dy, speed);
  } else {
    p.stamina = Math.min(100, p.stamina + 0.5);
  }

  if (input.interact && !p.hidden) {
    const task = game.tasks
      .filter(t => t.progress < 100)
      .sort((a, b) => distance(p, a) - distance(p, b))[0];

    if (task && distance(p, task) < 95) {
      task.progress = Math.min(100, task.progress + 0.18);
    }

    const fuel = game.fuel.find(f =>
      !f.collected && distance(p, f) < 65
    );

    if (fuel) {
      fuel.collected = true;
      io.to(room.code).emit("notice", `${p.name} collected a fuel can.`);
    }

    if (
      objectivesComplete(game) &&
      Math.hypot(p.x - 2350, p.y - 1850) < 150
    ) {
      p.escaped = true;
      p.alive = false;
      p.hidden = false;
      p.hiddenIn = null;

      io.to(room.code).emit("notice", `${p.name} escaped by boat!`);
    }
  }

  p.previous = { ...input };
}

function tickRoom(room) {
  const game = room.game;
  if (!game || game.ended) return;

  game.time++;

  for (const p of game.players) {
    if (!p.alive || p.escaped) continue;

    if (p.role === "hunter") {
      handleHunter(room, game, p);
    } else {
      handleEscapee(room, game, p);
    }
  }

  const hunter = game.players.find(p => p.role === "hunter");
  const escapees = game.players.filter(p => p.role === "escapee");
  const living = escapees.filter(p => p.alive && !p.escaped);
  const escaped = escapees.filter(p => p.escaped);

  if (!hunter || !room.players.some(p => p.id === hunter.id)) {
    endGame(room, "escapees", "The Hunter disconnected.");
    return;
  }

  if (living.length === 0) {
    if (escaped.length > 0) {
      endGame(room, "escapees", "The surviving escapees got away!");
    } else {
      endGame(room, "hunter", "The Hunter caught everyone!");
    }
    return;
  }

  if (game.time % 2 === 0) broadcastState(room);
}

function removePlayer(socket, room) {
  if (!room) return;

  room.players = room.players.filter(p => p.id !== socket.id);

  if (room.hostId === socket.id && room.players.length > 0) {
    room.hostId = room.players[0].id;
  }

  if (room.game) {
    room.game.players = room.game.players.filter(p => p.id !== socket.id);

    const hunterLeft = !room.game.players.some(p => p.role === "hunter");

    if (hunterLeft) {
      endGame(room, "escapees", "The Hunter disconnected.");
    } else {
      const escapees = room.game.players.filter(p => p.role === "escapee");
      const living = escapees.filter(p => p.alive && !p.escaped);

      if (escapees.length > 0 && living.length === 0) {
        endGame(room, "hunter", "The Hunter caught everyone.");
      }
    }
  }

  socket.leave(room.code);

  if (room.players.length === 0) {
    rooms.delete(room.code);
  } else {
    updateLobby(room);
  }
}

io.on("connection", socket => {
  socket.on("createRoom", data => {
    const name = String(data?.name || "").trim().slice(0, 18);

    if (!name) {
      socket.emit("notice", "Enter a name first.");
      return;
    }

    const code = makeCode();
    const room = makeRoom(code, socket.id);
    const player = makePlayer(socket, name);

    room.players.push(player);
    rooms.set(code, room);

    socket.join(code);
    socket.data.roomCode = code;

    socket.emit("roomCreated", {
      code,
      hostId: room.hostId,
      players: room.players.map(p => ({ id: p.id, name: p.name }))
    });

    updateLobby(room);
  });

  socket.on("joinRoom", data => {
    const name = String(data?.name || "").trim().slice(0, 18);
    const code = String(data?.code || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!name) {
      socket.emit("notice", "Enter a name first.");
      return;
    }

    if (!room) {
      socket.emit("notice", "Room not found.");
      return;
    }

    if (room.game && !room.game.ended) {
      socket.emit("notice", "That game has already started.");
      return;
    }

    if (room.players.length >= 5) {
      socket.emit("notice", "That room is full.");
      return;
    }

    if (room.players.some(p => p.id === socket.id)) return;

    room.players.push(makePlayer(socket, name));
    socket.join(code);
    socket.data.roomCode = code;

    socket.emit("roomJoined", {
      code,
      hostId: room.hostId
    });

    updateLobby(room);
  });

  socket.on("startGame", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (room.game && !room.game.ended) return;

    startRoom(room);
  });

  socket.on("input", data => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.game || room.game.ended) return;

    const player = room.game.players.find(p => p.id === socket.id);
    if (!player || !player.alive || player.escaped) return;

    const allowed = [
      "up", "down", "left", "right",
      "sprint", "crouch", "interact", "hide",
      "pulse", "disrupt", "search"
    ];

    const clean = {};

    for (const key of allowed) {
      clean[key] = data && data[key] === true;
    }

    // Role-specific input filtering.
    if (player.role === "hunter") {
      clean.crouch = false;
      clean.interact = false;
      clean.hide = false;
    } else {
      clean.pulse = false;
      clean.disrupt = false;
      clean.search = false;
    }

    player.input = clean;
  });

  socket.on("leaveRoom", () => {
    const room = rooms.get(socket.data.roomCode);
    removePlayer(socket, room);
    socket.data.roomCode = null;
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomCode);
    removePlayer(socket, room);
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    tickRoom(room);
  }
}, 1000 / 30);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`DEAD BY STEINLIGHT running on port ${PORT}`);
});
