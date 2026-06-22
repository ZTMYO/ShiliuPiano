/**
 * 可视化 — 红绿双色模糊小球
 * 红色响应低音区，绿色响应高音区
 * 弹奏低音 → 红球胀大往左跑；弹奏高音 → 绿球胀大往右跑
 */
import { getActiveNotesInfo } from './piano.js'

export function createVisualizer(container) {
  const canvas = document.createElement('canvas')
  container.appendChild(canvas)
  const ctx = canvas.getContext('2d')
  let animId = null

  // 红色 = 低音，绿色 = 高音
  const red =  { px: 0.5, py: 0.5, vx: 0, vy: 0, r: 0.28, hue: 0,   sat: 80, light: 60, blur: 80 }
  const green = { px: 0.5, py: 0.5, vx: 0, vy: 0, r: 0.32, hue: 130, sat: 70, light: 58, blur: 100 }

  // 平滑值
  let smoothLow = 0, smoothHigh = 0

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

  function randomize(b) {
    const speed = 15 + Math.random() * 40
    const angle = Math.random() * Math.PI * 2
    b.vx = Math.cos(angle) * speed
    b.vy = Math.sin(angle) * speed
  }

  // 初始随机
  randomize(red)
  randomize(green)

  let lastTime = 0

  function draw(now) {
    resize()
    if (!lastTime) lastTime = now
    const dt = Math.min((now - lastTime) / 1000, 0.05)
    lastTime = now

    const { lowCount, highCount } = getActiveNotesInfo()

    smoothLow  += (lowCount - smoothLow)  * Math.min(dt * 8, 1)
    smoothHigh += (highCount - smoothHigh) * Math.min(dt * 8, 1)

    const lowNorm  = Math.min(smoothLow / 3, 1)
    const highNorm = Math.min(smoothHigh / 3, 1)
    const hasLow  = lowCount > 0
    const hasHigh = highCount > 0

    ctx.clearRect(0, 0, w, h)

    // 绘制两个小球
    const pairs = [
      { b: red,  energy: lowNorm,  attract: 'left',  has: hasLow },
      { b: green, energy: highNorm, attract: 'right', has: hasHigh },
    ]

    for (const { b, energy, attract, has } of pairs) {
      if (has) {
        // 弹奏时向对应侧吸引 + 上下轻微浮动
        const tx = attract === 'left' ? 0.2 : 0.8
        const ty = 0.4 + Math.sin(now / 1000 * 0.8 + b.hue) * 0.15
        b.vx += (tx - b.px) * dt * 1.8
        b.vy += (ty - b.py) * dt * 1.2
      }

      // 物理运动
      b.px += b.vx * dt / w
      b.py += b.vy * dt / h
      b.vx *= (1 - dt * 0.4)
      b.vy *= (1 - dt * 0.4)

      // 边界反弹
      if (b.px < 0) { b.px = 0; b.vx = Math.abs(b.vx) * 0.8 }
      if (b.px > 1) { b.px = 1; b.vx = -Math.abs(b.vx) * 0.8 }
      if (b.py < 0) { b.py = 0; b.vy = Math.abs(b.vy) * 0.8 }
      if (b.py > 1) { b.py = 1; b.vy = -Math.abs(b.vy) * 0.8 }

      // 防止卡死
      if (!has && Math.abs(b.vx) < 5 && Math.abs(b.vy) < 5) randomize(b)

      const cx = b.px * w
      const cy = b.py * h

      const pulse = 1 + energy * 0.8
      const r = Math.min(w, h) * b.r * pulse
      const alpha = 0.12 + energy * 0.68
      const light = b.light + energy * 25

      ctx.save()

      // 大模糊光晕
      ctx.filter = `blur(${b.blur}px)`
      ctx.globalAlpha = alpha * 0.7
      const g1 = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 1.5)
      g1.addColorStop(0, `hsla(${b.hue}, ${b.sat}%, ${light}%, 0.6)`)
      g1.addColorStop(1, `hsla(${b.hue}, ${b.sat}%, ${light - 10}%, 0)`)
      ctx.fillStyle = g1
      ctx.fillRect(cx - r * 1.5, cy - r * 1.5, r * 3, r * 3)

      // 小模糊核心
      ctx.filter = `blur(${b.blur * 0.35}px)`
      ctx.globalAlpha = alpha * 0.5
      const g2 = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
      g2.addColorStop(0, `hsla(${b.hue}, ${b.sat + 15}%, ${light + 15}%, 0.7)`)
      g2.addColorStop(1, `hsla(${b.hue}, ${b.sat}%, ${light}%, 0)`)
      ctx.fillStyle = g2
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2)

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
