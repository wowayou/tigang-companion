// sync/coordinator.mjs — 同步编排器
//
// 核心不变量:
//   1. 任何 PUT 都必须紧跟同一身份上下文中的成功 GET(或明确的 remote=none)。
//   2. userId / 主密码 / 启用状态变化时,所有排队与在途任务立即失效。
//   3. 异步步骤只使用启动时快照,绝不在 await 之后读取可能已变化的全局身份。
//
// 模块不访问 DOM/localStorage,依赖全部可注入,便于用 fake 网络和 fake timer 覆盖竞态。

import { encryptBlob, decryptBlob, mergeForSync } from '../core/sync.js';
import { syncPull, syncPush } from './client.mjs';

const noop = () => {};

function clonePayload(value) {
  const records = Array.isArray(value && value.records) ? value.records : [];
  const settings = value && value.settings && typeof value.settings === 'object' ? value.settings : {};
  return JSON.parse(JSON.stringify({ records, settings }));
}

export class SyncCoordinator {
  constructor({
    origin,
    enabled = false,
    userId = '',
    passphrase = '',
    pull = syncPull,
    push = syncPush,
    encrypt = encryptBlob,
    decrypt = decryptBlob,
    merge = mergeForSync,
    readData,
    applyMergedRecords,
    isOnline = () => true,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    createAbortController = () => new AbortController(),
    onEvent = noop,
    onLastSync = noop,
    onRemoteEmpty = noop,
    onBusy = noop,
    debounceMs = 2000,
    rateRetryMs = 4500,
  }) {
    if (typeof readData !== 'function') throw new TypeError('readData is required');
    if (typeof applyMergedRecords !== 'function') throw new TypeError('applyMergedRecords is required');

    this.origin = String(origin || '').replace(/\/$/, '');
    this.enabled = !!enabled;
    this.userId = String(userId || '');
    this.passphrase = String(passphrase || '');

    this.pull = pull;
    this.push = push;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.merge = merge;
    this.readData = readData;
    this.applyMergedRecords = applyMergedRecords;
    this.isOnline = isOnline;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.createAbortController = createAbortController;
    this.onEvent = onEvent;
    this.onLastSync = onLastSync;
    this.onRemoteEmpty = onRemoteEmpty;
    this.onBusy = onBusy;
    this.debounceMs = debounceMs;
    this.rateRetryMs = rateRetryMs;

    this.generation = 0;
    this.decryptFailed = false;
    this.remoteEmpty = false;
    this.pushTimer = null;
    this.retryTimer = null;
    this.currentRun = null;
    this.rerunGeneration = null;
    this.activeControllers = new Set();
  }

  get busy() {
    return !!this.currentRun && this.currentRun.generation === this.generation;
  }

  configure({ enabled = this.enabled, userId = this.userId, passphrase = this.passphrase } = {}) {
    const next = {
      enabled: !!enabled,
      userId: String(userId || ''),
      passphrase: String(passphrase || ''),
    };
    if (
      next.enabled === this.enabled
      && next.userId === this.userId
      && next.passphrase === this.passphrase
    ) return false;

    this.invalidate();
    this.enabled = next.enabled;
    this.userId = next.userId;
    this.passphrase = next.passphrase;
    return true;
  }

  setEnabled(enabled) {
    return this.configure({ enabled });
  }

  setUserId(userId) {
    return this.configure({ userId });
  }

  setPassphrase(passphrase) {
    return this.configure({ passphrase });
  }

  invalidate() {
    this.generation += 1;
    this.decryptFailed = false;
    this.setRemoteEmpty(false);
    this.clearScheduled();
    this.rerunGeneration = null;
    for (const controller of this.activeControllers) controller.abort();
    this.activeControllers.clear();
    this.currentRun = null;
    this.onBusy(false);
  }

  clearScheduled() {
    if (this.pushTimer !== null) {
      this.clearTimer(this.pushTimer);
      this.pushTimer = null;
    }
    if (this.retryTimer !== null) {
      this.clearTimer(this.retryTimer);
      this.retryTimer = null;
    }
  }

