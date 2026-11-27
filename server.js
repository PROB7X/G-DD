const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const { Chess } = require('chess.js');

const app = express();
app.use(cors());
app.use('/chess', express.static(path.join(__dirname, 'node_modules/chess.js/dist/esm')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const onlineUsers = new Map(); // socket.id -> { id, name, level, status }
const queue = []; // [{ id, name, level, socket }]
const privateLobbies = new Map(); // code -> { hostSocket, hostName, hostLevel }
const rooms = new Map(); // roomId -> { chess, players }

function broadcastUsers() {
  const list = Array.from(onlineUsers.values()).filter(u => u.status === 'idle');
  io.emit('onlineUsersList', list);
}

function startMatch(sockW, nameW, lvlW, sockB, nameB, lvlB) {
  const roomId = `match_${sockW.id}_${sockB.id}_${Date.now()}`;
  sockW.join(roomId);
  sockB.join(roomId);

  if (onlineUsers.has(sockW.id)) onlineUsers.get(sockW.id).status = 'playing';
  if (onlineUsers.has(sockB.id)) onlineUsers.get(sockB.id).status = 'playing';
  broadcastUsers();

  const players = {
    w: { id: sockW.id, name: nameW, level: lvlW },
    b: { id: sockB.id, name: nameB, level: lvlB }
  };

  const chess = new Chess();
  rooms.set(roomId, { chess, players });

  sockW.emit('matchFound', { roomId, color: 'w', players, fen: chess.fen() });
  sockB.emit('matchFound', { roomId, color: 'b', players, fen: chess.fen() });
}

io.on('connection', (socket) => {
  socket.on('registerUser', ({ nickname, level }) => {
    onlineUsers.set(socket.id, {
      id: socket.id,
      name: nickname || 'Игрок',
      level: level || 1,
      status: 'idle'
    });
    broadcastUsers();
  });

  // Умный подбор по уровню
  socket.on('findMatch', ({ nickname, level }) => {
    const name = nickname || 'Игрок';
    const lvl = level || 1;
    if (onlineUsers.has(socket.id)) {
      onlineUsers.get(socket.id).name = name;
      onlineUsers.get(socket.id).level = lvl;
      onlineUsers.get(socket.id).status = 'searching';
      broadcastUsers();
    }

    const existingIdx = queue.findIndex(p => p.id === socket.id);
    if (existingIdx !== -1) queue.splice(existingIdx, 1);

    if (queue.length > 0) {
      // Ищем соперника с минимальной разницей в уровне
      let bestIdx = 0;
      let minDiff = Math.abs(queue[0].level - lvl);
      for (let i = 1; i < queue.length; i++) {
        const diff = Math.abs(queue[i].level - lvl);
        if (diff < minDiff) {
          minDiff = diff;
          bestIdx = i;
        }
      }
      const opponent = queue.splice(bestIdx, 1)[0];
      startMatch(opponent.socket, opponent.name, opponent.level, socket, name, lvl);
    } else {
      queue.push({ id: socket.id, name, level: lvl, socket });
    }
  });

  socket.on('cancelSearch', () => {
    const idx = queue.findIndex(p => p.id === socket.id);
    if (idx !== -1) queue.splice(idx, 1);
    if (onlineUsers.has(socket.id)) {
      onlineUsers.get(socket.id).status = 'idle';
      broadcastUsers();
    }
  });

  // Прямой вызов игрока онлайн
  socket.on('sendChallenge', ({ targetId, nickname, level }) => {
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket && onlineUsers.get(targetId)?.status === 'idle') {
      targetSocket.emit('receiveChallenge', {
        fromId: socket.id,
        fromName: nickname || 'Игрок',
        fromLevel: level || 1
      });
    }
  });

  socket.on('acceptChallenge', ({ fromId, nickname, level }) => {
    const challengerSocket = io.sockets.sockets.get(fromId);
    const challengerUser = onlineUsers.get(fromId);
    if (challengerSocket && challengerUser && challengerUser.status === 'idle') {
      startMatch(
        challengerSocket, challengerUser.name, challengerUser.level,
        socket, nickname || 'Игрок', level || 1
      );
    } else {
      socket.emit('challengeError', 'Игрок уже в матче или вышел из сети');
    }
  });

  socket.on('declineChallenge', ({ fromId }) => {
    const challengerSocket = io.sockets.sockets.get(fromId);
    if (challengerSocket) challengerSocket.emit('challengeDeclined');
  });

  // Приватные лобби по коду
  socket.on('createPrivateLobby', ({ code, nickname, level }) => {
    const cleanCode = (code || Math.floor(1000 + Math.random() * 9000).toString()).toUpperCase();
    if (privateLobbies.has(cleanCode)) {
      socket.emit('lobbyError', 'Этот код уже занят');
      return;
    }
    privateLobbies.set(cleanCode, {
      hostSocket: socket,
      hostName: nickname || 'Игрок',
      hostLevel: level || 1
    });
    if (onlineUsers.has(socket.id)) {
      onlineUsers.get(socket.id).status = 'lobby';
      broadcastUsers();
    }
    socket.emit('privateLobbyCreated', cleanCode);
  });

  socket.on('joinPrivateLobby', ({ code, nickname, level }) => {
    const cleanCode = (code || '').trim().toUpperCase();
    const lobby = privateLobbies.get(cleanCode);
    if (!lobby) {
      socket.emit('lobbyError', 'Комната с таким кодом не найдена');
      return;
    }
    if (lobby.hostSocket.id === socket.id) return;
    privateLobbies.delete(cleanCode);
    startMatch(
      lobby.hostSocket, lobby.hostName, lobby.hostLevel,
      socket, nickname || 'Игрок', level || 1
    );
  });

  socket.on('cancelPrivateLobby', (code) => {
    if (code && privateLobbies.get(code)?.hostSocket.id === socket.id) {
      privateLobbies.delete(code);
    }
    if (onlineUsers.has(socket.id)) {
      onlineUsers.get(socket.id).status = 'idle';
      broadcastUsers();
    }
  });

  // Ходы и завершение игры
  socket.on('makeMove', ({ roomId, move }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const turn = room.chess.turn();
    if ((turn === 'w' && room.players.w.id !== socket.id) || 
        (turn === 'b' && room.players.b.id !== socket.id)) return;

    try {
      const result = room.chess.move(move);
      if (result) {
        io.to(roomId).emit('moveMade', { fen: room.chess.fen() });
      }
    } catch (e) {}
  });

  socket.on('leaveMatch', (roomId) => {
    handleLeave(socket, roomId);
    if (onlineUsers.has(socket.id)) {
      onlineUsers.get(socket.id).status = 'idle';
      broadcastUsers();
    }
  });

  socket.on('disconnect', () => {
    const qIdx = queue.findIndex(p => p.id === socket.id);
    if (qIdx !== -1) queue.splice(qIdx, 1);

    privateLobbies.forEach((val, key) => {
      if (val.hostSocket.id === socket.id) privateLobbies.delete(key);
    });

    rooms.forEach((room, roomId) => {
      if (room.players.w.id === socket.id || room.players.b.id === socket.id) {
        handleLeave(socket, roomId);
      }
    });

    onlineUsers.delete(socket.id);
    broadcastUsers();
  });

  function handleLeave(sock, roomId) {
    if (rooms.has(roomId)) {
      sock.to(roomId).emit('opponentLeft');
      rooms.delete(roomId);
    }
  }
});

const PORT = 3030;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на http://103.82.102.226:${PORT}`);
});
