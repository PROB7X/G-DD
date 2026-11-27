const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Chess } = require('chess.js');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const rooms = new Map();

io.on('connection', (socket) => {
  socket.on('joinRoom', ({ roomId, nickname }) => {
    socket.join(roomId);
    const playerName = nickname || 'Игрок';
    
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        chess: new Chess(),
        players: {
          w: { id: socket.id, name: playerName },
          b: null
        }
      });
      socket.emit('playerColor', { color: 'w', players: rooms.get(roomId).players });
    } else {
      const room = rooms.get(roomId);
      if (!room.players.b && room.players.w?.id !== socket.id) {
        room.players.b = { id: socket.id, name: playerName };
        socket.emit('playerColor', { color: 'b', players: room.players });
        io.to(roomId).emit('gameStart', { fen: room.chess.fen(), players: room.players });
      } else {
        socket.emit('playerColor', { color: 'spectator', players: room.players });
        socket.emit('syncBoard', { fen: room.chess.fen(), players: room.players });
      }
    }
  });

  socket.on('makeMove', ({ roomId, move }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const turn = room.chess.turn();
    if ((turn === 'w' && room.players.w?.id !== socket.id) || 
        (turn === 'b' && room.players.b?.id !== socket.id)) {
      return;
    }

    try {
      const result = room.chess.move(move);
      if (result) {
        io.to(roomId).emit('moveMade', { fen: room.chess.fen() });
      }
    } catch (e) {}
  });

  socket.on('resetGame', (roomId) => {
    const room = rooms.get(roomId);
    if (room && (room.players.w?.id === socket.id || room.players.b?.id === socket.id)) {
      room.chess.reset();
      io.to(roomId).emit('syncBoard', { fen: room.chess.fen(), players: room.players });
    }
  });

  socket.on('disconnect', () => {
    rooms.forEach((room, roomId) => {
      if (room.players.w?.id === socket.id || room.players.b?.id === socket.id) {
        io.to(roomId).emit('playerDisconnected');
        rooms.delete(roomId);
      }
    });
  });
});

const PORT = 3030;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Шахматный сервер запущен на порту ${PORT}`);
});
