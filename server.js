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
    origin: "*", // Разрешаем запросы с GitHub Pages
    methods: ["GET", "POST"]
  }
});

const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`Подключился игрок: ${socket.id}`);

  socket.on('joinRoom', (roomId) => {
    socket.join(roomId);
    
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        chess: new Chess(),
        players: { w: socket.id, b: null }
      });
      socket.emit('playerColor', 'w');
    } else {
      const room = rooms.get(roomId);
      if (!room.players.b && room.players.w !== socket.id) {
        room.players.b = socket.id;
        socket.emit('playerColor', 'b');
        io.to(roomId).emit('gameStart', room.chess.fen());
      } else {
        socket.emit('playerColor', 'spectator');
        socket.emit('syncBoard', room.chess.fen());
      }
    }
  });

  socket.on('makeMove', ({ roomId, move }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const turn = room.chess.turn();
    if ((turn === 'w' && room.players.w !== socket.id) || 
        (turn === 'b' && room.players.b !== socket.id)) {
      return; // Не ваш ход
    }

    try {
      const result = room.chess.move(move);
      if (result) {
        io.to(roomId).emit('moveMade', {
          fen: room.chess.fen(),
          gameOver: room.chess.isGameOver(),
          inCheck: room.chess.inCheck(),
          turn: room.chess.turn()
        });
      }
    } catch (e) {
      // Некорректный ход игнорируется
    }
  });

  socket.on('resetGame', (roomId) => {
    const room = rooms.get(roomId);
    if (room && (room.players.w === socket.id || room.players.b === socket.id)) {
      room.chess.reset();
      io.to(roomId).emit('syncBoard', room.chess.fen());
    }
  });

  socket.on('disconnect', () => {
    console.log(`Отключился игрок: ${socket.id}`);
    rooms.forEach((room, roomId) => {
      if (room.players.w === socket.id || room.players.b === socket.id) {
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
