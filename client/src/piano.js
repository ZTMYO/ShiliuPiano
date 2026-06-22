/**
 * 钢琴核心模块 — 键盘渲染 + 原生 Web Audio API 发声 + WebMIDI
 */
import { Notes, BLACK_KEY_GROUPS } from './notes.js'

// ===== 音源 =====
const bufferCache = {}
const pendingBuffers = {}
let samplerReady = false
let audioCtx = null
let masterGain = null
/** 获取当前按下的琴键信息（可视化用）*/
export function getActiveNotesInfo() {
  const keys = Object.keys(activeNotes).map(Number).filter(n => !isNaN(n))
  let low = 0, high = 0
  for (const k of keys) {
    if (k < 60) low++    // MIDI 60 = C4 (中央C)，以下低音，以上高音
    else high++
  }
  return { count: keys.length, lowCount: low, highCount: high }
}

export const callbacks = {
  onNotePlay: null,
  onNoteStop: null,
  onMidiStatus: null,
  onReady: null,
}

const noteByMIDI = {}
Notes.forEach(n => { noteByMIDI[n.midi] = n })

// ===== 下载所有采样 =====
const nameToFile = {
  'C2':'a49.mp3','D2':'a50.mp3','E2':'a51.mp3','F2':'a52.mp3','G2':'a53.mp3','A2':'a54.mp3','B2':'a55.mp3',
  'C3':'a56.mp3','D3':'a57.mp3','E3':'a48.mp3','F3':'a81.mp3','G3':'a87.mp3','A3':'a69.mp3','B3':'a82.mp3',
  'C4':'a84.mp3','D4':'a89.mp3','E4':'a85.mp3','F4':'a73.mp3','G4':'a79.mp3','A4':'a80.mp3','B4':'a65.mp3',
  'C5':'a83.mp3','D5':'a68.mp3','E5':'a70.mp3','F5':'a71.mp3','G5':'a72.mp3','A5':'a74.mp3','B5':'a75.mp3',
  'C6':'a76.mp3','D6':'a90.mp3','E6':'a88.mp3','F6':'a67.mp3','G6':'a86.mp3','A6':'a66.mp3','B6':'a78.mp3','C7':'a77.mp3',
  'C#2':'b49.mp3','D#2':'b50.mp3','F#2':'b52.mp3','G#2':'b53.mp3','A#2':'b54.mp3',
  'C#3':'b56.mp3','D#3':'b57.mp3','F#3':'b81.mp3','G#3':'b87.mp3','A#3':'b69.mp3',
  'C#4':'b84.mp3','D#4':'b89.mp3','F#4':'b73.mp3','G#4':'b79.mp3','A#4':'b80.mp3',
  'C#5':'b83.mp3','D#5':'b68.mp3','F#5':'b71.mp3','G#5':'b72.mp3','A#5':'b74.mp3',
  'C#6':'b76.mp3','D#6':'b90.mp3','F#6':'b67.mp3','G#6':'b86.mp3','A#6':'b66.mp3'
}
const SAMPLE_BASE = '/samples/piano/'

/** 并发下载所有采样 */
async function loadSamples() {
  const entries = Notes.map(n => ({ note: n, file: nameToFile[n.name] })).filter(e => e.file)

  const CONCURRENCY = 8
  let i = 0

  async function worker() {
    while (i < entries.length) {
      const idx = i++
      const { note, file } = entries[idx]
      try {
        const r = await fetch(SAMPLE_BASE + file)
        if (!r.ok) throw new Error('HTTP ' + r.status)
        pendingBuffers[note.midi] = await r.arrayBuffer()
      } catch (err) {
        console.warn('[piano] 采样加载失败:', note.name, file, err.message)
      }
    }
  }

  // 启动 CONCURRENCY 个 worker 并行下载
  const workers = []
  for (let w = 0; w < CONCURRENCY; w++) workers.push(worker())
  await Promise.all(workers)
}

// 下载完成后自动解码
loadSamples().then(() => { initAudio() })

