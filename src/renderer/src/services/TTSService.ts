// TTS服务，用于文字转语音功能
import { TTSProvider } from '@renderer/types'
import { getKokoroWorker } from '@renderer/workers/KokoroWorker'

class TTSService {
  private kokoroWorker: ReturnType<typeof getKokoroWorker> | null = null;
  private static instance: TTSService
  private audio: HTMLAudioElement | null = null
  private isPlaying = false
  private audioPlayer: HTMLAudioElement | null = null
  private playerContainer: HTMLElement | null = null
  // 使用内存缓存而不是文件缓存
  private readonly maxCacheSize: number = 20
  private audioCache: Map<string, { blob: Blob, url: string, timestamp: number }> = new Map()
  // 最后播放的音频的URI
  private lastPlayedAudioUri: string | null = null

  public static getInstance(): TTSService {
    if (!TTSService.instance) {
      TTSService.instance = new TTSService()
    }
    return TTSService.instance
  }

  /**
   * 将文本转换为语音并播放
   * @param text 要转换的文本
   * @param provider TTS提供商配置
   * @returns 
   */
  public async speakText(text: string, provider: TTSProvider): Promise<void> {
    if (!text) {
      console.error('无效的文本')
      window.message.error({ content: '无效的文本内容', key: 'tts-error' })
      return
    }

    if (this.isPlaying) {
      this.stopSpeaking()
    }
    
    // 处理本地Kokoro模型
    if (provider.type === 'kokoro' && provider.model === 'local') {
      try {
        console.log("使用本地Kokoro TTS模型生成语音");
        
        // 初始化KokoroWorker (如果尚未初始化)
        if (!this.kokoroWorker) {
          this.kokoroWorker = getKokoroWorker({ 
            dtype: 'fp32' // 默认配置，可以根据用户设置调整
          });
          
          // 第一次使用时要显示初始化信息
          window.message.loading({ 
            content: '正在加载语音模型，首次加载可能需要一些时间...', 
            key: 'kokoro-init', 
            duration: 0 
          });
          
          await this.kokoroWorker.init().catch(err => {
            console.error('初始化Kokoro模型失败:', err);
            window.message.error({ 
              content: `初始化Kokoro模型失败: ${err.message || '未知错误'}`, 
              key: 'kokoro-error' 
            });
            throw err;
          });
          
          window.message.success({ 
            content: '语音模型加载完成', 
            key: 'kokoro-init' 
          });
        }
        
        // 获取语音URL
        // 使用预设的中文语音列表
        const chineseVoices = [
          'zf_xiaoxiao', 'zf_qingxin', 'zf_tianyi', 'zf_huiyu',
          'zm_yifeng', 'zm_honghu', 'zm_sichuan'
        ];
        
        // 如果没有选择语音或选择的不是中文语音，默认使用zf_xiaoxiao
        let voiceId = provider.voice || 'zf_xiaoxiao';
        if (!voiceId.startsWith('z')) {
          console.log(`所选语音'${voiceId}'不是中文语音，切换到默认中文语音`);
          voiceId = 'zf_xiaoxiao';
        }
        
        console.log(`使用语音ID: ${voiceId}`);
        
        window.message.loading({ 
          content: '正在生成语音...', 
          key: 'kokoro-generate', 
          duration: 0 
        });
        
        const audioUrl = await this.kokoroWorker.generate({
          text,
          voice: voiceId
        }).catch(err => {
          console.error('Kokoro语音生成失败:', err);
          window.message.error({ 
            content: `语音生成失败: ${err.message || '未知错误'}`, 
            key: 'kokoro-generate' 
          });
          throw err;
        });
        
        window.message.success({ 
          content: '语音生成完成', 
          key: 'kokoro-generate' 
        });
        
        console.log(`生成的音频URL: ${audioUrl}`);
        
        // 播放生成的音频
        this.playAudio(audioUrl);
        return;
      } catch (error) {
        console.error('本地Kokoro TTS处理失败:', error);
        window.message.error({ 
          content: `本地语音合成失败: ${error instanceof Error ? error.message : '未知错误'}`, 
          key: 'tts-error' 
        });
        return;
      }
    }
    
    // 处理远程API
    if (!provider?.apiKey) {
      console.error('无效的API配置')
      window.message.error({ content: '无效的TTS配置，请在设置中配置TTS API', key: 'tts-error' })
      return
    }

    try {
      const apiUrl = this.getApiUrl(provider)
      
      if (!apiUrl) {
        window.message.error({ content: '不支持的TTS提供商', key: 'tts-provider-error' })
        return
      }

      // 创建Headers
      const headers: HeadersInit = {
        'Content-Type': 'application/json',
      }

      // 如果API密钥不为空，添加到请求头
      if (provider.apiKey) {
        if (provider.type === 'azure') {
          headers['Ocp-Apim-Subscription-Key'] = provider.apiKey
        } else {
          headers['Authorization'] = `Bearer ${provider.apiKey}`
        }
      }

      // 构建请求体
      let body: string | undefined = undefined
      
      if (provider.type === 'openai') {
        body = JSON.stringify({
          model: provider.model || 'tts-1',
          input: text,
          voice: provider.voice || 'alloy'
        })
      } else if (provider.type === 'azure') {
        body = JSON.stringify({
          text: text,
          voice: provider.voice || 'zh-CN-XiaoxiaoNeural'
        })
      } else if (provider.type === 'kokoro') {
        // 检查是否为OpenAI兼容的端点调用形式
        const isOpenAICompatMode = provider.useOpenAICompat === true;
        
        if (isOpenAICompatMode) {
          // 使用OpenAI兼容格式构建请求
          // 获取所选的voice，使用安全的默认值
          let voiceId = provider.voice || '';
          
          // 检查voice是否是有效的中文语音，如不是则设置为zf_xiaoxiao
          if (!voiceId || !voiceId.startsWith('z')) {
            voiceId = 'zf_xiaoxiao';
            console.log('使用默认中文语音: zf_xiaoxiao');
          }
          
          // 使用标准的OpenAI TTS参数格式，简化请求
          const requestParams: any = {
            model: provider.model || 'tts-1',
            input: text,
            voice: voiceId,
            response_format: 'mp3'
          };
          
          // 添加Kokoro特有的参数
          if (provider.lang) {
            requestParams.lang_code = provider.lang;
          }
          
          body = JSON.stringify(requestParams);
          console.log('Kokoro TTS请求参数:', requestParams);
        } else {
          // 使用原有的Kokoro TTS请求格式
          const requestParams: Record<string, any> = {
            text: text,
            format: 'mp3',     // 输出格式
            speed: 1.0,        // 语速
            volume: 1.0,       // 音量
            pitch: 0.0,        // 音调
            encoding: 'base64' // 数据编码
          }
          
          // 根据是否有自定义音色来设置参数
          if (provider.voice) {
            requestParams.speaker = provider.voice;
          }
          
          // 如果有自定义模型，则添加模型参数
          if (provider.model) {
            requestParams.model = provider.model;
          }
          
          body = JSON.stringify(requestParams);
        }
      }

      console.log('TTS请求参数:', { url: apiUrl, body });
      
      // 发送请求
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body
      })

