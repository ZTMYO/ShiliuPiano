/**
 * 可视化 — 红绿双色光球
 * 弹奏时：两球各自向目标位置靠拢（红左、绿右）
 * 空闲 5 秒后：恢复随机反弹
 * 高低音只影响球的视觉亮度/大小，不影响运动
 */
import { getActiveNotesInfo } from './piano.js'

export function createVisualizer(container) {
  const canvas = document.createElement('canvas')
  container.appendChild(canvas)
  const ctx = canvas.getContext('2d')
  let animId = null

  function randomVelocity(b) {
    const angle = Math.random() * Math.PI * 2
    const speed = 80 + Math.random() * 100
    b.vx = Math.cos(angle) * speed
    b.vy = Math.sin(angle) * speed
  }

  // 红球（低音）、绿球（高音）
  const red =   { x: 0.3, y: 0.5, vx: 0, vy: 0, r: 0.28, hue: 0,   sat: 80, light: 60, blur: 80 }
  const green = { x: 0.7, y: 0.5, vx: 0, vy: 0, r: 0.32, hue: 130, sat: 70, light: 58, blur: 100 }

  randomVelocity(red)
  randomVelocity(green)

  // 平滑力度（只影响视觉）
  let smoothLow = 0, smoothHigh = 0
  let idleTimer = 0
  let wasPlaying = false  // 检测演奏状态切换

  let w = 0, h = 0

  function resize() {
    const dpr = window.devicePixelRatio || 1
    w = container.clientWidth
    h = container.clientHeight
    canvas.width = w * dpr
    canvas.height = h * dpr
    canvas.style.width = w + 'px'
    canvas.style.height = h + 'px'
    ctx.scale(dpr, dpr)
  }

  let lastTime = 0

  function draw(now) {
    resize()
    if (!lastTime) lastTime = now
    const dt = Math.min((now - lastTime) / 1000, 0.05)
    lastTime = now

    const { lowCount, highCount } = getActiveNotesInfo()

    // 平滑力度（只影响视觉）
    const targetLow  = Math.min(lowCount / 4, 1)
    const targetHigh = Math.min(highCount / 4, 1)
    smoothLow  += (targetLow - smoothLow)  * Math.min(dt * 6, 1)
    smoothHigh += (targetHigh - smoothHigh) * Math.min(dt * 6, 1)

    const anyPlaying = lowCount > 0 || highCount > 0

    // 空闲计时
    if (anyPlaying) {
      idleTimer = 0
    } else {
      idleTimer += dt
    }

    // 两球目标位置固定：红球偏左、绿球偏右，垂直居中
    const spread  = 0.22
    const redTX   = 0.5 - spread
    const redTY   = 0.5
    const greenTX = 0.5 + spread
    const greenTY = 0.5

    ctx.clearRect(0, 0, w, h)

    const pairs = [
      { b: red,   energy: smoothLow,  tx: redTX,   ty: redTY },
      { b: green, energy: smoothHigh, tx: greenTX, ty: greenTY },
    ]

    for (const { b, energy, tx, ty } of pairs) {
      // ---- 演奏状态切换：刚切换到弹奏 → 清零速度，让吸引力立即生效 ----
      if (anyPlaying && !wasPlaying) {
        b.vx = 0
        b.vy = 0
      }

      // ---- 弹奏时：被吸引到目标位置 ----
      if (anyPlaying) {
        const attractStrength = 2.0 + energy * 0.8
        b.vx += (tx - b.x) * attractStrength * dt * 4
        b.vy += (ty - b.y) * attractStrength * dt * 3
      }

      wasPlaying = anyPlaying

      // ---- 物理运动 ----
      const damping = anyPlaying ? 0.25 : 0.06
      b.vx *= (1 - dt * damping)
      b.vy *= (1 - dt * damping)

      b.x += b.vx * dt / w
      b.y += b.vy * dt / h

      // ---- 视口反弹 ----
      if (b.x < 0) { b.x = 0; b.vx = Math.abs(b.vx) }
      if (b.x > 1) { b.x = 1; b.vx = -Math.abs(b.vx) }
      if (b.y < 0) { b.y = 0; b.vy = Math.abs(b.vy) }
      if (b.y > 1) { b.y = 1; b.vy = -Math.abs(b.vy) }

      // ---- 空闲超过 5 秒 → 恢复随机反弹 ----
      if (!anyPlaying && idleTimer >= 5 && Math.abs(b.vx) < 5 && Math.abs(b.vy) < 5) {
        randomVelocity(b)
      }

      // ---- 渲染 ----
      const cx = b.x * w
      const cy = b.y * h

      const pulse = 1 + energy * 0.6
      const radius = Math.min(w, h) * b.r * pulse
      const alpha = 0.20 + energy * 0.75
      const light = b.light + energy * 28

      ctx.save()

      // 大模糊光晕
      ctx.filter = `blur(${b.blur}px)`
      ctx.globalAlpha = alpha * 0.7
      const g1 = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 1.5)
      g1.addColorStop(0, `hsla(${b.hue}, ${b.sat}%, ${light}%, 0.6)`)
      g1.addColorStop(1, `hsla(${b.hue}, ${b.sat}%, ${light - 10}%, 0)`)
      ctx.fillStyle = g1
      ctx.fillRect(cx - radius * 1.5, cy - radius * 1.5, radius * 3, radius * 3)

      // 小模糊核心
      ctx.filter = `blur(${b.blur * 0.35}px)`
      ctx.globalAlpha = alpha * 0.5
      const g2 = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius)
      g2.addColorStop(0, `hsla(${b.hue}, ${b.sat + 15}%, ${light + 15}%, 0.7)`)
      g2.addColorStop(1, `hsla(${b.hue}, ${b.sat}%, ${light}%, 0)`)
      ctx.fillStyle = g2
      ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2)

      ctx.restore()
    }

    animId = requestAnimationFrame(draw)
  }

  function start() {
    resize()
    animId = requestAnimationFrame(draw)
  }

  function stop() {
    if (animId) { cancelAnimationFrame(animId); animId = null }
  }

  start()
  return { start, stop }
}
