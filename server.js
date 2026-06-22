const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// ===== 服务端状态 =====
let currentPlayerId = null;    // 当前弹奏者 socket.id
const playerQueue = [];         // 排队等待弹奏的用户 [{ socketId, nickname }]
const onlineUsers = new Map();  // socketId -> { nickname }
let heldNotes = new Set();      // 当前弹奏者按着的音符

// ===== 静态文件（生产环境构建后） =====
app.use(express.static(path.join(__dirname, 'client', 'dist')));

// ===== Socket.io 事件 =====
io.on('connection', (socket) => {
  console.log(`用户连接: ${socket.id}`);
  onlineUsers.set(socket.id, { nickname: `用户${socket.id.slice(0, 4)}` });

  // 广播在线状态
  broadcastStatus();

  // 采样加载完成后客户端请求同步状态
  socket.on('sync-state', () => {
    if (currentPlayerId) {
      socket.emit('sync-state', {
        playerId: currentPlayerId,
        heldNotes: Array.from(heldNotes),
        online: onlineUsers.size
      });
    } else {
      socket.emit('sync-state', {
        playerId: null,
        heldNotes: [],
        online: onlineUsers.size
      });
    }
  });

  // 请求弹奏
  socket.on('request-play', () => {
    if (!currentPlayerId) {
      // 无人弹奏，直接上位
      currentPlayerId = socket.id;
      socket.emit('you-are-player');
      io.emit('player-change', {
        playerId: socket.id,
        nickname: onlineUsers.get(socket.id)?.nickname || '未知'
      });
      console.log(`用户 ${socket.id} 成为弹奏者`);
    } else if (currentPlayerId === socket.id) {
      // 自己已经是弹奏者
      socket.emit('queue-result', { ok: true, msg: '你已经在弹奏了' });
    } else {
      // 有人正在弹奏，加入排队
      if (!playerQueue.find(u => u.socketId === socket.id)) {
        playerQueue.push({ socketId: socket.id, nickname: onlineUsers.get(socket.id)?.nickname });
        const pos = playerQueue.length;
        socket.emit('queue-result', {
          ok: true,
          msg: `已加入排队，前方还有 ${pos} 人`
        });
        console.log(`用户 ${socket.id} 加入排队，位置 ${pos}`);
      } else {
        socket.emit('queue-result', { ok: false, msg: '你已经在排队中了' });
      }
    }
    broadcastStatus();
  });

  // 停止弹奏
  socket.on('stop-play', () => {
    if (currentPlayerId === socket.id) {
      releasePlayer(socket.id);
    }
  });

  // MIDI 音符事件 - 只有弹奏者发送的才转发
  socket.on('midi-note', (data) => {
    if (socket.id !== currentPlayerId) return;
    // 追踪当前弹奏者的音符状态
    if (data.type === 'noteon') {
      heldNotes.add(data.note);
    } else {
      heldNotes.delete(data.note);
    }
    // 广播给除弹奏者外的所有人
    socket.broadcast.emit('remote-note', data);
  });

  // 弹幕消息 — 广播给除发送者外的所有人
  socket.on('chat-message', (text) => {
    socket.broadcast.emit('chat-message', { text, from: socket.id });
  });

  // 断开连接
  socket.on('disconnect', () => {
    console.log(`用户断开: ${socket.id}`);
    onlineUsers.delete(socket.id);

    // 如果是弹奏者断开
    if (currentPlayerId === socket.id) {
      releasePlayer(socket.id);
    } else {
      // 从排队队列移除
      const idx = playerQueue.findIndex(u => u.socketId === socket.id);
      if (idx !== -1) playerQueue.splice(idx, 1);
    }

    broadcastStatus();
  });
});

/** 释放当前弹奏者，从队列选下一个 */
function releasePlayer(socketId) {
  if (currentPlayerId !== socketId) return;

  currentPlayerId = null;
  heldNotes.clear();

  // 从队列中选下一个
  if (playerQueue.length > 0) {
    const next = playerQueue.shift();
    const nextSocket = io.sockets.sockets.get(next.socketId);
    if (nextSocket) {
      currentPlayerId = next.socketId;
      nextSocket.emit('you-are-player');
      io.emit('player-change', {
        playerId: next.socketId,
        nickname: next.nickname || '未知'
      });
      console.log(`队列中用户 ${next.socketId} 成为弹奏者`);
    }
  }

  if (!currentPlayerId) {
    io.emit('player-change', { playerId: null, nickname: null });
    console.log('当前无人弹奏');
  }
}

/** 广播在线状态 */
function broadcastStatus() {
  io.emit('status', {
    online: onlineUsers.size,
    playerOnline: !!currentPlayerId
  });
}

// ===== 所有路由返回前端 =====
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'dist', 'index.html'));
});

// ===== 启动 =====
const PORT = 3003;
server.listen(PORT, () => {
  console.log(`石榴钢琴服务端运行: http://localhost:${PORT}`);
});
