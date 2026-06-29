# 语音助手对话页面开发日志

**日期：** 2026-06-29

## 概述

开发了一个独立的语音对话页面，用户可通过语音与 web-pi 助手交互。页面使用 ASR API 进行语音识别，通过 mobile-adapter 中间件与 Session Gateway 通信。

## 文件结构

```
public/
├── voice.html          # 语音对话页面 HTML
├── voice.js            # 语音页面核心逻辑
└── styles.css          # 新增语音页面样式
```

## 技术架构

```
┌─────────────┐                    ┌──────────────────┐
│  voice.html │ ── ASR API ──────► │  ASR 服务 (8003)  │
│   (8787)    │                    └──────────────────┘
└──────┬──────┘
       │
       │ POST /chat
       ▼
┌──────────────────┐              ┌──────────────────┐
│ mobile-adapter   │ ────────────► │ Session Gateway  │
│    (8789)        │   /api/nl    │     (8787)       │
└──────────────────┘              └──────────────────┘
```

## 核心组件

### 1. AudioConverter
将浏览器录制的音频转换为 WAV 格式，确保 ASR API 兼容。

### 2. VoiceRecorder
管理麦克风录音，使用 MediaRecorder API。

### 3. ASRClient
调用 ASR API（`http://127.0.0.1:8003/v1/audio/transcriptions`）进行语音识别。

### 4. AssistantClient
调用 mobile-adapter 的 `/chat` 接口（`http://100.64.0.18:8789/chat`）与助手对话。

### 5. ChatUI
渲染对话消息列表，支持用户消息、助手回复、错误消息。

### 6. VoicePage
主控制器，协调录音、识别、对话流程。

## 状态机

```
idle → recording → processing → idle
```

| 状态 | 按钮文案 | 说明 |
|------|----------|------|
| idle | 🎤 点击录音 | 空闲状态 |
| recording | ⏹️ 停止录音 | 正在录音 |
| processing | ⏳ 处理中 | ASR 识别 + 助手回复 |

## API 接口

### ASR API

```
POST http://127.0.0.1:8003/v1/audio/transcriptions
Content-Type: multipart/form-data

参数：
- file: 音频文件 (WAV)
- model: "Qwen3-ASR-1.7b-Q4_K_M.gguf"

返回：
{
  "text": "识别结果",
  "type": "transcript.text.done"
}
```

### mobile-adapter /chat

```
POST http://100.64.0.18:8789/chat
Content-Type: application/json

请求体：
{
  "text": "用户输入",
  "user_id": "default"  // 可选
}

返回：
{
  "ok": true,
  "answer": "助手回复",
  "session": { ... }  // 可选
}
```

## 设置项

通过设置对话框配置，保存在 `localStorage.voiceAssistantSettings`：

| 设置项 | 默认值 |
|--------|--------|
| apiUrl | `http://100.64.0.18:8789/chat` |
| asrUrl | `http://127.0.0.1:8003/v1/audio/transcriptions` |
| asrModel | `Qwen3-ASR-1.7b-Q4_K_M.gguf` |

## 开发过程中的关键决策

### 1. 独立页面 vs 集成到主页面
**决策：独立页面**
- 原因：语音场景独立，不需要会话上下文，简化实现

### 2. 录音交互方式
**决策：点击开始/停止**
- 原因：用户明确控制录音时机，避免误触发

### 3. ASR 提示词
**决策：移除**
- 原因：ASR API 对 prompt 参数支持不稳定，识别准确率问题应在 ASR 服务端解决

### 4. TTS 语音播报
**决策：移除**
- 原因：简化流程，用户可通过视觉阅读回复

### 5. 后端接口选择
**决策：使用 mobile-adapter 的 /chat 接口**
- 原因：
  - 无需 Token 认证
  - ASR 识别不准的问题（如"绘画" vs "session"）由中间件处理
  - 与智能眼镜项目共享同一后端

## 浏览器兼容性

- 需要支持 MediaRecorder API
- 需要支持 AudioContext（WAV 转换）
- Safari 可能需要特殊处理音频格式

## 已知问题

1. **CORS 问题**：mobile-adapter 已配置 CORS 头，需确保服务运行正常
2. **内网地址访问**：默认 API 地址 `100.64.0.18` 是内网地址，需确保网络可达

## Git 提交记录

```
72d1daf feat: integrate with mobile-adapter /chat API
2040449 feat: remove TTS speech playback feature
2c15372 fix: remove ASR prompt feature
9a7faa3 feat: add ASR prompt parameter for better recognition
7125ee2 feat: add voice context prefix for assistant
2cc371c fix: add settings dialog and WAV conversion for voice page
df54420 feat: add voice assistant page
84c150f docs: add voice assistant implementation plan
32f8c00 docs: add voice assistant page design spec
```

## 后续优化方向

1. 添加录音波形可视化
2. 支持键盘快捷键（空格键录音）
3. 添加对话历史导出功能
4. 支持自定义 ASR 模型选择