      if (!response.ok) {
        throw new Error(`TTS API请求失败: ${response.status} ${response.statusText}`)
      }

      // 处理不同API的响应
      let audioUrl: string = '';
      
      if (provider.type === 'openai') {
        // OpenAI返回音频数据
        const blob = await response.blob()
        audioUrl = URL.createObjectURL(blob)
      } else if (provider.type === 'azure') {
        // Azure返回直接可用的音频URL或二进制数据
        const data = await response.json()
        audioUrl = data.audioUrl || URL.createObjectURL(await response.blob())
      } else if (provider.type === 'kokoro') {
        // 检查是否为OpenAI兼容模式
        const isOpenAICompatMode = provider.useOpenAICompat === true;
        
        if (isOpenAICompatMode) {
          try {
            // 直接检查响应的内容类型
            const contentType = response.headers.get('Content-Type') || '';
            console.log('响应Content-Type:', contentType);
            
            // 先克隆响应对象，因为我们可能需要多次使用响应体
            const responseClone = response.clone();
            
            // 优先检查响应是否直接是音频数据
            if (contentType.includes('audio/') || contentType.includes('application/octet-stream')) {
              // 如果直接返回了音频数据，直接使用
              console.log('服务器返回了音频数据, Content-Type:', contentType);
              try {
                // 获取原始数据
                console.log('准备获取音频数据...');
                
                // 提供下载选项，便于调试
                const arrayBuffer = await response.arrayBuffer();
                console.log('获取到原始数据，大小:', arrayBuffer.byteLength, '字节');
                
                if (arrayBuffer.byteLength > 0) {
                  // 创建多种格式的blob尝试不同的MIME类型
                  const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
                  console.log('创建的Blob大小:', blob.size, 'type:', blob.type);
                  
                  // 使用内存缓存保存并创建播放器
                  this.cacheAndPlayAudioBlob(blob, text);
                  
                  // 尝试不同的方式播放
                  audioUrl = URL.createObjectURL(blob);
                  console.log('从响应创建MP3 Blob URL:', audioUrl);
                  
                  // 直接创建音频元素并尝试播放
                  window.message.info({ 
                    content: `音频数据已准备好，可以点击右下角下载按钮测试`, 
                    duration: 5 
                  });
                } else {
                  throw new Error('服务器返回了空的音频数据');
                }
              } catch (error) {
                console.error('处理音频数据时出错:', error);
                throw error;
              }
            } 
            // 如果是JSON响应，检查是否有下载链接或其他信息
            else if (contentType.includes('application/json')) {
              // 尝试解析JSON响应
              const jsonData = await response.json();
              console.log('TTS API返回JSON数据:', jsonData);
              
              if (jsonData.error) {
                throw new Error(`TTS API错误: ${jsonData.error.message || JSON.stringify(jsonData.error)}`);
              }
              
              // 检查是否有直接的URL字段
              if (jsonData.url) {
                // 使用jsonData.url字段作为音频URL
                console.log('使用返回的url字段获取音频:', jsonData.url);
                
                // 创建headers对象，包含所有可能需要的授权信息
                const audioHeaders: HeadersInit = {
                  'Accept': 'audio/mpeg, audio/*, */*',
                };
                
                if (provider.apiKey) {
                  audioHeaders['Authorization'] = `Bearer ${provider.apiKey}`;
                }
                
                // 获取音频数据
                const audioResponse = await fetch(jsonData.url, {
                  method: 'GET',
                  headers: audioHeaders,
                  credentials: 'include'
                });
                
                if (!audioResponse.ok) {
                  throw new Error(`获取音频数据失败: ${audioResponse.status}`);
                }
                
                const audioBlob = await audioResponse.blob();
                if (audioBlob.size === 0) {
                  throw new Error('获取到的音频文件为空');
                }
                
                audioUrl = URL.createObjectURL(audioBlob);
                console.log('已创建音频Blob URL:', audioUrl, 'Blob大小:', audioBlob.size);
              } 
              // 如果有base64编码的音频数据
              else if (jsonData.audio || jsonData.audio_data) {
                const base64Data = jsonData.audio || jsonData.audio_data;
                console.log('使用返回的音频base64数据');
                
                // 创建Base64音频的Blob对象
                const byteCharacters = atob(base64Data);
                const byteNumbers = new Array(byteCharacters.length);
                
                for (let i = 0; i < byteCharacters.length; i++) {
                  byteNumbers[i] = byteCharacters.charCodeAt(i);
                }
                
                const byteArray = new Uint8Array(byteNumbers);
                const blob = new Blob([byteArray], { type: 'audio/mp3' });
                audioUrl = URL.createObjectURL(blob);
                console.log('从base64创建Blob URL, 大小:', blob.size);
              } else {
                throw new Error('API响应中没有可用的音频数据');
              }
            } 
            // 以下为备用处理方式
            else {
              // 如果没有下载链接，尝试直接获取音频数据
              const contentType = response.headers.get('Content-Type') || '';
              
              if (contentType.includes('audio/')) {
                // 如果Content-Type表明这是音频数据
                const blob = await response.blob();
                audioUrl = URL.createObjectURL(blob);
                console.log('使用Blob播放音频:', blob.type, blob.size);
              } else {
                // 尝试解析JSON响应
                const data = await response.json();
                
                if (data.error) {
                  throw new Error(`TTS API错误: ${data.error.message || JSON.stringify(data.error)}`);
                }
                
                if (data.url) {
                  audioUrl = data.url;
                  console.log('使用API返回的URL播放:', audioUrl);
                } else {
                  throw new Error('无法解析API响应为有效音频');
                }
              }
            }
          } catch (error) {
            console.error('处理响应时出错:', error);
            
            // 如果出现JSON解析错误，可能是直接返回了二进制数据
            if (error instanceof SyntaxError) {
              const blob = await response.blob();
              if (blob.size > 0) {
                audioUrl = URL.createObjectURL(blob);
                console.log('回退到直接创建Blob URL');
              } else {
                throw new Error('服务器返回了空的音频数据');
              }
            } else {
              throw error; // 重新抛出其他错误
            }
          }
        } else {
          // Kokoro TTS标准模式可能返回base64编码的音频数据
          const data = await response.json();
          
          if (data.audio_base64) {
            // 创建Base64音频的Blob对象
            const byteCharacters = atob(data.audio_base64);
            const byteNumbers = new Array(byteCharacters.length);
            
            for (let i = 0; i < byteCharacters.length; i++) {
              byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], { type: 'audio/mp3' });
            audioUrl = URL.createObjectURL(blob);
          } else if (data.audioUrl || data.url) {
            // 如果返回直接URL
            audioUrl = data.audioUrl || data.url;
          } else {
            throw new Error('无效的Kokoro TTS响应格式');
          }
        }
      } else {
        // 自定义API，假设返回包含音频URL的JSON
        const data = await response.json();
        audioUrl = data.audioUrl || data.url;
      }

      if (!audioUrl) {
        throw new Error('没有获取到有效的音频URL');
      }

      // 如果是 blob URL，加入内存缓存
      if (audioUrl.startsWith('blob:')) {
        // 获取 blob 数据
        const response = await fetch(audioUrl);
        const blob = await response.blob();
        
        // 缓存并播放
        this.cacheAndPlayAudioBlob(blob, text);
      } else {
        // 直接播放外部URL (不缓存)
        this.playAudio(audioUrl);
      }
    } catch (error) {
      console.error('TTS转换失败:', error)
      window.message.error({ content: `TTS转换失败: ${error instanceof Error ? error.message : '未知错误'}`, key: 'tts-error' })
    }
  }

  /**
   * 根据提供商类型获取API URL
   */
  private getApiUrl(provider: TTSProvider): string | null {
    switch (provider.type) {
      case 'openai':
        // 如果提供了自定义API地址，使用自定义地址
        if (provider.endpoint) {
          const baseUrl = provider.endpoint.endsWith('/') ? provider.endpoint : `${provider.endpoint}/`;
          return `${baseUrl}v1/audio/speech`;
        }
        return 'https://api.openai.com/v1/audio/speech';
      case 'azure':
        return `${provider.endpoint || 'https://eastus.tts.speech.microsoft.com'}/cognitiveservices/v1`;
      case 'kokoro':
        // 如果是Kokoro TTS且有配置endpoint，检查是否已包含API路径
        if (provider.endpoint) {
          // 确保endpoint以/结尾
          const baseUrl = provider.endpoint.endsWith('/') ? provider.endpoint : `${provider.endpoint}/`;
          
          // 根据是否使用OpenAI兼容模式决定使用哪个API端点
          if (provider.useOpenAICompat === true) {
            // 在兼容模式下始终使用OpenAI兼容的接口路径
            return `${baseUrl}v1/audio/speech`;
          } else {
            // 非兼容模式下根据是否有指定模型来选择端点
            if (provider.model) {
              return `${baseUrl}v1/audio/speech`;
            } else {
              return `${baseUrl}v1/audio/generate`;
            }
          }
        }
        return null;
      case 'custom':
        return provider.endpoint || null
      default:
        return null
    }
  }

  /**
   * 将音频Blob保存到本地并播放
   */
  private async cacheAndPlayAudioBlob(blob: Blob, text: string): Promise<void> {
    try {
      // 创建tts-cache目录(如果不存在)
      try {
        await window.api.file.write(`tts-cache/.gitkeep`, '');
      } catch (err) {
        console.warn('创建缓存目录警告:', err);
      }
      
      // 为文本生成唯一文件名
      const timestamp = Date.now();
      const filename = `tts-${timestamp}.mp3`;
      const filepath = `tts-cache/${filename}`;
      
      console.log(`准备保存音频到文件: ${filepath}`);
      
      // 首先创建一个blob URL作为备用
      const blobUrl = URL.createObjectURL(blob);
      
      try {
        // 下载音频到本地文件
        const arrayBuffer = await blob.arrayBuffer();
        await window.api.file.write(filepath, new Uint8Array(arrayBuffer));
        console.log(`音频成功下载到: ${filepath}`);
        
        // 获取文件的完整路径
        const fullPath = await window.api.file.get(filepath);
        
        // 显示下载成功消息
        window.message.success({ 
          content: `音频文件已自动下载到: ${filename}`, 
          duration: 3 
        });
        
        // 添加到内存缓存
        this.audioCache.set(text.slice(0, 50), {
          blob: blob,
          url: blobUrl,
          timestamp: timestamp
        });
        
        // 清理过多的缓存
        this.cleanupCache();
        
        // 使用文件URL播放
        console.log(`使用本地文件URL播放: file://${fullPath}`);
        this.createAudioPlayer(`file://${fullPath}`, filename);
      } catch (err) {
        console.warn('保存音频文件失败，使用blob URL播放:', err);
        this.createAudioPlayer(blobUrl, filename);
      }
    } catch (error) {
      console.error('处理音频数据失败:', error);
      // 失败时创建新的blob URL
      const blobUrl = URL.createObjectURL(blob);
      this.createAudioPlayer(blobUrl, 'tts-audio.mp3');
    }
  }
  
  /**
   * 清理过期的内存缓存
   */
  private cleanupCache(): void {
    if (this.audioCache.size <= this.maxCacheSize) {
      return;
    }
    
    console.log(`内存缓存大小(${this.audioCache.size})超过限制(${this.maxCacheSize})，开始清理`);
    
    // 转换为数组，按时间戳排序
    const entries = Array.from(this.audioCache.entries()).sort(
      (a, b) => a[1].timestamp - b[1].timestamp
    );
    
    // 删除最老的项目，直到缓存大小小于80%
    const targetSize = Math.floor(this.maxCacheSize * 0.8);
    while (entries.length > targetSize) {
      const [key, cacheItem] = entries.shift()!;
      
      // 撤销blob URL
      URL.revokeObjectURL(cacheItem.url);
      
      // 从缓存中移除
      this.audioCache.delete(key);
      console.log(`已从内存缓存中移除旧项目: ${key}`);
    }
    
    console.log(`内存缓存清理完成，当前大小: ${this.audioCache.size}`);
  }
  
  /**
   * 创建内置音频播放器UI
   */
  private createAudioPlayer(audioUrl: string, filename: string = 'audio.mp3'): void {
    // 移除现有播放器
    this.removeAudioPlayer();
    
    // 创建播放器容器
    this.playerContainer = document.createElement('div');
    this.playerContainer.style.position = 'fixed';
    this.playerContainer.style.bottom = '20px';
    this.playerContainer.style.right = '20px';
    this.playerContainer.style.zIndex = '9999';
    this.playerContainer.style.background = '#f8f9fa';
    this.playerContainer.style.border = '1px solid #dee2e6';
    this.playerContainer.style.borderRadius = '8px';
    this.playerContainer.style.padding = '12px';
    this.playerContainer.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.15)';
    this.playerContainer.style.display = 'flex';
    this.playerContainer.style.flexDirection = 'column';
    this.playerContainer.style.gap = '10px';
    this.playerContainer.style.minWidth = '300px';
    
    // 添加标题
    const titleBar = document.createElement('div');
    titleBar.style.display = 'flex';
    titleBar.style.justifyContent = 'space-between';
    titleBar.style.alignItems = 'center';
    titleBar.style.marginBottom = '5px';
    
    const title = document.createElement('div');
    title.textContent = '语音播放器';
    title.style.fontWeight = 'bold';
    
    const closeButton = document.createElement('button');
    closeButton.textContent = '×';
    closeButton.style.background = 'none';
    closeButton.style.border = 'none';
    closeButton.style.cursor = 'pointer';
    closeButton.style.fontSize = '20px';
    closeButton.style.color = '#666';
    closeButton.onclick = () => this.removeAudioPlayer();
    
    titleBar.appendChild(title);
    titleBar.appendChild(closeButton);
    
    // 创建音频元素
    this.audioPlayer = document.createElement('audio') as HTMLAudioElement;
    this.audioPlayer.controls = true;
    this.audioPlayer.style.width = '100%';
    this.audioPlayer.style.margin = '5px 0';
    this.audioPlayer.crossOrigin = 'anonymous';
    this.audioPlayer.src = audioUrl;
    
    // 添加事件监听
    this.audioPlayer.onended = () => {
      console.log('音频播放完成');
      this.isPlaying = false;
    };
    
    this.audioPlayer.onerror = (event) => {
      const error = this.audioPlayer?.error;
      console.error('音频播放错误:', error?.code, error?.message);
      window.message.error({
        content: `音频播放失败: ${error?.message || '未知错误'}`,
        key: 'tts-play-error'
      });
      this.isPlaying = false;
    };
    
    // 创建下载按钮
    const downloadButton = document.createElement('a');
    downloadButton.href = audioUrl;
    downloadButton.download = filename;
    downloadButton.textContent = '下载音频';
    downloadButton.style.display = 'block';
    downloadButton.style.textAlign = 'center';
    downloadButton.style.padding = '8px 12px';
    downloadButton.style.background = '#007bff';
    downloadButton.style.color = 'white';
    downloadButton.style.borderRadius = '4px';
    downloadButton.style.textDecoration = 'none';
    downloadButton.style.cursor = 'pointer';
    downloadButton.style.width = '100%';
    downloadButton.style.boxSizing = 'border-box';
    
    // 组装播放器
    this.playerContainer.appendChild(titleBar);
    this.playerContainer.appendChild(this.audioPlayer);
    this.playerContainer.appendChild(downloadButton);
    
    // 将播放器添加到页面
    document.body.appendChild(this.playerContainer);
    
    // 自动播放
    this.isPlaying = true;
    this.audioPlayer.play().then(() => {
      console.log('音频开始播放');
    }).catch(error => {
      console.error('音频播放启动失败:', error);
      window.message.error({
        content: `音频播放失败: ${error?.message || '未知错误'}`,
        key: 'tts-play-error'
      });
      this.isPlaying = false;
    });
    
    // 30秒后自动关闭播放器
    setTimeout(() => {
      if (this.playerContainer && document.body.contains(this.playerContainer)) {
        this.removeAudioPlayer();
      }
    }, 30000);
  }
  
  /**
   * 移除音频播放器
   */
  private removeAudioPlayer(): void {
    if (this.playerContainer && document.body.contains(this.playerContainer)) {
      document.body.removeChild(this.playerContainer);
    }
    
    if (this.audioPlayer) {
      this.audioPlayer.pause();
      if (this.audioPlayer.src.startsWith('blob:')) {
        URL.revokeObjectURL(this.audioPlayer.src);
      }
      this.audioPlayer = null;
    }
    
    this.playerContainer = null;
    this.isPlaying = false;
  }
  
  /**
   * 播放音频URL
   */
  private async playAudio(audioUrl: string): Promise<void> {
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
    }

    console.log('准备播放音频URL:', audioUrl);
    
    // 如果是blob URL或远程URL，尝试下载到本地
    if (audioUrl.startsWith('blob:') || audioUrl.startsWith('http')) {
      try {
        // 下载音频数据
        const response = await fetch(audioUrl);
        const blob = await response.blob();
        
        // 保存到本地并播放
        await this.cacheAndPlayAudioBlob(blob, '未知文本-' + Date.now());
        return;
      } catch (error) {
        console.error('下载音频失败，使用原始URL播放:', error);
      }
    }
    
    // 如果上面的下载过程失败，使用原始URL播放
    this.createAudioPlayer(audioUrl);
    
    // 保留原有的Audio对象作为备份方案
    this.audio = new Audio();
    this.audio.src = audioUrl;
    this.audio.onended = () => {
      // 我们不再释放URL，因为它可能是本地文件路径
      this.audio = null;
    };
  }

  /**
   * 停止当前播放
   */
  public stopSpeaking(): void {
    // 停止内置播放器
    this.removeAudioPlayer();
    
    // 停止备份Audio对象
    if (this.audio && this.isPlaying) {
      this.audio.pause();
      if (this.audio.src.startsWith('blob:')) {
        // 不要释放URL，因为它可能在缓存中使用
        // 缓存清理会负责释放过期的URLs
      }
      this.audio = null;
      this.isPlaying = false;
    }
  }

  /**
   * 检查是否正在播放
   */
  public isCurrentlyPlaying(): boolean {
    return this.isPlaying
  }
  
  /**
   * 直接播放音频文件
   * 这个公共方法允许直接播放任何音频文件，不需要文本转语音的过程
   * @param audioPath 音频文件路径，支持本地文件路径、Blob URL或远程URL
   * @param title 可选的标题，显示在播放器上
   * @returns 播放的音频URL
   */
  public async playAudioFile(audioPath: string, title: string = ''): Promise<string> {
    // 如果当前有音频在播放，先停止它
    if (this.isPlaying) {
      this.stopSpeaking();
    }
    
    console.log('准备播放音频文件:', audioPath);
    
    // 保存最后播放的音频URI
    this.lastPlayedAudioUri = audioPath;
    
    // 检查路径类型
    if (audioPath.startsWith('file://') || audioPath.startsWith('blob:') || audioPath.startsWith('http')) {
      console.log('使用完整URL播放:', audioPath);
      // 直接使用路径播放
      await this.playAudio(audioPath);
      return audioPath;
    } 
    
    // 处理本地文件路径
    try {
      console.log('尝试获取完整文件路径:', audioPath);
      
      // 尝试方法1: 获取完整路径并构建file://URL
      try {
        const fullPath = await window.api.file.get(audioPath);
        console.log('获取到完整文件路径:', fullPath);
        
        const fileUrl = `file://${fullPath}`;
        console.log('构建的文件URL:', fileUrl);
        
        // 提取文件名
        const filename = audioPath.split('/').pop() || 'audio.mp3';
        
        // 播放本地文件
        this.createAudioPlayer(fileUrl, title || filename);
        return fileUrl;
        
      } catch (pathError) {
        console.warn('获取完整路径失败，尝试直接读取文件:', pathError);
        
        // 尝试方法2: 读取文件内容并创建Blob
        try {
          const fileData = await window.api.file.read(audioPath);
          console.log('读取到文件数据:', fileData ? '成功' : '失败');
          
          if (!fileData) {
            throw new Error('读取到的文件数据为空');
          }
          
          // 创建Blob对象
          // 将数据处理为Uint8Array，无论是什么格式
          let binaryData: Uint8Array;
          
          if (fileData === null || fileData === undefined) {
            throw new Error('文件数据为空');
          } else if (typeof fileData === 'string') {
            // 字符串情况
            binaryData = new TextEncoder().encode(fileData);
          } else if (fileData instanceof Uint8Array) {
            // 已经是Uint8Array
            binaryData = fileData;
          } else {
            // 不确定类型，尝试转成字符串
            try {
              binaryData = new TextEncoder().encode(JSON.stringify(fileData));
            } catch (e) {
              binaryData = new TextEncoder().encode(String(fileData));
            }
          }
          
          const blob = new Blob([binaryData], { type: 'audio/mpeg' });
          
          console.log('创建的Blob大小:', blob.size);
          
          // 创建URL并播放
          const blobUrl = URL.createObjectURL(blob);
          console.log('创建的BlobURL:', blobUrl);
          
          // 提取文件名
          const filename = audioPath.split('/').pop() || 'audio.mp3';
          
          // 播放音频
          this.createAudioPlayer(blobUrl, title || filename);
          
          // 将URL添加到缓存
          this.audioCache.set('file:' + audioPath, {
            blob,
            url: blobUrl,
            timestamp: Date.now()
          });
          
          return blobUrl;
        } catch (readError) {
          console.error('读取文件失败:', readError);
          throw new Error(`无法读取音频文件: ${readError instanceof Error ? readError.message : String(readError)}`);
        }
      }
    } catch (error) {
      console.error('处理音频文件失败:', error);
      window.message.error({
        content: `无法播放音频文件: ${error instanceof Error ? error.message : '未知错误'}`,
        key: 'audio-play-error'
      });
      throw error;
    }
  }
}

export default TTSService.getInstance()