  dispose() {
    this.invalidate();
  }

  /** 本地发生变化:防抖后执行完整 pull→merge→push,从不盲推。 */
  schedule() {
    if (!this.enabled || !this.userId || !this.passphrase || !this.isOnline() || this.decryptFailed) return false;
    if (this.pushTimer !== null) this.clearTimer(this.pushTimer);
    const generation = this.generation;
    this.pushTimer = this.setTimer(() => {
      this.pushTimer = null;
      if (generation !== this.generation) return;
      void this.syncNow({ source: 'auto' });
    }, this.debounceMs);
    return true;
  }

  /**
   * 完整同步。相同 generation 只允许一条流水线;自动请求撞上在途任务时记一次 rerun,
   * 避免在加密快照之后发生的本地变化被吞掉。
   *
   * overwrite=true 是**唯一被许可的合并跳过**:主密码记错/改过时远端密文解不开,
   * 正常流程会永久锁死 push(这是对的,防止用错密码覆盖云端),用户因此没有任何出路。
   * 该模式仍然先 GET(不变量「PUT 前必须有同身份成功 GET」照旧成立),只是明知故犯地
   * 丢弃远端明文、用本机数据整桶覆盖 —— 必须由用户显式确认后才可调用,见 overwriteRemote()。
   */
  syncNow({ source = 'manual', retryOnRate = true, overwrite = false } = {}) {
    if (!this.enabled) return this.rejectEarly('disabled', source);
    if (!this.userId) return this.rejectEarly('missing-user-id', source);
    if (!this.passphrase) return this.rejectEarly('missing-passphrase', source);
    if (!this.isOnline()) return this.rejectEarly('offline', source);

    const generation = this.generation;
    if (this.currentRun && this.currentRun.generation === generation) {
      if (source !== 'manual') this.rerunGeneration = generation;
      return this.currentRun.promise;
    }

    if (this.pushTimer !== null) {
      this.clearTimer(this.pushTimer);
      this.pushTimer = null;
    }
    if (source !== 'retry' && this.retryTimer !== null) {
      this.clearTimer(this.retryTimer);
      this.retryTimer = null;
    }

    const controller = this.createAbortController();
    const context = Object.freeze({
      generation,
      userId: this.userId,
      passphrase: this.passphrase,
      controller,
    });
    const run = { generation, controller, promise: null };
    this.activeControllers.add(controller);
    this.currentRun = run;
    this.onBusy(true);
    this.emit('busy', { source });

    run.promise = this.performSync(context, { source, retryOnRate, overwrite })
      .finally(() => this.finishRun(run));
    return run.promise;
  }

  /**
   * 用本机数据整桶覆盖远端(丢弃远端内容),并解除解密失败门闸。
   * 唯一用途:用户改了主密码 / 记错主密码,远端密文再也解不开,需要一个"重新开始"的出路。
   * **调用方必须先向用户明确确认远端数据会被丢弃** —— 编排器不做二次确认。
   */
  overwriteRemote({ source = 'overwrite' } = {}) {
    this.decryptFailed = false; // 门闸只挡自动流程;这里是用户显式授权的覆盖
    return this.syncNow({ source, retryOnRate: true, overwrite: true });
  }

  async whenIdle() {
    while (this.currentRun && this.currentRun.generation === this.generation) {
      await this.currentRun.promise;
    }
  }

  rejectEarly(code, source) {
    this.emit(code, { source });
    return Promise.resolve({ ok: false, error: code });
  }

  isCurrent(context) {
    return (
      context.generation === this.generation
      && context.userId === this.userId
      && context.passphrase === this.passphrase
      && this.enabled
      && !context.controller.signal.aborted
    );
  }

