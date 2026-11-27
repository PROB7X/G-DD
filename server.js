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

let waitingPlayer = null;
const rooms = new Map();

io.on('connection', (socket) => {
  // Поиск соперника
  socket.on('findMatch', ({ nickname }) => {
    const playerName = nickname || 'Игрок';

    if (waitingPlayer && waitingPlayer.id !== socket.id) {
      const opponent = waitingPlayer;
      waitingPlayer = null;

      const roomId = `match_${opponent.id}_${socket.id}`;
      socket.join(roomId);
      opponent.socket.join(roomId);

      const players = {
        w: { id: opponent.id, name: opponent.name },
        b: { id: socket.id, name: playerName }
      };

      const chess = new Chess();
      rooms.set(roomId, { chess, players });

      opponent.socket.emit('matchFound', { roomId, color: 'w', players, fen: chess.fen() });
      socket.emit('matchFound', { roomId, color: 'b', players, fen: chess.fen() });
    } else {
      waitingPlayer = { id: socket.id, name: playerName, socket };
    }
  });

  // Отмена поиска
  socket.on('cancelSearch', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
    }
  });

  // Ход игрока
  socket.on('makeMove', ({ roomId, move }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const turn = room.chess.turn();
    if ((turn === 'w' && room.players.w.id !== socket.id) || 
        (turn === 'b' && room.players.b.id !== socket.id)) {
      return;
    }

    try {
      const result = room.chess.move(move);
      if (result) {
        io.to(roomId).emit('moveMade', { fen: room.chess.fen() });
      }
    } catch (e) {}
  });

  // Выход из игры
  socket.on('leaveMatch', (roomId) => {
    handleLeave(socket, roomId);
  });

  socket.on('disconnect', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
    }
    rooms.forEach((room, roomId) => {
      if (room.players.w.id === socket.id || room.players.b.id === socket.id) {
        handleLeave(socket, roomId);
      }
    });
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
