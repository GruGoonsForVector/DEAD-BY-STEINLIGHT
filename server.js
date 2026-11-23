
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.get("/", (req, res) => res.send("EPSTEIN multiplayer server online"));

const rooms = new Map();
const WIDTH = 1200;
const HEIGHT = 900;
const REQUIRED = 5;

const obstacles = [
  {x:180,y:120,w:180,h:130},
  {x:760,y:100,w:210,h:150},
  {x:170,y:650,w:200,h:130},
  {x:770,y:650,w:210,h:130},
  {x:480,y:290,w:100,h:100},
  {x:650,y:510,w:100,h:100}
];

function code() {
  return crypto.randomBytes(3).toString("hex").slice(0,5).toUpperCase();
}

function newItems() {
  return [
    {id:0,x:120,y:300,taken:false},
    {id:1,x:450,y:150,taken:false},
    {id:2,x:900,y:330,taken:false},
    {id:3,x:390,y:720,taken:false},
    {id:4,x:1050,y:700,taken:false}
  ];
}

function publicRoom(r) {
  return {
    code:r.code,
    host:r.host,
    players:[...r.players.values()].map(p=>({
      id:p.id,
      name:p.name,
      role:p.role,
      caught:p.caught,
      escaped:p.escaped
    }))
  };
}

function lobby(r) {
  io.to(r.code).emit("lobbyUpdate",publicRoom(r));
}

function createPlayer(id,name) {
  return {
    id,
    name:String(name||"Player").slice(0,16),
    role:"survivor",
    x:100+Math.random()*180,
    y:100+Math.random()*180,
    stamina:100,
    caught:false,
    escaped:false,
    input:{}
  };
}

function startMatch(r) {
  if(r.players.size<2)return false;

  const players=[...r.players.values()];
  const hunter=players[Math.floor(Math.random()*players.length)];

  players.forEach((p,i)=>{
    p.role=p.id===hunter.id?"hunter":"survivor";
    p.caught=false;
    p.escaped=false;
    p.stamina=100;
    p.input={};
    p.x=p.role==="hunter"?600:100+(i*65);
    p.y=p.role==="hunter"?450:150+(i*75);
  });

  r.items=newItems();
  r.evidence=0;
  r.status="playing";
  r.ended=false;
  r.endMessage="";
  return true;
}

function state(r) {
  return {
    code:r.code,
    status:r.status,
    players:[...r.players.values()].map(p=>({
      id:p.id,
      name:p.name,
      role:p.role,
      x:p.x,
      y:p.y,
      stamina:p.stamina,
      caught:p.caught,
      escaped:p.escaped
    })),
    items:r.items,
    obstacles,
    evidence:r.evidence,
    required:REQUIRED
  };
}

function broadcast(r) {
  io.to(r.code).emit("gameState",state(r));
}

function endMatch(r,message) {
  if(r.ended)return;
  r.ended=true;
  r.status="ended";
  r.endMessage=message;
  io.to(r.code).emit("matchEnded",{message});
  setTimeout(()=>{
    if(!rooms.has(r.code))return;
    r.status="lobby";
    r.ended=false;
    r.players.forEach(p=>{
      p.role="survivor";
      p.caught=false;
      p.escaped=false;
    });
    io.to(r.code).emit("returnedToLobby");
    lobby(r);
  },6000);
}

function collides(x,y) {
  const radius=14;
  if(x<radius||y<radius||x>WIDTH-radius||y>HEIGHT-radius)return true;
  return obstacles.some(o=>
    x+radius>o.x&&x-radius<o.x+o.w&&
    y+radius>o.y&&y-radius<o.y+o.h
  );
}

function distance(a,b) {
  return Math.hypot(a.x-b.x,a.y-b.y);
}

