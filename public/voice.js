// VoiceRecorder: 管理麦克风录音
class VoiceRecorder {
  constructor() {
    this.mediaRecorder = null;
    this.stream = null;
    this.chunks = [];
    this.startTime = 0;
  }

  // 检查浏览器支持
  static isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }

  // 获取支持的音频格式
  static getSupportedMimeType() {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
      'audio/wav'
    ];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }
    return 'audio/webm'; // 默认回退
  }

  // 请求麦克风权限并开始录音
  async start() {
    if (this.mediaRecorder) {
      throw new Error('Recording already in progress');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = VoiceRecorder.getSupportedMimeType();
    this.mediaRecorder = new MediaRecorder(this.stream, { mimeType });
    this.chunks = [];
    this.startTime = Date.now();

    return new Promise((resolve, reject) => {
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.chunks.push(event.data);
        }
      };

      this.mediaRecorder.onstart = () => resolve();
      this.mediaRecorder.onerror = (event) => reject(new Error(event.error?.message || 'Recording error'));

      this.mediaRecorder.start(100); // 每 100ms 收集一次数据
    });
  }

  // 停止录音并返回音频 Blob 和时长
  stop() {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder) {
        reject(new Error('No recording in progress'));
        return;
      }

      this.mediaRecorder.onstop = () => {
        const mimeType = this.mediaRecorder.mimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type: mimeType });
        const duration = (Date.now() - this.startTime) / 1000;

        // 清理
        this.chunks = [];
        if (this.stream) {
          this.stream.getTracks().forEach(track => track.stop());
          this.stream = null;
        }
        this.mediaRecorder = null;

        resolve({ blob, duration, mimeType });
      };

      this.mediaRecorder.stop();
    });
  }

  // 取消录音
  cancel() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.chunks = [];
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    this.mediaRecorder = null;
  }
}

// ASRClient: 调用 ASR API 进行语音识别
class ASRClient {
  constructor(options = {}) {
    this.apiUrl = options.apiUrl || 'http://127.0.0.1:8003/v1/audio/transcriptions';
    this.model = options.model || 'Qwen3-ASR-1.7b-Q4_K_M.gguf';
    this.timeout = options.timeout || 30000;
  }

  // 发送音频进行识别
  async transcribe(audioBlob) {
    const formData = new FormData();
    formData.append('file', audioBlob, 'recording.webm');
    formData.append('model', this.model);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        body: formData,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`ASR API error: ${response.status} ${text}`);
      }

      const contentType = response.headers.get('content-type') || '';
      let result;

      if (contentType.includes('application/json')) {
        const json = await response.json();
        // 兼容多种 JSON 格式
        result = json.text || json.result || json.transcription || JSON.stringify(json);
      } else {
        // 纯文本返回
        result = await response.text();
      }

      // 清理结果
      result = result.trim();

      if (!result) {
        throw new Error('ASR returned empty result');
      }

      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error('ASR API timeout');
      }
      throw error;
    }
  }
}

// TTSPlayer: 使用 Web Speech API 朗读文本
class TTSPlayer {
  constructor(options = {}) {
    this.lang = options.lang || 'zh-CN';
    this.rate = options.rate || 1;
    this.pitch = options.pitch || 1;
    this.speaking = false;
  }

  // 检查浏览器支持
  static isSupported() {
    return 'speechSynthesis' in window;
  }

  // 朗读文本
  speak(text) {
    return new Promise((resolve, reject) => {
      if (!TTSPlayer.isSupported()) {
        reject(new Error('Speech synthesis not supported'));
        return;
      }

      // 取消之前的朗读
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = this.lang;
      utterance.rate = this.rate;
      utterance.pitch = this.pitch;

      utterance.onstart = () => {
        this.speaking = true;
      };

      utterance.onend = () => {
        this.speaking = false;
        resolve();
      };

      utterance.onerror = (event) => {
        this.speaking = false;
        // 忽略被取消的错误
        if (event.error === 'canceled' || event.error === 'interrupted') {
          resolve();
        } else {
          reject(new Error(`Speech error: ${event.error}`));
        }
      };

      window.speechSynthesis.speak(utterance);
    });
  }

