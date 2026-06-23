/**
 * 石榴钢琴 - 前端入口
 */
import { io } from 'socket.io-client'
import './style.css'
import './visualizer.css'
import {
  renderPiano, setLocalLocked, connectMIDI,
  remoteNoteOn, remoteNoteOff, resetRemoteScheduler,
  resetAllKeys, callbacks,
  addRemoteActive, clearRemoteActive
} from './piano.js'
import { createVisualizer } from './visualizer.js'
import { initDanmaku } from './danmaku.js'

// ===== DOM =====
const btnPlay = document.getElementById('btn-play')
const btnStop = document.getElementById('btn-stop')
const statusOnline = document.getElementById('status-online')
const midiIndicator = document.getElementById('midi-indicator')

// ===== 状态 =====
let socket = null
let isPlayer = false
let currentPlayer = null
let sessionStart = 0
let audioReady = false  // 音频采样是否就绪（仅用于音频播放）

// ===== Socket =====
let danmaku = null  // 弹幕控制器（onReady 后初始化）

function connectSocket() {
  socket = io(window.location.origin, { transports: ['websocket', 'polling'] })

  socket.on('connect', () => {
    btnPlay.disabled = false
    syncState()
  })
  socket.on('disconnect', () => {
    isPlayer = false
    if (currentPlayer === socket?.id) {
      resetAllKeys()
    }
    currentPlayer = null
    updateUI()
  })

  // 状态事件不依赖音频就绪——UI 需要立即更新
  socket.on('status', ({ online }) => {
    statusOnline.textContent = `${online} 在线`
  })

  socket.on('player-change', ({ playerId }) => {
    // 换人弹了 → 重置远程调度参考点
    if (playerId !== socket.id) resetRemoteScheduler()
    currentPlayer = playerId
    isPlayer = (playerId === socket.id)
    if (isPlayer) sessionStart = performance.now()
    updateUI()
  })

  socket.on('you-are-player', () => {
    isPlayer = true
    currentPlayer = socket.id
    sessionStart = performance.now()
    updateUI()
  })

  // 同步状态
  socket.on('sync-state', ({ playerId, heldNotes, online }) => {
    if (online !== undefined) statusOnline.textContent = `${online} 在线`
    // 先清空再重新填充远程音符（让可视化立即响应）
    clearRemoteActive()
    document.querySelectorAll('.remote-active').forEach(el => el.classList.remove('remote-active'))
    if (heldNotes && heldNotes.length > 0) {
      heldNotes.forEach(n => {
        addRemoteActive(n)
        const el = document.querySelector(`[data-midi="${n}"]`)
        if (el) el.classList.add('remote-active')
      })
    }
    if (playerId) {
      currentPlayer = playerId
      isPlayer = (playerId === socket.id)
      if (isPlayer) sessionStart = performance.now()
    } else {
      currentPlayer = null
      isPlayer = false
    }
    updateUI()
  })

  // 远程音符：需要音频就绪才能播放
  socket.on('remote-note', ({ note, type, playerTime }) => {
    if (!audioReady) return
    if (type === 'noteon') remoteNoteOn(note, playerTime)
    else remoteNoteOff(note)
  })

  socket.on('queue-result', ({ ok, msg }) => { if (!ok) alert(msg) })

  // 弹幕（来自他人）
  let mySocketId = null
  socket.on('connect', () => { mySocketId = socket.id })
  socket.on('chat-message', (data) => {
    if (!danmaku) return
    if (data.from && data.from === mySocketId) return  // 自己发的跳过
    danmaku.add(data.text)
  })
}

function setupDanmakuUI() {
  const input = document.getElementById('danmaku-input')
  const sendBtn = document.getElementById('danmaku-send')
  const area = document.getElementById('danmaku-input-area')
  const handle = document.getElementById('danmaku-handle')
  const wrap = document.getElementById('danmaku-input-wrap')
  if (!input || !sendBtn || !area || !handle) return

  // 手柄点击切换展开/收起
  handle.addEventListener('click', (e) => {
    e.stopPropagation()
    area.classList.toggle('open')
    if (area.classList.contains('open')) input.focus()
  })

  // 点击输入框区展开
  wrap.addEventListener('click', (e) => {
    if (!area.classList.contains('open')) {
      area.classList.add('open')
      input.focus()
    }
  })

  function send() {
    const text = input.value.trim()
    if (!text) return
    if (socket?.connected) {
      socket.emit('chat-message', text)
      danmaku.add(text, true)  // 本地弹幕带标记
    }
    input.value = ''
    input.focus()
  }

  sendBtn.addEventListener('click', (e) => { e.stopPropagation(); send() })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send()
    if (e.key === 'Escape') area.classList.remove('open')
  })

  // 聚焦输入框时锁定琴键
  input.addEventListener('focus', () => setLocalLocked(true))
  input.addEventListener('blur', () => setLocalLocked(false))
}

function syncState() {
  if (socket?.connected) {
    socket.emit('sync-state')
  }
}

// ===== 回调 =====
callbacks.onNotePlay = (midi, playerTime) => {
  if (isPlayer && socket?.connected) {
    socket.emit('midi-note', { note: midi, velocity: 100, type: 'noteon', playerTime })
  }
}
callbacks.onNoteStop = (midi) => {
  if (isPlayer && socket?.connected) {
    socket.emit('midi-note', { note: midi, velocity: 0, type: 'noteoff' })
  }
}
callbacks.onMidiStatus = (s) => {
  midiIndicator.className = s === true ? 'midi-on' : 'midi-off'
}
callbacks.onReady = () => {
  audioReady = true
  syncState()

  // 触发转场：双星膨胀散开 → 渐显钢琴
  const loading = document.getElementById('loading-screen')
  const app = document.getElementById('app')
  if (loading) {
    loading.classList.add('expand')
    setTimeout(() => {
      loading.classList.add('hidden')
      app.classList.add('visible')
    }, 600)
  } else {
    app.classList.add('visible')
  }
}

// ===== UI =====
function updateUI() {
  if (isPlayer) {
    btnPlay.style.display = 'none'
    btnStop.style.display = 'inline-block'
    btnStop.disabled = false
    setLocalLocked(false)
  } else {
    btnPlay.style.display = 'inline-block'
    btnPlay.textContent = '我要弹奏'
    btnStop.style.display = 'none'
    if (currentPlayer && currentPlayer !== socket?.id) {
      btnPlay.disabled = true
      btnPlay.textContent = '有人弹奏'
      setLocalLocked(true)
    } else {
      btnPlay.disabled = !socket?.connected
      setLocalLocked(false)
    }
  }
}

// ===== 事件 =====
btnPlay.addEventListener('click', () => {
  if (!socket?.connected) return
  socket.emit('request-play')
})

btnStop.addEventListener('click', () => {
  if (!socket?.connected) return
  resetAllKeys()
  socket.emit('stop-play')
  isPlayer = false
  updateUI()
})

midiIndicator.addEventListener('click', () => {
  connectMIDI()
})

// ===== 启动 =====
connectSocket()
renderPiano()
createVisualizer(document.getElementById('visualizer-container'))
danmaku = initDanmaku()
setupDanmakuUI()
