/**
 * 播放 AudioWorklet Processor — Jitter Buffer 实现
 *
 * 职责：接收主线程解码后的 PCM 音频帧，通过 jitter buffer 机制平滑播放，
 *       消除网络抖动带来的音频断续问题。
 *
 * 工作原理：
 *   - 主线程将 Opus 帧解码为 Float32 PCM 后，通过 postMessage 送入本 Worklet
 *   - 本 Worklet 维护一个 FIFO 队列（jitter buffer），不会来一帧就立刻播放
 *   - 首次播放前，等待队列积累到 bufferThreshold（8帧，约 300-400ms）才开始输出
 *   - 播放过程中，即使某帧因网络延迟晚到，队列中仍有存货可继续播放，保证连续性
 *   - 队列耗尽后不会立刻判定结束，而是等待 emptyThreshold 次空轮询（约 400ms），
 *     避免网络短暂卡顿导致误判播放结束
 *
 * 数据流：
 *   WebSocket → Opus 帧 → 主线程 OpusDecoder 解码 → postMessage(Float32Array)
 *   → [本 Worklet: jitter buffer 队列] → AudioContext.destination → 扬声器
 *
 * 关键参数：
 *   - bufferThreshold = 8：开始播放前需要攒够的帧数（约 300-400ms 缓冲延迟）
 *   - emptyThreshold = 50：队列为空后等待多少次 process 调用才判定播放结束
 *     （50 × 8ms/次 ≈ 400ms，其中 8ms = 128 samples / 16kHz）
 *
 * 设计权衡：
 *   用 300-400ms 的初始延迟换取播放的连续性和丝滑感，
 *   对语音对话场景来说这点延迟几乎不可感知。
 */
class PlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // FIFO 队列，存放待播放的 Float32Array PCM 帧
    this.queue = [];
    // 当前正在播放的帧的读取偏移量
    this.offset = 0;
    // 是否已开始播放（攒够帧后置为 true）
    this.started = false;
    // 开始播放前需要攒够的帧数（约 300-400ms 缓冲）
    this.bufferThreshold = 8;
    // 队列为空的连续 process() 调用次数
    this.emptyCount = 0;
    // 连续空轮询达到此阈值才通知主线程播放结束（50 × 8ms ≈ 400ms）
    this.emptyThreshold = 50;

    // 监听主线程消息
    this.port.onmessage = (e) => {
      if (e.data.command === "clear") {
        // 收到清空指令（用户打断、停止播放时），重置所有状态
        this.queue = [];
        this.offset = 0;
        this.started = false;
        this.emptyCount = 0;
      } else {
        // 收到新的 PCM 帧，入队
        this.queue.push(e.data.audioBuffer);
        this.emptyCount = 0;
      }
    };
  }

  /**
   * AudioWorklet 核心回调，由音频渲染线程以 128 samples 为单位持续调用
   * @param {Float32Array[][]} _ - 输入（本 processor 不使用输入）
   * @param {Float32Array[][]} outputs - outputs[0][0] 为需要填充的输出缓冲区（128 samples）
   * @returns {boolean} 返回 true 保持 processor 存活
   */
  process(_, outputs) {
    const output = outputs[0][0];
    if (!output) return true;

    // 阶段一：尚未开始播放，等待 jitter buffer 积累到阈值
    if (!this.started) {
      if (this.queue.length >= this.bufferThreshold) {
        this.started = true;
      } else {
        // 缓冲未满，输出静音
        output.fill(0);
        return true;
      }
    }

    // 阶段二：正常播放，从队列中消费数据填充输出缓冲区
    let idx = 0;
    while (idx < output.length) {
      if (this.queue.length === 0) {
        // 队列耗尽，剩余部分填充静音
        output.fill(0, idx);
        break;
      }

      const currentBuffer = this.queue[0];
      const remaining = currentBuffer.length - this.offset;
      const copyLength = Math.min(remaining, output.length - idx);

      // 从当前帧拷贝数据到输出
      output.set(
        currentBuffer.subarray(this.offset, this.offset + copyLength),
        idx
      );

      idx += copyLength;
      this.offset += copyLength;

      // 当前帧消费完毕，移出队列，重置偏移
      if (this.offset >= currentBuffer.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }

    // 阶段三：播放结束检测
    // 队列为空时累计空轮询计数，超过阈值才通知主线程"播放结束"
    // 这样可以容忍网络短暂卡顿（< 400ms）而不会误判结束
    if (this.queue.length === 0 && this.started) {
      this.emptyCount++;
      if (this.emptyCount >= this.emptyThreshold) {
        // 确认播放结束，通知主线程
        this.port.postMessage({ type: "ended" });
        this.started = false;
        this.emptyCount = 0;
      }
    } else {
      this.emptyCount = 0;
    }

    return true;
  }
}

registerProcessor("player-processor", PlayerProcessor);
