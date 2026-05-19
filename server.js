const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: { origin: "*" }
});

app.use(express.static('public'));
app.use(express.json());

const USERS_FILE = './users.json';

// Загрузка пользователей из файла
function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) {
        const defaultUsers = [
            { id: 1, username: "GHOST_RVJ", password: "123", avatar: "GH", friends: [2,3], friendRequests: [], online: false, socketId: null },
            { id: 2, username: "NEO_N1GHT", password: "123", avatar: "NN", friends: [1], friendRequests: [3], online: false, socketId: null },
            { id: 3, username: "RAVEN_VORTEX", password: "123", avatar: "RV", friends: [1], friendRequests: [], online: false, socketId: null }
        ];
        fs.writeFileSync(USERS_FILE, JSON.stringify(defaultUsers, null, 2));
        return defaultUsers;
    }
    return JSON.parse(fs.readFileSync(USERS_FILE));
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

let users = loadUsers();

// API: регистрация
app.post('/register', (req, res) => {
    const { username, password } = req.body;
    if (users.find(u => u.username === username)) {
        return res.json({ success: false, error: "Username already exists" });
    }
    const newUser = {
        id: users.length + 1,
        username,
        password,
        avatar: username.substring(0, 2).toUpperCase(),
        friends: [],
        friendRequests: [],
        online: false,
        socketId: null
    };
    users.push(newUser);
    saveUsers(users);
    res.json({ success: true, userId: newUser.id });
});

// API: логин
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username && u.password === password);
    if (user) {
        res.json({ success: true, user: { id: user.id, username: user.username, avatar: user.avatar, friends: user.friends, friendRequests: user.friendRequests } });
    } else {
        res.json({ success: false, error: "Invalid credentials" });
    }
});

// API: получить всех пользователей (для поиска)
app.get('/users', (req, res) => {
    const safeUsers = users.map(u => ({ id: u.id, username: u.username, avatar: u.avatar, online: u.online }));
    res.json(safeUsers);
});

// Socket.IO
io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);
    
    let currentUserId = null;
    
    socket.on('user-online', (userId) => {
        currentUserId = userId;
        const user = users.find(u => u.id === userId);
        if (user) {
            user.online = true;
            user.socketId = socket.id;
            saveUsers(users);
            // Оповестить всех друзей
            user.friends.forEach(friendId => {
                const friend = users.find(u => u.id === friendId);
                if (friend && friend.socketId) {
                    io.to(friend.socketId).emit('friend-status-change', { userId: user.id, online: true });
                }
            });
        }
    });
    
    // Отправить сообщение
    socket.on('send-message', (data) => {
        const { fromUserId, toUserId, text, timestamp } = data;
        const toUser = users.find(u => u.id === toUserId);
        if (toUser && toUser.socketId) {
            io.to(toUser.socketId).emit('new-message', {
                fromUserId,
                text,
                timestamp,
                messageId: Date.now()
            });
        }
        // Сохраняем в "историю" — в реальном приложении нужна БД
        socket.emit('message-sent', { success: true });
    });
    
    // Отправить заявку в друзья
    socket.on('send-friend-request', (data) => {
        const { fromUserId, toUserId } = data;
        const fromUser = users.find(u => u.id === fromUserId);
        const toUser = users.find(u => u.id === toUserId);
        
        if (fromUser && toUser && !toUser.friendRequests.includes(fromUserId) && !toUser.friends.includes(fromUserId)) {
            toUser.friendRequests.push(fromUserId);
            saveUsers(users);
            
            if (toUser.socketId) {
                io.to(toUser.socketId).emit('friend-request-received', {
                    fromUser: { id: fromUser.id, username: fromUser.username, avatar: fromUser.avatar }
                });
            }
            socket.emit('friend-request-sent', { success: true });
        }
    });
    
    // Принять заявку
    socket.on('accept-friend-request', (data) => {
        const { currentUserId, requesterId } = data;
        const currentUser = users.find(u => u.id === currentUserId);
        const requester = users.find(u => u.id === requesterId);
        
        if (currentUser && requester) {
            if (!currentUser.friends.includes(requesterId)) currentUser.friends.push(requesterId);
            if (!requester.friends.includes(currentUserId)) requester.friends.push(currentUserId);
            currentUser.friendRequests = currentUser.friendRequests.filter(id => id !== requesterId);
            saveUsers(users);
            
            // Оповестить обоих
            if (currentUser.socketId) {
                io.to(currentUser.socketId).emit('friend-added', { friend: { id: requester.id, username: requester.username, avatar: requester.avatar } });
            }
            if (requester.socketId) {
                io.to(requester.socketId).emit('friend-added', { friend: { id: currentUser.id, username: currentUser.username, avatar: currentUser.avatar } });
            }
        }
    });
    
    // Отклонить заявку
    socket.on('decline-friend-request', (data) => {
        const { currentUserId, requesterId } = data;
        const currentUser = users.find(u => u.id === currentUserId);
        if (currentUser) {
            currentUser.friendRequests = currentUser.friendRequests.filter(id => id !== requesterId);
            saveUsers(users);
            socket.emit('request-declined', { success: true });
        }
    });
    
    // Отключение
    socket.on('disconnect', () => {
        if (currentUserId) {
            const user = users.find(u => u.id === currentUserId);
            if (user) {
                user.online = false;
                user.socketId = null;
                saveUsers(users);
                user.friends.forEach(friendId => {
                    const friend = users.find(u => u.id === friendId);
                    if (friend && friend.socketId) {
                        io.to(friend.socketId).emit('friend-status-change', { userId: user.id, online: false });
                    }
                });
            }
        }
        console.log('Client disconnected');
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🚀 RVJ Server running on http://localhost:${PORT}`);
});