function initAudio() {
  // 如果之前创建失败了，这里再试一次
  if (!audioCtx) {
    try {
      audioCtx = new AudioContext()
    } catch (e) {
      console.error('[piano] 创建 AudioContext 失败:', e)
      return
    }
  }
  // 创建主音量
  masterGain = audioCtx.createGain()
  masterGain.connect(audioCtx.destination)
  const mids = Object.keys(pendingBuffers)
  if (mids.length === 0) { finishInit(); return }
  let done = 0
  mids.forEach(midi => {
    const buf = pendingBuffers[midi]
    if (!buf) { done++; if (done >= mids.length) finishInit(); return }
    try {
      audioCtx.decodeAudioData(buf.slice(0), (decoded) => {
        bufferCache[midi] = decoded; done++
        if (done >= mids.length) finishInit()
      }, () => { done++; if (done >= mids.length) finishInit() })
    } catch (e) { done++; if (done >= mids.length) finishInit() }
  })
}
function finishInit() {
  samplerReady = true
  callbacks.onReady && callbacks.onReady()
}

/** 尝试恢复 AudioContext */
function tryResumeAudio() {
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {})
  }
}

/** 首次用户手势后恢复音频 */
function setupAudioResumeOnGesture() {
  const handler = () => {
    tryResumeAudio()
    document.removeEventListener('click', handler)
    document.removeEventListener('touchstart', handler)
    document.removeEventListener('keydown', handler)
  }
  document.addEventListener('click', handler)
  document.addEventListener('touchstart', handler)
  document.addEventListener('keydown', handler)
}

/** 用户在首次手势时调用，让 AudioContext 恢复运行 */
function resumeAudioContext() {
  tryResumeAudio()
}

// ===== 播放 / 释放 =====
const activeNotes = {}

export function playNote(midiNote) {
  if (!samplerReady || !audioCtx || audioCtx.state !== 'running') return
  const buf = bufferCache[midiNote]
  if (!buf) return
  try {
    const source = audioCtx.createBufferSource()
    const gain = audioCtx.createGain()
    gain.gain.value = 1.0
    source.buffer = buf
    source.connect(gain)
    gain.connect(masterGain || audioCtx.destination)
    source.start()
    activeNotes[midiNote] = { source, gain }
  } catch (e) { /* ignore */ }
}

/** 本地释放：400ms 渐变淡出 */
export function releaseNote(midiNote) {
  const entry = activeNotes[midiNote]
  if (!entry) return
  delete activeNotes[midiNote]
  try {
    entry.gain.gain.setValueAtTime(entry.gain.gain.value, audioCtx.currentTime)
    entry.gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.4)
    setTimeout(() => {
      try { entry.source.stop() } catch (e) { /* ignore */ }
    }, 500)
  } catch (e) { /* ignore */ }
}

/** 硬停止 */
export function stopNote(midiNote) {
  const entry = activeNotes[midiNote]
  if (entry) {
    try { entry.source.stop() } catch (e) { /* ignore */ }
    delete activeNotes[midiNote]
  }
}

// ===== 按键高亮 =====
function getKeyEl(midiNote) {
  return document.querySelector(`[data-midi="${midiNote}"]`)
}
function activateKey(midiNote, cls) {
  const el = getKeyEl(midiNote)
  if (el) el.classList.add(cls)
}
function deactivateKey(midiNote, cls) {
  const el = getKeyEl(midiNote)
  if (el) el.classList.remove(cls)
}

// ===== 本地弹奏 =====
let localLocked = false
export function setLocalLocked(v) { localLocked = v }

export function keyDown(midiNote) {
  if (localLocked) return
  const now = performance.now()  // 在 resume 前就抓时间戳
  // 如果音频还没 running，resume 后等完成再播（确保首次点击就有声音）
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().then(() => {
      playNote(midiNote)
      activateKey(midiNote, 'local-active')
      callbacks.onNotePlay && callbacks.onNotePlay(midiNote, now)
    }).catch(() => {})
    return
  }
  playNote(midiNote)
  activateKey(midiNote, 'local-active')
  callbacks.onNotePlay && callbacks.onNotePlay(midiNote, now)
}
export function keyUp(midiNote) {
  if (localLocked) return
  releaseNote(midiNote)
  deactivateKey(midiNote, 'local-active')
  callbacks.onNoteStop && callbacks.onNoteStop(midiNote)
}

