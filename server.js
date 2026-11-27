const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const secret = JSON.parse(fs.readFileSync(path.join(__dirname, 'secret.json'), 'utf8'));
app.use(express.static(path.join(__dirname, 'public')));

// Хранилище данных (в памяти)
const users = {};       // socketId -> { id, name, wins, losses, level, inGame, roomId }
const profiles = {};    // name -> { name, wins, losses, level }
const bans = {};        // name -> expireTimestamp (Infinity для перманентного)
let queue = [];         // Очередь подбора
const rooms = {};       // roomId -> { chess, white, black, timers: {w, b}, turnStart, interval, isBot }

function getProfile(name) {
    if (!profiles[name]) {
        profiles[name] = { name, wins: 0, losses: 0, level: 1 };
    }
    return profiles[name];
}

function updateStats(winnerName, loserName) {
    if (winnerName && profiles[winnerName]) {
        profiles[winnerName].wins++;
        profiles[winnerName].level = Math.floor(profiles[winnerName].wins / 3) + 1;
    }
    if (loserName && profiles[loserName]) {
        profiles[loserName].losses++;
    }
}

function broadcastOnline() {
    const list = Object.values(users).map(u => ({
        id: u.id,
        name: u.name,
        level: u.level,
        wins: u.wins,
        losses: u.losses,
        inGame: u.inGame
    }));
    io.emit('online_list', list);
}

// Простейший оценочный ИИ для бота и подсказок
function getBestMove(chess) {
    const moves = chess.moves({ verbose: true });
    if (moves.length === 0) return null;
    const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
    let bestMove = moves[Math.floor(Math.random() * moves.length)];
    let bestScore = -999;

    for (const m of moves) {
        let score = 0;
        if (m.captured) score += values[m.captured] * 10;
        chess.move(m);
        if (chess.inCheck()) score += 2;
        if (chess.isCheckmate()) score += 1000;
        chess.undo();
        if (score > bestScore) {
            bestScore = score;
            bestMove = m;
        }
    }
    return bestMove;
}

function startRoom(whiteSocketId, blackSocketId, isBot = false) {
    const roomId = 'room_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const chess = new Chess();

    rooms[roomId] = {
        id: roomId,
        chess,
        white: whiteSocketId,
        black: isBot ? 'BOT' : blackSocketId,
        timers: { w: 300, b: 300 }, // 5 минут каждому
        isBot,
        interval: null
    };

    if (users[whiteSocketId]) {
        users[whiteSocketId].inGame = true;
        users[whiteSocketId].roomId = roomId;
        io.sockets.sockets.get(whiteSocketId)?.join(roomId);
    }
    if (!isBot && users[blackSocketId]) {
        users[blackSocketId].inGame = true;
        users[blackSocketId].roomId = roomId;
        io.sockets.sockets.get(blackSocketId)?.join(roomId);
    }

    const whiteName = users[whiteSocketId]?.name || 'Игрок';
    const blackName = isBot ? 'Бот (ИИ)' : (users[blackSocketId]?.name || 'Соперник');

    io.to(whiteSocketId).emit('game_start', {
        roomId, color: 'w', fen: chess.fen(),
        opponent: isBot ? { name: 'Бот (ИИ)', level: 1, wins: 0, losses: 0 } : profiles[blackName]
    });

    if (!isBot) {
        io.to(blackSocketId).emit('game_start', {
            roomId, color: 'b', fen: chess.fen(),
            opponent: profiles[whiteName]
        });
    }

    rooms[roomId].interval = setInterval(() => {
        const room = rooms[roomId];
        if (!room) return;
        const turn = room.chess.turn();
        room.timers[turn]--;

        io.to(roomId).emit('timer_update', room.timers);

        if (room.timers[turn] <= 0) {
            endGame(roomId, turn === 'w' ? 'b' : 'w', 'Время вышло');
        }
    }, 1000);

    broadcastOnline();
}

