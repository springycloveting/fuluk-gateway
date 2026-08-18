# Voice.html 功能说明

## 整体架构

这是一个**语音助手对话界面**，包含四个核心模块：

| 模块 | 类名 | 功能 |
|------|------|------|
| 音频转换 | `AudioConverter` | 将录音转换为 WAV 格式 |
| 录音器 | `VoiceRecorder` | 管理麦克风录音 |
| ASR客户端 | `ASRClient` | 调用语音识别 API |
| 助手客户端 | `AssistantClient` | 调用对话助手 API |
| 聊天UI | `ChatUI` | 渲染对话消息 |
| 主控制器 | `VoicePage` | 协调各组件、管理状态 |

---

## 1. 录音功能 (VoiceRecorder)

```
状态: idle → recording → idle
```

**流程：**
1. 点击录音按钮 → 请求麦克风权限
2. 开始录音，每 100ms 收集一次音频数据
3. 再次点击 → 停止录音，返回 `{ blob, duration, mimeType }`

**音频格式优先级：**
- `audio/webm;codecs=opus` (首选)
- `audio/webm`
- `audio/ogg;codecs=opus`
- `audio/mp4`
- `audio/wav`

**安卓移植要点：**
- 使用 `MediaRecorder` 或 `AudioRecord` API
- 推荐输出 WAV 或 WebM/Opus 格式

---

## 2. 音频转换 (AudioConverter)

**功能：** 将浏览器录音格式转换为标准 WAV

**WAV 格式参数：**
- 编码：PCM (format=1)
- 位深：16-bit
- 采样率：与源音频一致
- 声道：与源音频一致

**安卓移植要点：**
- 如果安卓录音直接支持 WAV，可跳过此步骤
- 否则需实现 PCM → WAV 的转换逻辑

---

## 3. ASR 语音识别 (ASRClient)

**API 接口：**
```
POST {asrUrl}
Content-Type: multipart/form-data

file: recording.wav (WAV 音频文件)
model: Qwen3-ASR-1.7b-Q4_K_M.gguf (模型名称)
```

**默认配置：**
- URL: `http://127.0.0.1:8003/v1/audio/transcriptions`
- Model: `Qwen3-ASR-1.7b-Q4_K_M.gguf`
- Timeout: 30 秒

**返回格式（兼容多种）：**
- JSON: `{ "text": "识别结果" }` 或 `{ "result": "..." }` 或 `{ "transcription": "..." }`
- 纯文本: 直接返回识别结果

---

## 4. 助手对话 (AssistantClient)

**API 接口：**
```
POST {apiUrl}
Content-Type: application/json

{ "text": "用户输入的文本" }
```

**默认 URL:** `http://100.64.0.18:8789/chat`

**返回格式：**
```json
{ "answer": "助手回复内容" }
```

---

## 5. 完整交互流程

```
用户点击录音
    ↓
开始录音 (状态: recording)
    ↓
用户再次点击停止
    ↓
停止录音，获取音频 blob + 时长
    ↓
时长检查 (< 0.5秒则报错)
    ↓
调用 ASR API 识别 (状态: processing)
    ↓
显示用户消息 (文本 + 录音时长)
    ↓
调用助手 API 获取回复
    ↓
显示助手回复 (状态回到 idle)
```

---

## 6. 状态机

| 状态 | 按钮图标 | 按钮文字 | 按钮状态 | 状态栏文字 |
|------|---------|---------|---------|-----------|
| idle | 🎤 | 点击录音 | 可点击 | 点击开始录音 |
| recording | ⏹️ | 停止录音 | 可点击 | 正在录音... |
| processing | ⏳ | 处理中 | 禁用 | 正在识别... |

---

## 7. 设置项

存储在 `localStorage.voiceAssistantSettings`：

```json
{
  "apiUrl": "http://100.64.0.18:8789/chat",
  "asrUrl": "http://127.0.0.1:8003/v1/audio/transcriptions",
  "asrModel": "Qwen3-ASR-1.7b-Q4_K_M.gguf"
}
```

---

## 8. 安卓 App 移植建议

| 功能 | 安卓实现 |
|------|---------|
| 录音 | `MediaRecorder` 或 `AudioRecord` |
| HTTP 请求 | `OkHttp` 或 `Retrofit` |
| JSON 解析 | `Gson` 或 `Moshi` |
| 设置存储 | `SharedPreferences` |
| UI 状态管理 | ViewModel + LiveData/StateFlow |

### 关键 API 调用代码示例（Kotlin 伪代码）

```kotlin
// ASR 请求
val wavFile = File(cacheDir, "recording.wav")
val requestBody = MultipartBody.Builder()
    .setType(MultipartBody.FORM)
    .addFormDataPart("model", "Qwen3-ASR-1.7b-Q4_K_M.gguf")
    .addFormDataPart("file", "recording.wav",
        wavFile.asRequestBody("audio/wav".toMediaType()))
    .build()

val request = Request.Builder()
    .url(asrUrl)
    .post(requestBody)
    .build()

val response = okHttpClient.newCall(request).execute()
val result = response.body?.string() // 识别结果

// 助手请求
val json = JSONObject().put("text", userText)
val assistantRequest = Request.Builder()
    .url(apiUrl)
    .post(json.toString().toRequestBody("application/json".toMediaType()))
    .build()

val assistantResponse = okHttpClient.newCall(assistantRequest).execute()
val answer = JSONObject(assistantResponse.body?.string()).getString("answer")
```

### 录音权限

在 `AndroidManifest.xml` 中添加：

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.INTERNET" />
```

### MediaRecorder 示例

```kotlin
val mediaRecorder = MediaRecorder().apply {
    setAudioSource(MediaRecorder.AudioSource.MIC)
    setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
    setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
    setOutputFile(outputFile.absolutePath)
    prepare()
    start()
}

// 停止录音
mediaRecorder.apply {
    stop()
    release()
}
```

---

## 9. 错误处理

| 错误场景 | 提示信息 |
|---------|---------|
| 浏览器不支持录音 | 浏览器不支持录音功能 |
| 麦克风权限被拒绝 | 请允许麦克风权限 |
| 未找到麦克风设备 | 未找到麦克风设备 |
| 录音时间太短 (<0.5秒) | 录音时间太短 |
| ASR API 超时 | ASR API timeout |
| ASR 返回空结果 | ASR returned empty result |
| 助手 API 错误 | Assistant API error: {status} |

---

## 10. UI 组件结构

```
voice-page
├── voice-header
│   ├── 返回链接
│   ├── 标题 "语音助手"
│   └── 操作按钮 (设置、清空)
├── voice-messages (对话消息容器)
│   └── voice-message (单条消息)
│       ├── voice-message-meta (角色 + 时长)
│       └── voice-message-text (消息内容)
└── voice-controls
    ├── voice-status (状态文字)
    └── voice-btn (录音按钮)
        ├── voice-btn-icon (图标)
        └── voice-btn-text (文字)
```

---

## 11. 消息数据结构

```typescript
interface Message {
  role: 'user' | 'assistant' | 'error';
  text: string;
  duration: number | null;  // 用户消息的录音时长(秒)
  createdAt: string;        // ISO 日期字符串
}
```

消息数量上限：100 条（超出后自动删除最早的）