// ===== 远程音符 =====
// 基于间隔的调度：不管网络抖动，只保证音符之间的相对节奏准确
// 原理：计算弹奏端相邻音符的时间差(delta)，收听端按同样的 delta 调度

let prevPlayerTime = null
let nextAudioTime = 0

/** 用音频时钟在指定时间播放一个音符 */
function scheduleNote(midiNote, when) {
  if (!samplerReady || !audioCtx || audioCtx.state !== 'running') return
  const buf = bufferCache[midiNote]
  if (!buf) return
  try {
    const source = audioCtx.createBufferSource()
    const gain = audioCtx.createGain()
    gain.gain.value = 1.0
    source.buffer = buf
    source.connect(gain)
    gain.connect(masterGain || audioCtx.destination)
    source.start(when)
  } catch (e) { /* ignore */ }
}

/** 接收远程音符 */
export function remoteNoteOn(midiNote, playerTime) {
  tryResumeAudio()
  if (!audioCtx || audioCtx.state !== 'running') return

  const now = audioCtx.currentTime

  // 第一个音符或间隔过大（弹奏停顿）→ 立即播，重置参考
  if (prevPlayerTime === null || playerTime - prevPlayerTime > 1500) {
    prevPlayerTime = playerTime
    nextAudioTime = now
    scheduleNote(midiNote, now)
    activateKey(midiNote, 'remote-active')
    return
  }

  // 正常情况：计算弹奏端的实际间隔，在收听端用同样的间隔调度
  const deltaMs = playerTime - prevPlayerTime
  prevPlayerTime = playerTime
  nextAudioTime += deltaMs / 1000  // 累加间隔（不依赖网络到达时间）

  // 如果收听端累计时间落后于现实时间，跳转到当前（防大 lag 堆积）
  if (nextAudioTime < now - 0.05) {
    nextAudioTime = now
  }

  scheduleNote(midiNote, nextAudioTime)
  activateKey(midiNote, 'remote-active')
}

export function remoteNoteOff(midiNote) {
  deactivateKey(midiNote, 'remote-active')
}

/** 重置远程调度状态 */
export function resetRemoteScheduler() {
  prevPlayerTime = null
  nextAudioTime = 0
}

// ===== 重置 =====
export function resetAllKeys() {
  Object.keys(activeNotes).forEach(midi => stopNote(midi))
  document.querySelectorAll('.local-active').forEach(el => el.classList.remove('local-active'))
  document.querySelectorAll('.remote-active').forEach(el => el.classList.remove('remote-active'))
}

// ===== 键位显示切换 =====
let keysVisible = false
export function toggleKeyDisplay() {
  keysVisible = !keysVisible
  document.querySelectorAll('.keyname').forEach(el => {
    el.style.display = keysVisible ? '' : 'none'
  })
  const tip = document.querySelector('.piano-tip')
  if (tip) tip.style.display = keysVisible ? '' : 'none'
  return keysVisible
}
export function isKeysVisible() { return keysVisible }

// ===== 兼容接口 =====
export function resumeAudio() { resumeAudioContext() }
export async function initSampler() { resumeAudioContext() }