  // 停止朗读
  stop() {
    if (TTSPlayer.isSupported()) {
      window.speechSynthesis.cancel();
    }
    this.speaking = false;
  }

  // 检查是否正在朗读
  isSpeaking() {
    return this.speaking || (TTSPlayer.isSupported() && window.speechSynthesis.speaking);
  }
}

// AssistantClient: 调用 /api/nl 与助手对话
class AssistantClient {
  constructor(options = {}) {
    this.getToken = options.getToken || (() => localStorage.getItem('sessionGatewayToken') || '');
  }

  // 发送消息给助手
  async chat(text) {
    const token = this.getToken();
    if (!token) {
      throw new Error('No authentication token');
    }

    const response = await fetch('/api/nl', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Assistant API error: ${response.status} ${errorText}`);
    }

    const result = await response.json();

    // 提取回复文本
    if (result.answer) {
      return result.answer;
    }
    if (result.command && result.command.type === 'assistant') {
      return result.answer || '操作已完成';
    }
    // 回退：尝试格式化整个结果
    return JSON.stringify(result, null, 2);
  }
}

// ChatUI: 渲染对话消息
class ChatUI {
  constructor(container) {
    this.container = container;
    this.messages = [];
    this.maxMessages = 100;
  }

  // 添加消息
  append(options) {
    const message = {
      role: options.role, // 'user' | 'assistant' | 'error'
      text: options.text || '',
      duration: options.duration || null, // 用户消息的录音时长
      createdAt: new Date().toISOString()
    };

    this.messages.push(message);

    // 限制消息数量
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }

    this.render();
    this.scrollToBottom();
    return message;
  }

  // 清空消息
  clear() {
    this.messages = [];
    this.render();
  }

  // 渲染消息列表
  render() {
    if (!this.messages.length) {
      this.container.innerHTML = '<div class="voice-empty">点击下方按钮开始语音对话</div>';
      return;
    }

    this.container.innerHTML = this.messages.map((msg, index) => {
      const roleLabel = this.getRoleLabel(msg.role);
      const durationText = msg.duration ? `${msg.duration.toFixed(1)}s` : '';
      const replayButton = msg.role === 'assistant'
        ? `<button type="button" data-replay="${index}" class="ghost">重新朗读</button>`
        : '';

      return `
        <div class="voice-message ${this.escapeHtml(msg.role)}">
          <div class="voice-message-meta">
            <span class="voice-message-role">${this.escapeHtml(roleLabel)}</span>
            ${durationText ? `<span class="voice-message-duration">${this.escapeHtml(durationText)}</span>` : ''}
          </div>
          <div class="voice-message-text">${this.escapeHtml(msg.text)}</div>
          ${replayButton ? `<div class="voice-message-actions">${replayButton}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  // 获取角色标签
  getRoleLabel(role) {
    const labels = {
      user: '你',
      assistant: 'web-pi',
      error: '错误'
    };
    return labels[role] || role;
  }

  // 滚动到底部
  scrollToBottom() {
    this.container.scrollTop = this.container.scrollHeight;
  }

  // HTML 转义
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// VoicePage: 主控制器
class VoicePage {
  constructor() {
    // 状态
    this.state = 'idle'; // idle | recording | processing | speaking

    // DOM 元素
    this.messagesContainer = document.getElementById('voice-messages');
    this.voiceBtn = document.getElementById('voice-btn');
    this.voiceStatus = document.getElementById('voice-status');
    this.clearBtn = document.getElementById('clear-chat');

    // 组件
    this.recorder = new VoiceRecorder();
    this.asrClient = new ASRClient();
    this.ttsPlayer = new TTSPlayer();
    this.assistantClient = new AssistantClient();
    this.chatUI = new ChatUI(this.messagesContainer);

    // 绑定事件
    this.bindEvents();
  }

  bindEvents() {
    // 录音按钮
    this.voiceBtn.addEventListener('click', () => this.handleButtonClick());

    // 清空对话
    this.clearBtn.addEventListener('click', () => {
      this.ttsPlayer.stop();
      this.chatUI.clear();
      this.setState('idle');
    });

    // 重新朗读按钮（事件委托）
    this.messagesContainer.addEventListener('click', (event) => {
      const replayBtn = event.target.closest('[data-replay]');
      if (replayBtn) {
        const index = parseInt(replayBtn.dataset.replay, 10);
        const message = this.chatUI.messages[index];
        if (message && message.role === 'assistant') {
          this.speakText(message.text);
        }
      }
    });
  }

  async handleButtonClick() {
    switch (this.state) {
      case 'idle':
        await this.startRecording();
        break;
      case 'recording':
        await this.stopRecording();
        break;
      case 'processing':
      case 'speaking':
        // 这两个状态下按钮禁用，不做处理
        break;
    }
  }

  async startRecording() {
    try {
      // 检查浏览器支持
      if (!VoiceRecorder.isSupported()) {
        this.showError('浏览器不支持录音功能');
        return;
      }

      // 停止之前的朗读
      this.ttsPlayer.stop();

      this.setState('recording');
      await this.recorder.start();
    } catch (error) {
      console.error('Recording start error:', error);
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        this.showError('请允许麦克风权限');
      } else if (error.name === 'NotFoundError') {
        this.showError('未找到麦克风设备');
      } else {
        this.showError(`录音失败: ${error.message}`);
      }
      this.setState('idle');
    }
  }

  async stopRecording() {
    try {
      const { blob, duration } = await this.recorder.stop();

      // 检查录音时长
      if (duration < 0.5) {
        this.showError('录音时间太短');
        this.setState('idle');
        return;
      }

      this.setState('processing');

      // 调用 ASR 识别
      const text = await this.asrClient.transcribe(blob);

      // 显示用户消息
      this.chatUI.append({ role: 'user', text, duration });

      // 调用助手
      const answer = await this.assistantClient.chat(text);

      // 显示助手回复
      this.chatUI.append({ role: 'assistant', text: answer });

      // 朗读回复
      await this.speakText(answer);

    } catch (error) {
      console.error('Processing error:', error);
      this.showError(error.message || '处理失败');
      this.setState('idle');
    }
  }

  async speakText(text) {
    if (!TTSPlayer.isSupported()) {
      console.warn('TTS not supported, skipping speech');
      this.setState('idle');
      return;
    }

    try {
      this.setState('speaking');
      await this.ttsPlayer.speak(text);
    } catch (error) {
      console.error('TTS error:', error);
      // TTS 失败不影响主流程，仅记录
    }
    this.setState('idle');
  }

  setState(newState) {
    this.state = newState;
    this.updateUI();
  }

  updateUI() {
    const stateConfig = {
      idle: {
        btnIcon: '🎤',
        btnText: '点击录音',
        btnClass: '',
        status: '点击开始录音',
        disabled: false
      },
      recording: {
        btnIcon: '⏹️',
        btnText: '停止录音',
        btnClass: 'recording',
        status: '正在录音...',
        disabled: false
      },
      processing: {
        btnIcon: '⏳',
        btnText: '处理中',
        btnClass: '',
        status: '正在识别...',
        disabled: true
      },
      speaking: {
        btnIcon: '🔊',
        btnText: '朗读中',
        btnClass: 'speaking',
        status: '正在播放回复',
        disabled: true
      }
    };

    const config = stateConfig[this.state];
    if (!config) return;

    this.voiceBtn.querySelector('.voice-btn-icon').textContent = config.btnIcon;
    this.voiceBtn.querySelector('.voice-btn-text').textContent = config.btnText;
    this.voiceBtn.className = `voice-btn ${config.btnClass}`;
    this.voiceBtn.disabled = config.disabled;
    this.voiceStatus.textContent = config.status;
  }

  showError(message) {
    this.chatUI.append({ role: 'error', text: message });
  }
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  new VoicePage();
});

// 导出
export { VoiceRecorder, ASRClient, TTSPlayer, AssistantClient, ChatUI };
