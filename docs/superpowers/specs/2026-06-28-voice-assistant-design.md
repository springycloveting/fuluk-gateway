# 语音助手对话页面设计

日期: 2026-06-28

## 概述

创建一个独立的语音对话页面 (`voice.html`)，用户可以通过语音与 web-pi 助手交互。页面使用本地 ASR API 进行语音识别，调用现有 `/api/nl` 接口与助手对话，并使用 Web Speech API 朗读助手回复。

## 需求总结

| 项目 | 选择 |
|------|------|
| 页面形式 | 独立 HTML 页面 (`voice.html`) |
| 录音方式 | 点击开始/停止 |
| 回复呈现 | 文字 + Web Speech API 朗读 |
| 会话上下文 | 不需要，纯助手对话 |

## 文件结构

```
public/
├── voice.html          # 语音对话页面
├── voice.js            # 语音页面逻辑
└── styles.css          # 复用现有样式，新增语音相关样式
```

## 核心组件

| 组件 | 职责 |
|------|------|
| `VoiceRecorder` | 管理麦克风录音，生成音频 Blob |
| `ASRClient` | 调用 ASR API，上传音频返回文字 |
| `AssistantClient` | 调用 `/api/nl` 发送文字，获取回复 |
| `TTSPlayer` | 使用 Web Speech API 朗读回复 |
| `ChatUI` | 渲染对话消息列表 |
| `VoicePage` | 主控制器，协调上述组件 |

## 技术选型

- **音频录制**：MediaRecorder API（浏览器原生）
- **音频格式**：WebM（Opus 编码），不支持时回退到 WAV（Safari 兼容）
- **HTTP 请求**：fetch API（与现有代码一致）
- **样式**：复用 styles.css，新增语音按钮和波形动画

## API 接口设计

### ASR API 调用

```
POST http://127.0.0.1:8003/v1/audio/transcriptions
Content-Type: multipart/form-data

参数：
- file: 音频文件 (WebM/WAV)
- model: "Qwen3-ASR-1.7b-Q4_K_M.gguf"

返回格式（需实测确认）：
- 可能是纯文本：直接返回识别文字
- 或 JSON 格式：{ "text": "识别文字" }

实现时需检测返回格式并提取文字
```

### 助手 API 调用

```
POST /api/nl
Authorization: Bearer <token>
Content-Type: application/json

请求体：
{
  "text": "识别出的文字"
}

返回：
{
  "command": { "type": "assistant", "source": "web-pi" },
  "ok": true,
  "answer": "助手回复的文字",
  "actions": [...]
}
```

### 配置管理

语音页面需要以下配置项：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `asrApiUrl` | `http://127.0.0.1:8003/v1/audio/transcriptions` | ASR API 地址 |
| `asrModel` | `Qwen3-ASR-1.7b-Q4_K_M.gguf` | ASR 模型名称 |
| `token` | 从 localStorage 读取 | 认证 token |

## UI 交互流程

### 录音状态机

```
idle → recording → processing → speaking → idle
```

| 状态 | 按钮文案 | 按钮样式 | 状态提示 |
|------|----------|----------|----------|
| idle | 🎤 点击录音 | 默认蓝色 | 点击开始录音 |
| recording | ⏹️ 停止录音 | 红色闪烁 | 正在录音... |
| processing | ⏳ 处理中 | 灰色禁用 | 正在识别... |
| speaking | 🔊 朗读中 | 绿色动画 | 正在播放回复 |

### 消息展示

**用户消息**：显示语音转文字结果 + 录音时长

**助手消息**：显示回复文字 + "重新朗读"按钮

## 错误处理

| 错误场景 | 用户提示 | 处理方式 |
|----------|----------|----------|
| 麦克风权限被拒绝 | "请允许麦克风权限" | 引导用户在浏览器设置中开启 |
| 录音失败 | "录音失败，请重试" | 返回 idle 状态 |
| ASR API 无响应 | "语音识别服务无响应" | 返回 idle，可重试 |
| ASR 识别为空 | "未识别到语音" | 返回 idle，提示用户重录 |
| 助手 API 错误 | "助手服务异常" | 显示错误信息，返回 idle |
| TTS 朗读失败 | "语音朗读失败" | 跳过朗读，仅显示文字 |

## 测试与验收

### 功能测试清单

| 测试项 | 验收标准 |
|--------|----------|
| 页面加载 | voice.html 正常加载，显示空白对话和录音按钮 |
| 麦克风权限 | 首次点击按钮时请求权限，拒绝后显示提示 |
| 录音功能 | 点击开始录音，显示时长计时；点击停止，生成音频 |
| ASR 识别 | 音频正确发送到 ASR API，返回识别文字 |
| 助手回复 | 文字发送到 `/api/nl`，返回助手回复并显示 |
| TTS 朗读 | 助手回复后自动朗读，可点击"重新朗读" |
| 对话历史 | 所有消息正确显示，滚动到最新消息 |
| 错误处理 | 各类错误场景显示友好提示 |

### 手动测试流程

1. 打开 `http://localhost:8787/voice.html`
2. 点击录音按钮，说"列出所有会话"
3. 点击停止按钮
4. 确认识别文字显示，助手回复显示
5. 确认 TTS 自动朗读回复
6. 再次录音，说"创建一个 codex 会话"
7. 确认助手执行创建操作并回复