io.on("connection",socket=>{
  socket.on("createRoom",data=>{
    let roomCode;
    do { roomCode=code(); } while(rooms.has(roomCode));

    const r={
      code:roomCode,
      host:socket.id,
      players:new Map(),
      status:"lobby",
      items:[],
      evidence:0,
      ended:false
    };

    r.players.set(socket.id,createPlayer(socket.id,data.name));
    rooms.set(roomCode,r);
    socket.join(roomCode);
    socket.data.room=roomCode;

    socket.emit("roomCreated",publicRoom(r));
    lobby(r);
  });

  socket.on("joinRoom",data=>{
    const roomCode=String(data.code||"").toUpperCase();
    const r=rooms.get(roomCode);

    if(!r)return socket.emit("errorMessage","Room not found.");
    if(r.status!=="lobby")return socket.emit("errorMessage","Match already started.");
    if(r.players.size>=5)return socket.emit("errorMessage","Room is full.");

    r.players.set(socket.id,createPlayer(socket.id,data.name));
    socket.join(roomCode);
    socket.data.room=roomCode;

    socket.emit("roomJoined",publicRoom(r));
    lobby(r);
  });

  socket.on("getLobby",()=>{
    const r=rooms.get(socket.data.room);
    if(r)socket.emit("lobbyUpdate",publicRoom(r));
  });

  socket.on("startGame",()=>{
    const r=rooms.get(socket.data.room);
    if(!r)return;
    if(r.host!==socket.id)return socket.emit("errorMessage","Only the host can start.");
    if(r.status!=="lobby")return;
    if(!startMatch(r))return socket.emit("errorMessage","Need at least two players.");
    broadcast(r);
  });

  socket.on("input",input=>{
    const r=rooms.get(socket.data.room);
    if(!r||r.status!=="playing")return;
    const p=r.players.get(socket.id);
    if(!p||p.caught||p.escaped)return;

    p.input={
      up:!!input.up,
      down:!!input.down,
      left:!!input.left,
      right:!!input.right,
      sprint:!!input.sprint
    };
  });

  socket.on("interact",()=>{
    const r=rooms.get(socket.data.room);
    if(!r||r.status!=="playing"||r.ended)return;
    const p=r.players.get(socket.id);
    if(!p||p.role!=="survivor"||p.caught||p.escaped)return;

    if(r.evidence>=REQUIRED&&p.x>1080&&p.y>370&&p.y<510){
      p.escaped=true;
      const survivors=[...r.players.values()].filter(x=>x.role==="survivor");
      const escaped=survivors.filter(x=>x.escaped).length;
      if(escaped>=1){
        endMatch(r,"THE INVESTIGATORS ESCAPED!");
      } else broadcast(r);
      return;
    }

    const item=r.items.find(e=>!e.taken&&Math.hypot(e.x-p.x,e.y-p.y)<45);
    if(item){
      item.taken=true;
      r.evidence++;
      broadcast(r);
    }
  });

  socket.on("leaveRoom",()=>{
    removePlayer(socket);
  });

  function removePlayer(s){
    const roomCode=s.data.room;
    const r=rooms.get(roomCode);
    if(!r)return;
    r.players.delete(s.id);
    s.leave(roomCode);
    s.data.room=null;

    if(r.players.size===0){
      rooms.delete(roomCode);
      return;
    }

    if(r.host===s.id){
      r.host=r.players.keys().next().value;
    }

    lobby(r);
  }

  socket.on("disconnect",()=>removePlayer(socket));
});

setInterval(()=>{
  for(const r of rooms.values()){
    if(r.status!=="playing"||r.ended)continue;

    const players=[...r.players.values()];
    const hunter=players.find(p=>p.role==="hunter");

    for(const p of players){
      if(p.caught||p.escaped)continue;

      const input=p.input;
      let dx=(input.right?1:0)-(input.left?1:0);
      let dy=(input.down?1:0)-(input.up?1:0);

      const length=Math.hypot(dx,dy)||1;
      dx/=length;
      dy/=length;

      const sprint=p.role==="survivor"&&input.sprint&&p.stamina>0&&(dx!==0||dy!==0);
      const speed=p.role==="hunter"?2.8:sprint?3.8:2.5;

      if(sprint)p.stamina=Math.max(0,p.stamina-0.8);
      else p.stamina=Math.min(100,p.stamina+0.35);

      const nx=p.x+dx*speed;
      const ny=p.y+dy*speed;

      if(!collides(nx,p.y))p.x=nx;
      if(!collides(p.x,ny))p.y=ny;

      if(p.role==="survivor"&&hunter&&!hunter.caught){
        if(distance(p,hunter)<27){
          p.caught=true;
          const remaining=players.filter(x=>x.role==="survivor"&&!x.caught&&!x.escaped);
          if(remaining.length===0){
            endMatch(r,"EPSTEIN WINS. NO INVESTIGATORS ESCAPED.");
          }
        }
      }
    }

    broadcast(r);
  }
},50);

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log("EPSTEIN server running on "+PORT));
