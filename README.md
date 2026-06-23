# 石榴钢琴 (Shiliu Piano)

多人实时在线钢琴弹奏应用，支持 WebMIDI 外接键盘、弹幕聊天。

## 功能

- **多人在线弹奏** — 一人弹奏，多人实时收听，节奏准确
- **弹幕聊天** — 发送弹幕，屏幕上半部分飘字
- **MIDI 外接键盘** — 支持 MIDI 键盘即插即用
- **琴键提示** — 显示/隐藏琴键音名
- **移动端适配** — 支持手机浏览器

## 快速开始

```bash
# 安装依赖
cd client && npm install

# 开发模式（前端热更新）
npm run dev

# 构建生产版本
npm run build

# 启动服务端（生产环境）
cd .. && node server.js
```

访问 `http://localhost:3003`

## 项目结构

```
├── client/                     # 前端（Vite + Vanilla JS）
│   ├── public/
│   │   ├── samples/piano/     # 钢琴采样音源 (61 个 MP3)
│   │   ├── favicon.svg        # 网站图标
│   │   └── assets/lib/        # 工具库
│   └── src/
│       ├── main.js            # 入口、Socket 事件、弹幕 UI
│       ├── piano.js           # 钢琴核心（键盘渲染 + Web Audio + WebMIDI + 远程调度）
│       ├── danmaku.js         # 弹幕飘字引擎
│       ├── visualizer.js      # 音频可视化
│       ├── notes.js           # 音符映射
│       ├── style.css          # 全局样式
│       └── visualizer.css     # 可视化样式
├── server.js                   # 服务端（Node.js + Socket.IO）
├── package.json
├── .gitignore
└── README.md
```

## 技术栈

- **前端**: Vite + Vanilla JavaScript
- **音频**: Web Audio API + 真实钢琴采样 MP3
- **实时通信**: Socket.IO (WebSocket)
- **MIDI**: WebMIDI API
- **服务端**: Node.js + Express

## 致谢

钢琴音源及部分代码灵感来自 [AutoPiano](https://github.com/AutoPiano/AutoPiano)

## 开源许可

本项目基于 [GNU General Public License v3.0 (GPLv3)](https://www.gnu.org/licenses/gpl-3.0.html) 开源。因参考项目 [AutoPiano](https://github.com/AutoPiano/AutoPiano) 采用 GPLv3 协议，本衍生作品同样遵循该协议。