// ===== 键盘渲染 =====
export function renderPiano(containerId = 'piano-container') {
  const container = document.getElementById(containerId)
  if (!container) { console.error('[piano] 找不到容器:', containerId); return }
  container.innerHTML = ''

  const autoPiano = document.createElement('div')
  autoPiano.className = 'component-autopiano'
  const scrollWrap = document.createElement('div')
  scrollWrap.className = 'piano-scroll-wrap'
  autoPiano.appendChild(scrollWrap)
  const wrap = document.createElement('div')
  wrap.className = 'piano-wrap visible'
  scrollWrap.appendChild(wrap)

  const band = document.createElement('div')
  band.className = 'piano-band'
  const bandImg = document.createElement('img')
  bandImg.className = 'piano-band-img'
  bandImg.src = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 40"><text x="130" y="28" text-anchor="middle" font-size="16" fill="#888" font-weight="bold">Shiliu Piano</text></svg>'
  )
  bandImg.alt = ''
  band.appendChild(bandImg)

  const tip = document.createElement('div')
  tip.className = 'piano-tip'
  tip.textContent = '⇧ 代表 shift 键'
  tip.style.display = 'none'
  band.appendChild(tip)
  wrap.appendChild(band)

  const keyWrap = document.createElement('div')
  keyWrap.className = 'piano-key-wrap'
  wrap.appendChild(keyWrap)

  Notes.filter(n => n.type === 'white').forEach(n => {
    const key = document.createElement('div')
    key.className = 'piano-key wkey'
    key.dataset.midi = n.midi
    key.dataset.name = n.name
    const tipDiv = document.createElement('div')
    tipDiv.className = 'keytip'
    const nameDiv = document.createElement('div')
    nameDiv.className = 'keyname'
    nameDiv.style.display = 'none'
    nameDiv.innerHTML = n.key
    const noteDiv = document.createElement('div')
    noteDiv.className = 'notename'
    noteDiv.style.display = 'none'
    noteDiv.textContent = n.name
    tipDiv.appendChild(nameDiv)
    tipDiv.appendChild(noteDiv)
    key.appendChild(tipDiv)
    keyWrap.appendChild(key)
  })

  BLACK_KEY_GROUPS.forEach(group => {
    const wrapDiv = document.createElement('div')
    wrapDiv.className = 'bkey-wrap ' + group.wrapClass
    group.ids.forEach(id => {
      const n = Notes.find(note => note.id === id)
      if (!n) return
      const key = document.createElement('div')
      key.className = 'piano-key bkey'
      key.dataset.midi = n.midi
      key.dataset.name = n.name
      const tipDiv = document.createElement('div')
      tipDiv.className = 'keytip'
      const nameDiv = document.createElement('div')
      nameDiv.className = 'keyname'
      nameDiv.style.display = 'none'
      nameDiv.innerHTML = n.key
      tipDiv.appendChild(nameDiv)
      key.appendChild(tipDiv)
      wrapDiv.appendChild(key)
    })
    keyWrap.appendChild(wrapDiv)
  })

  container.appendChild(autoPiano)

  function computeSize() {
    if (!keyWrap.offsetWidth) return
    const w = keyWrap.offsetWidth / 36
    keyWrap.style.height = (w * 7) + 'px'
    keyWrap.querySelectorAll('.bkey').forEach(el => { el.style.height = (w * 7 * 0.7) + 'px' })
  }
  computeSize()
  window.addEventListener('resize', computeSize)

  bindMouseEvents(keyWrap)
  bindKeyboardEvents()

  return autoPiano
}

// ===== 鼠标事件 =====
const heldKeys = new Set()

function bindMouseEvents(keyWrap) {
  keyWrap.addEventListener('mousedown', (e) => {
    const key = e.target.closest('[data-midi]')
    if (!key) return
    e.preventDefault()
    const midi = parseInt(key.dataset.midi)
    resumeAudioContext()
    keyDown(midi)
    heldKeys.add(midi)
    key._held = true
  })
  document.addEventListener('mouseup', () => {
    heldKeys.forEach(midi => { keyUp(midi) })
    heldKeys.clear()
  })
  keyWrap.addEventListener('mouseleave', () => {
    heldKeys.forEach(midi => { keyUp(midi) })
    heldKeys.clear()
  })
  keyWrap.addEventListener('touchstart', (e) => {
    const touch = e.changedTouches[0]
    const key = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('[data-midi]')
    if (!key) return
    e.preventDefault()
    const midi = parseInt(key.dataset.midi)
    resumeAudioContext()
    keyDown(midi)
    heldKeys.add(midi)
    key._held = true
  }, { passive: false })
  keyWrap.addEventListener('touchend', (e) => {
    const touch = e.changedTouches[0]
    const key = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('[data-midi]')
    if (key && key._held) {
      keyUp(parseInt(key.dataset.midi))
      heldKeys.delete(parseInt(key.dataset.midi))
      key._held = false
    }
  })
}

