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

/** 远程活跃音符（用于可视化）*/
const remoteActiveNotes = new Set()
export function addRemoteActive(midi) { remoteActiveNotes.add(midi) }
export function removeRemoteActive(midi) { remoteActiveNotes.delete(midi) }
export function clearRemoteActive() { remoteActiveNotes.clear() }

/** 获取当前按下的琴键信息（可视化用）包含本地 + 远程 */
export function getActiveNotesInfo() {
  const localKeys = Object.keys(activeNotes).map(Number).filter(n => !isNaN(n))
  // 合并本地和远程，去重
  const all = new Set(localKeys)
  for (const m of remoteActiveNotes) all.add(m)
  let low = 0, high = 0
  for (const k of all) {
    if (k < 60) low++    // MIDI 60 = C4 (中央C)，以下低音，以上高音
    else high++
  }
  return { count: all.size, lowCount: low, highCount: high }
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
  const now = performance.now()
  // 同步激活按键，防止 resume 异步导致 mouseup 提前执行
  activateKey(midiNote, 'local-active')
  callbacks.onNotePlay && callbacks.onNotePlay(midiNote, now)
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().then(() => {
      playNote(midiNote)
    }).catch(() => {})
    return
  }
  playNote(midiNote)
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
  remoteActiveNotes.add(midiNote)
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
  remoteActiveNotes.delete(midiNote)
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
  remoteActiveNotes.clear()
  // 清理鼠标/触摸状态
  heldKeys.clear()
  lastMouseMidi = null
  Object.keys(touchMap).forEach(k => delete touchMap[k])
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

  // 3D 立体质感圆形键位开关 — 睁眼/闭眼
  const keyToggle = document.createElement('div')
  keyToggle.className = 'piano-key-toggle'
  keyToggle.title = '显示/隐藏键位'
  // 睁眼 SVG（键位可见）
  keyToggle.innerHTML = `\
<svg class="eye-open" viewBox="0 0 1024 1024" width="16" height="16"><path d="M942.2 486.2C847.4 286.5 704.1 186 512 186c-192.2 0-335.4 100.5-430.2 300.3-7.7 16.2-7.7 35.2 0 51.5C176.6 737.5 319.9 838 512 838c192.2 0 335.4-100.5 430.2-300.3 7.7-16.2 7.7-35 0-51.5zM512 766c-161.3 0-279.4-81.8-362.7-254C232.6 339.8 350.7 258 512 258c161.3 0 279.4 81.8 362.7 254C791.5 684.2 673.4 766 512 766z"/><path d="M508 336c-97.2 0-176 78.8-176 176s78.8 176 176 176 176-78.8 176-176-78.8-176-176-176z m0 288c-61.9 0-112-50.1-112-112s50.1-112 112-112 112 50.1 112 112-50.1 112-112 112z"/></svg>\
<svg class="eye-closed" viewBox="0 0 1024 1024" width="16" height="16"><path d="M942.3 486.4l-0.1-0.1-0.1-0.1c-36.4-76.7-80-138.7-130.7-186L760.7 351c43.7 40.2 81.5 93.7 114.1 160.9C791.5 684.2 673.4 766 512 766c-51.3 0-98.3-8.3-141.2-25.1l-54.7 54.7C374.6 823.8 439.8 838 512 838c192.2 0 335.4-100.5 430.2-300.3 7.7-16.2 7.7-35 0.1-51.3zM878.3 154.2l-42.4-42.4c-3.1-3.1-8.2-3.1-11.3 0L707.8 228.5C649.4 200.2 584.2 186 512 186c-192.2 0-335.4 100.5-430.2 300.3v0.1c-7.7 16.2-7.7 35.2 0 51.5 36.4 76.7 80 138.7 130.7 186.1L111.8 824.5c-3.1 3.1-3.1 8.2 0 11.3l42.4 42.4c3.1 3.1 8.2 3.1 11.3 0l712.8-712.8c3.1-3 3.1-8.1 0-11.2zM398.9 537.4c-1.9-8.2-2.9-16.7-2.9-25.4 0-61.9 50.1-112 112-112 8.7 0 17.3 1 25.4 2.9L398.9 537.4z m184.5-184.5C560.5 342.1 535 336 508 336c-97.2 0-176 78.8-176 176 0 27 6.1 52.5 16.9 75.4L263.3 673c-43.7-40.2-81.5-93.7-114.1-160.9C232.6 339.8 350.7 258 512 258c51.3 0 98.3 8.3 141.2 25.1l-69.8 69.8z"/><path d="M508 624c-6.4 0-12.7-0.5-18.8-1.6l-51.1 51.1c21.4 9.3 45.1 14.4 69.9 14.4 97.2 0 176-78.8 176-176 0-24.8-5.1-48.5-14.4-69.9l-51.1 51.1c1 6.1 1.6 12.4 1.6 18.8C620 573.9 569.9 624 508 624z"/></svg>`
  band.appendChild(keyToggle)

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

  // 键位开关事件（使用上面创建的 keyToggle）
  keyToggle.addEventListener('click', () => {
    const visible = toggleKeyDisplay()
    keyToggle.classList.toggle('active', visible)
  })

  return autoPiano
}