function endGame(roomId, winnerColor, reason) {
    const room = rooms[roomId];
    if (!room) return;
    clearInterval(room.interval);

    const wUser = users[room.white];
    const bUser = room.isBot ? null : users[room.black];

    if (winnerColor === 'w') {
        updateStats(wUser?.name, bUser?.name);
    } else if (winnerColor === 'b') {
        updateStats(bUser?.name, wUser?.name);
    }

    if (wUser) {
        wUser.inGame = false;
        wUser.roomId = null;
        Object.assign(wUser, getProfile(wUser.name));
        io.to(room.white).emit('profile_updated', getProfile(wUser.name));
    }
    if (bUser) {
        bUser.inGame = false;
        bUser.roomId = null;
        Object.assign(bUser, getProfile(bUser.name));
        io.to(room.black).emit('profile_updated', getProfile(bUser.name));
    }

    io.to(roomId).emit('game_over', { winnerColor, reason });
    delete rooms[roomId];
    broadcastOnline();
}
io.on('connection', (socket) => {
    // Проверка имени и авторизация
    socket.on('register_name', ({ name, password }) => {
        const cleanName = String(name || '').trim().slice(0, 16);
        if (!cleanName) return socket.emit('auth_error', 'Введите корректное имя');

        // Проверка бана
        if (bans[cleanName]) {
            if (bans[cleanName] > Date.now()) {
                const left = bans[cleanName] === Infinity ? 'навсегда' : `на ${Math.ceil((bans[cleanName] - Date.now()) / 60000)} мин.`;
                return socket.emit('banned', `Вы заблокированы ${left}`);
            } else {
                delete bans[cleanName];
            }
        }

        // Проверка на админа HELM77ZX
        if (cleanName === secret.adminName) {
            if (!password) {
                return socket.emit('require_admin_password');
            }
            if (password !== secret.adminPassword) {
                return socket.emit('auth_error', 'Неверный пароль администратора');
            }
            socket.isAdmin = true;
            socket.emit('admin_authenticated');
        }

        const prof = getProfile(cleanName);
        users[socket.id] = { id: socket.id, ...prof, inGame: false, roomId: null };
        socket.emit('auth_success', prof);
        broadcastOnline();
    });

    // Смена имени в настройках
    socket.on('change_name', (newName) => {
        const u = users[socket.id];
        if (!u || u.inGame) return;
        const cleanName = String(newName || '').trim().slice(0, 16);
        if (!cleanName || cleanName === secret.adminName) return;

        const prof = getProfile(cleanName);
        users[socket.id] = { id: socket.id, ...prof, inGame: false, roomId: null };
        socket.emit('auth_success', prof);
        broadcastOnline();
    });

    // Просмотр чужого профиля
    socket.on('get_profile', (targetName) => {
        socket.emit('view_profile_data', getProfile(targetName));
    });

    // Поиск игры (Онлайн)
    socket.on('find_match', () => {
        const u = users[socket.id];
        if (!u || u.inGame) return;
        if (!queue.includes(socket.id)) queue.push(socket.id);

        if (queue.length >= 2) {
            const p1 = queue.shift();
            const p2 = queue.shift();
            if (users[p1] && users[p2]) {
                startRoom(p1, p2, false);
            }
        }
    });

    socket.on('cancel_search', () => {
        queue = queue.filter(id => id !== socket.id);
    });

    // Игра с ботом
    socket.on('start_bot', () => {
        const u = users[socket.id];
        if (!u || u.inGame) return;
        startRoom(socket.id, null, true);
    });

    // Вызов на дуэль (Лобби)
    socket.on('send_invite', (targetId) => {
        const sender = users[socket.id];
        const target = users[targetId];
        if (sender && target && !sender.inGame && !target.inGame) {
            io.to(targetId).emit('duel_invite', { fromId: socket.id, fromName: sender.name, level: sender.level });
        }
    });

    socket.on('accept_invite', (fromId) => {
        const p1 = users[fromId];
        const p2 = users[socket.id];
        if (p1 && p2 && !p1.inGame && !p2.inGame) {
            startRoom(fromId, socket.id, false);
        }
    });

    // Ход в партии
    socket.on('make_move', ({ roomId, from, to, promotion }) => {
        const room = rooms[roomId];
        if (!room) return;
        const playerColor = room.white === socket.id ? 'w' : (room.black === socket.id ? 'b' : null);
        if (!playerColor || room.chess.turn() !== playerColor) return;

        try {
            const move = room.chess.move({ from, to, promotion: promotion || 'q' });
            if (move) {
                io.to(roomId).emit('board_update', { fen: room.chess.fen(), turn: room.chess.turn(), lastMove: move });

                if (room.chess.isGameOver()) {
                    const reason = room.chess.isCheckmate() ? 'Мат' : 'Ничья';
                    const winner = room.chess.isCheckmate() ? playerColor : null;
                    return endGame(roomId, winner, reason);
                }

                // Ход бота
                if (room.isBot && room.chess.turn() === 'b') {
                    setTimeout(() => {
                        if (!rooms[roomId]) return;
                        const botMove = getBestMove(room.chess);
                        if (botMove) {
                            room.chess.move(botMove);
                            io.to(roomId).emit('board_update', { fen: room.chess.fen(), turn: room.chess.turn(), lastMove: botMove });
                            if (room.chess.isGameOver()) {
                                const reason = room.chess.isCheckmate() ? 'Мат' : 'Ничья';
                                const winner = room.chess.isCheckmate() ? 'b' : null;
                                endGame(roomId, winner, reason);
                            }
                        }
                    }, 600);
                }
            }
        } catch (e) {}
    });

    // Сдача / Выход из партии
    socket.on('leave_game', () => {
        const u = users[socket.id];
        if (u && u.inGame && u.roomId) {
            const room = rooms[u.roomId];
            if (room) {
                const winner = room.white === socket.id ? 'b' : 'w';
                endGame(u.roomId, winner, 'Соперник покинул партию');
            }
        }
    });

    // --- АДМИН ФУНКЦИИ ---
    socket.on('admin_action', (data) => {
        if (data.password !== secret.adminPassword && !socket.isAdmin) return;

        if (data.type === 'ban') {
            bans[data.targetName] = Infinity;
            const targetSocket = Object.values(users).find(u => u.name === data.targetName);
            if (targetSocket) {
                io.to(targetSocket.id).emit('banned', 'Вы заблокированы администратором навсегда.');
                io.sockets.sockets.get(targetSocket.id)?.disconnect();
            }
        }
        else if (data.type === 'temp_ban') {
            const mins = parseInt(data.minutes) || 10;
            bans[data.targetName] = Date.now() + mins * 60000;
            const targetSocket = Object.values(users).find(u => u.name === data.targetName);
            if (targetSocket) {
                io.to(targetSocket.id).emit('banned', `Временный бан на ${mins} мин.`);
                io.sockets.sockets.get(targetSocket.id)?.disconnect();
            }
        }
        else if (data.type === 'spawn_piece') {
            const room = Object.values(rooms);
            if (room) {
                room.chess.put({ type: data.piece, color: data.color }, data.square);
                io.to(room.id).emit('board_update', { fen: room.chess.fen(), turn: room.chess.turn() });
            }
        }
        else if (data.type === 'remove_piece') {
            const room = Object.values(rooms);
            if (room) {
                room.chess.remove(data.square);
                io.to(room.id).emit('board_update', { fen: room.chess.fen(), turn: room.chess.turn() });
            }
        }
        else if (data.type === 'ai_hint') {
            const room = Object.values(rooms);
            if (room) {
                const best = getBestMove(room.chess);
                socket.emit('admin_hint_result', best ? `${best.from} -> ${best.to}` : 'Нет ходов');
            }
        }
    });

    socket.on('disconnect', () => {
        queue = queue.filter(id => id !== socket.id);
        const u = users[socket.id];
        if (u && u.inGame && u.roomId) {
            const room = rooms[u.roomId];
            if (room) {
                const winner = room.white === socket.id ? 'b' : 'w';
                endGame(u.roomId, winner, 'Соперник отключился');
            }
        }
        delete users[socket.id];
        broadcastOnline();
    });
});

server.listen(3030, '0.0.0.0', () => {
    console.log('Сервер запущен на http://103.82.102.226:3030');
});