// ===== 键盘事件 =====
function bindKeyboardEvents() {
  let enableBlackKey = false
  document.addEventListener('keydown', (e) => {
    const keyCode = e.keyCode
    if (keyCode === 16) { enableBlackKey = true; return }
    let searchCode = enableBlackKey ? 'b' + keyCode : '' + keyCode
    const note = Notes.find(n => n.keyCode === searchCode)
    if (!note) return
    if (localLocked) return  // 输入框聚焦时不禁用默认行为
    e.preventDefault()
    const midi = note.midi
    resumeAudioContext()
    if (!heldKeys.has(midi)) {
      keyDown(midi)
      heldKeys.add(midi)
    }
  })
  document.addEventListener('keyup', (e) => {
    const keyCode = e.keyCode
    if (keyCode === 16) { enableBlackKey = false; return }
    let searchCode = enableBlackKey ? 'b' + keyCode : '' + keyCode
    const note = Notes.find(n => n.keyCode === searchCode)
    if (!note) return
    const midi = note.midi
    keyUp(midi)
    heldKeys.delete(midi)
  })
}

// ===== WebMIDI =====
let midiAccess = null
let midiInput = null

export async function connectMIDI() {
  if (!navigator.requestMIDIAccess) {
    callbacks.onMidiStatus && callbacks.onMidiStatus(false)
    return false
  }
  try {
    midiAccess = await navigator.requestMIDIAccess()
    if (midiInput) { midiInput.onmidimessage = null; midiInput = null }

    const inputs = []
    midiAccess.inputs.forEach(i => inputs.push(i))

    const isVirtual = (name) => {
      const n = (name || '').toLowerCase()
      return n.includes('bome') || n.includes('loopbe') || n.includes('virtual') ||
             n.includes('translator') || n.includes('midi yoke') || n.includes('loopmidi')
    }
    const isKeyboard = (name) => {
      const n = (name || '').toLowerCase()
      return n.includes('keyboard') || n.includes('key') || n.includes('piano') ||
             n.includes('flkey') || n.includes('fl key') || n.includes('midi controller')
    }

    let chosen = null
    for (const dev of inputs) {
      if (isKeyboard(dev.name)) { chosen = dev; break }
    }
    if (!chosen) {
      for (const dev of inputs) {
        if (!isVirtual(dev.name)) { chosen = dev; break }
      }
    }
    if (!chosen && inputs.length > 0) chosen = inputs[0]

    if (chosen) {
      selectMIDIInput(chosen)
      callbacks.onMidiStatus && callbacks.onMidiStatus(true)
      return true
    }

    callbacks.onMidiStatus && callbacks.onMidiStatus('waiting')

    midiAccess.onstatechange = (e) => {
      if (e.port.type === 'input' && e.port.state === 'connected') {
        if (!midiInput) { selectMIDIInput(e.port); callbacks.onMidiStatus && callbacks.onMidiStatus(true) }
      }
      if (e.port.type === 'input' && e.port.state === 'disconnected') {
        if (midiInput && midiInput.id === e.port.id) { midiInput = null; callbacks.onMidiStatus && callbacks.onMidiStatus('waiting') }
      }
    }
    return false
  } catch (err) {
    callbacks.onMidiStatus && callbacks.onMidiStatus(false)
    return false
  }
}

function selectMIDIInput(input) {
  if (midiInput) midiInput.onmidimessage = null
  midiInput = input
  midiInput.onmidimessage = (event) => {
    const data = event.data
    const status = data[0]
    const midiNote = data[1]
    const velocity = data[2]
    const cmd = status & 0xf0

    if (cmd !== 0x90 && cmd !== 0x80) return
    const ourNote = noteByMIDI[midiNote]
    if (!ourNote) return

    resumeAudioContext()
    if (cmd === 0x90 && velocity > 0) {
      keyDown(midiNote)
    } else {
      keyUp(midiNote)
    }
  }
}