// ===== 鼠标事件（支持滑键） =====
const heldKeys = new Set()
let lastMouseMidi = null
const touchMap = {}

function bindMouseEvents(keyWrap) {
  // ---- 鼠标滑键 ----

  keyWrap.addEventListener('mousedown', (e) => {
    const key = e.target.closest('[data-midi]')
    if (!key) return
    e.preventDefault()
    const midi = parseInt(key.dataset.midi)
    resumeAudioContext()
    keyDown(midi)
    heldKeys.add(midi)
    lastMouseMidi = midi
  })

  keyWrap.addEventListener('mousemove', (e) => {
    if (lastMouseMidi === null) return  // 没有按下
    const key = e.target.closest('[data-midi]')
    if (!key) return
    const midi = parseInt(key.dataset.midi)
    if (midi !== lastMouseMidi) {
      // 滑到新键：释放旧键，按下新键
      keyUp(lastMouseMidi)
      heldKeys.delete(lastMouseMidi)
      keyDown(midi)
      heldKeys.add(midi)
      lastMouseMidi = midi
    }
  })

  document.addEventListener('mouseup', () => {
    if (lastMouseMidi !== null) {
      keyUp(lastMouseMidi)
      heldKeys.delete(lastMouseMidi)
      lastMouseMidi = null
    }
  })

  // 鼠标离开键盘区域也释放
  keyWrap.addEventListener('mouseleave', () => {
    if (lastMouseMidi !== null) {
      keyUp(lastMouseMidi)
      heldKeys.delete(lastMouseMidi)
      lastMouseMidi = null
    }
  })

  // ---- 触摸滑键（支持多点触控） ----
  keyWrap.addEventListener('touchstart', (e) => {
    e.preventDefault()
    for (const touch of e.changedTouches) {
      const el = document.elementFromPoint(touch.clientX, touch.clientY)
      const key = el?.closest('[data-midi]')
      if (!key) continue
      const midi = parseInt(key.dataset.midi)
      resumeAudioContext()
      keyDown(midi)
      heldKeys.add(midi)
      touchMap[touch.identifier] = midi
    }
  }, { passive: false })

  keyWrap.addEventListener('touchmove', (e) => {
    e.preventDefault()
    for (const touch of e.changedTouches) {
      const oldMidi = touchMap[touch.identifier]
      const el = document.elementFromPoint(touch.clientX, touch.clientY)
      const key = el?.closest('[data-midi]')
      if (!key) {
        // 滑出键盘区域 → 释放
        if (oldMidi !== undefined) {
          keyUp(oldMidi)
          heldKeys.delete(oldMidi)
          delete touchMap[touch.identifier]
        }
        continue
      }
      const midi = parseInt(key.dataset.midi)
      if (midi !== oldMidi) {
        if (oldMidi !== undefined) {
          keyUp(oldMidi)
          heldKeys.delete(oldMidi)
        }
        keyDown(midi)
        heldKeys.add(midi)
        touchMap[touch.identifier] = midi
      }
    }
  }, { passive: false })

  keyWrap.addEventListener('touchend', (e) => {
    e.preventDefault()
    for (const touch of e.changedTouches) {
      const midi = touchMap[touch.identifier]
      if (midi !== undefined) {
        keyUp(midi)
        heldKeys.delete(midi)
        delete touchMap[touch.identifier]
      }
    }
  }, { passive: false })

  keyWrap.addEventListener('touchcancel', () => {
    for (const midi of Object.values(touchMap)) {
      keyUp(midi)
      heldKeys.delete(midi)
    }
    Object.keys(touchMap).forEach(k => delete touchMap[k])
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
    // 查找所有匹配此键码的音符（白键和黑键两种编码都要查）
    // 避免 Shift 先松开后搜索编码不对，导致黑键残留高亮
    const candidates = Notes.filter(n =>
      n.keyCode === '' + keyCode || n.keyCode === 'b' + keyCode
    )
    for (const note of candidates) {
      const midi = note.midi
      if (heldKeys.has(midi)) {
        keyUp(midi)
        heldKeys.delete(midi)
      }
    }
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
