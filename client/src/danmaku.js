/**
 * 弹幕 — 屏幕上半部分飘字
 * 同一会话同一颜色（低饱和），统一字号
 */
export function initDanmaku() {
  const container = document.getElementById('danmaku-container')
  if (!container) return

  let idCounter = 0
  const activeRows = {}

  // 会话内固定一个低饱和颜色
  const hues = [0, 30, 45, 130, 180, 220, 270, 330]
  const myColor = `hsla(${hues[Math.floor(Math.random() * hues.length)]}, 35%, 60%, 0.85)`

  function getRowIndex() {
    for (let i = 0; i < 6; i++) {
      if (!activeRows[i]) return i
    }
    return Math.floor(Math.random() * 6)
  }

  function add(text, isLocal) {
    const row = getRowIndex()
    activeRows[row] = true

    const el = document.createElement('div')
    el.className = 'danmaku-item' + (isLocal ? ' danmaku-local' : '')
    el.style.color = isLocal ? '#555' : myColor
    el.textContent = text

    const rowH = (container.clientHeight || window.innerHeight * 0.5) / 6
    el.style.top = (row * rowH + rowH * 0.2) + 'px'

    container.appendChild(el)

    const dur = 6 + Math.random() * 4
    el.style.animationDuration = dur + 's'

    el.addEventListener('animationend', () => {
      delete activeRows[row]
      el.remove()
    })
  }

  return { add }
}