  async performSync(context, { source, retryOnRate, overwrite = false }) {
    let conflicts = 0;
    let remoteWasEmpty = false;
    try {
      const pulled = await this.pull(this.origin, context.userId, { signal: context.controller.signal });
      if (!this.isCurrent(context)) return { ok: false, error: 'stale' };

      if (!pulled.ok) {
        if (pulled.error !== 'none') {
          this.emit(pulled.error === 'network' ? 'pull-network' : 'pull-failed', { source });
          return { ok: false, error: pulled.error || 'pull-failed' };
        }
        remoteWasEmpty = true;
        this.decryptFailed = false;
        this.setRemoteEmpty(true);
      } else if (overwrite) {
        // 显式覆盖:GET 已成功(不变量成立),这里明知故犯地不解密、不合并,
        // 直接拿本机数据整桶盖掉。远端原内容就此丢失 —— 由调用方确认过。
        this.setRemoteEmpty(false);
        this.decryptFailed = false;
      } else {
        this.setRemoteEmpty(false);
        const decrypted = await this.decrypt(pulled.blob, context.passphrase);
        if (!this.isCurrent(context)) return { ok: false, error: 'stale' };
        if (!decrypted.ok) {
          this.decryptFailed = true;
          this.emit('decrypt-failed', { source });
          return { ok: false, error: 'decrypt-failed' };
        }

        this.decryptFailed = false;
        const local = this.readData();
        const remoteRecords = decrypted.data && Array.isArray(decrypted.data.records)
          ? decrypted.data.records
          : [];
        const merged = this.merge(local && local.records, remoteRecords);
        conflicts = Number(merged.conflicts) || 0;
        if (!this.isCurrent(context)) return { ok: false, error: 'stale' };
        this.applyMergedRecords(merged.merged);
      }

      // 加密前做深快照。await 期间如果本地又变化,persist() 会请求一次 rerun。
      const payload = clonePayload(this.readData());
      const blob = await this.encrypt(payload, context.passphrase);
      if (!this.isCurrent(context)) return { ok: false, error: 'stale' };

      const pushed = await this.push(this.origin, context.userId, blob, { signal: context.controller.signal });
      if (!this.isCurrent(context)) return { ok: false, error: 'stale' };

      if (!pushed.ok) {
        if (pushed.error === 'rate') {
          if (retryOnRate) {
            this.emit('push-rate-retry', { source });
            // overwrite 必须随重试一起带上:否则重试走回普通流程,又会在解密处失败,
            // 用户点了「覆盖」却什么也没发生。
            this.scheduleRateRetry(context.generation, overwrite);
          } else {
            this.emit('push-rate', { source });
          }
        } else if (pushed.error === 'too-big') {
          this.emit('push-too-big', { source });
        } else {
          this.emit('push-failed', { source });
        }
        return { ok: false, error: pushed.error || 'push-failed' };
      }

      this.setRemoteEmpty(false);
      const syncedAt = this.now();
      this.onLastSync(syncedAt);
      this.emit('synced', { source, conflicts, firstUpload: remoteWasEmpty, overwrote: overwrite });
      return { ok: true, conflicts, firstUpload: remoteWasEmpty, overwrote: overwrite };
    } catch {
      if (!this.isCurrent(context)) return { ok: false, error: 'stale' };
      this.emit('sync-failed', { source });
      return { ok: false, error: 'sync-failed' };
    }
  }

  scheduleRateRetry(generation, overwrite = false) {
    if (this.retryTimer !== null) this.clearTimer(this.retryTimer);
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      if (generation !== this.generation) return;
      // 重试也必须重新拉取,不能复用几秒前的密文快照盲推。
      void this.syncNow({ source: 'retry', retryOnRate: false, overwrite });
    }, this.rateRetryMs);
  }

  finishRun(run) {
    this.activeControllers.delete(run.controller);
    if (this.currentRun !== run) return;
    this.currentRun = null;
    this.onBusy(false);

    if (this.rerunGeneration === this.generation) {
      this.rerunGeneration = null;
      this.schedule();
    }
  }

  setRemoteEmpty(value) {
    const next = !!value;
    if (next === this.remoteEmpty) return;
    this.remoteEmpty = next;
    this.onRemoteEmpty(next);
  }

  emit(code, detail = {}) {
    this.onEvent({ code, ...detail });
  }
}
