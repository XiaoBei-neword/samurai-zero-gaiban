// ============================================================
// input.js —— 键鼠输入
// 键位是需求书规定的固定 7 个动作，不增不减。
// 设计要点：
//   * pressed 用"锁存"而不是每帧比较，这样同一帧内按下又松开的输入不会丢
//   * 玩家物理跑在固定步里（一帧可能多个子步），锁存让子步都能看到这次按键
//   * 攻击/投掷方向要区分来源：鼠标来源用指针方向，键盘来源用角色朝向
// ============================================================

export const ACTIONS = ['left', 'right', 'jump', 'dash', 'attack', 'slow', 'restart', 'pause'];

// 一个动作可以由多个键触发（需求书允许的等价键位）
// 注意：拾取/投掷已经移除，右键现在是"减缓时间"（和鼠标中键、L 等价）
const KEY_TO_ACTION = {
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  KeyW: 'jump',
  ArrowUp: 'jump',
  Space: 'jump',
  ShiftLeft: 'dash',
  ShiftRight: 'dash',
  KeyJ: 'attack',
  KeyL: 'slow',
  KeyR: 'restart',
  Escape: 'pause',
};

// 需要拦掉默认行为的键（空格滚动页面、方向键滚动页面）
const PREVENT_DEFAULT_CODES = new Set([
  'Space',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Tab',
]);

const MOUSE_BUTTON_TO_ACTION = { 0: 'attack', 2: 'slow', 1: 'slow' };

export class Input {
  constructor() {
    this.keysDown = new Set();
    this.mouseDown = { left: false, right: false, middle: false };
    /** 动作名 -> 是否按住 */
    this.held = Object.create(null);
    /** 动作名 -> 锁存的按下事件（consume 后清除） */
    this.latches = Object.create(null);
    for (const a of ACTIONS) {
      this.held[a] = false;
      this.latches[a] = false;
    }
    /** 本次攻击的输入来源（鼠标=朝指针，键盘=朝朝向） */
    this.lastAttackSource = 'mouse';
    /** 右键是否还在按住（用于抵消拖拽 mousemove 造成的状态重置） */
    this._slowHeldByRight = false;
    /** 指针位置（逻辑屏幕坐标 0..1280 / 0..720），由 render 提供映射 */
    this.pointer = { sx: 640, sy: 360, inside: false };
    this._mapper = null;
    this._rawX = 640;
    this._rawY = 360;
    this._bound = false;
    this.anyInputSeen = false;
    /** 供外部（音频解锁）用的回调 */
    this.onFirstInput = null;
  }

  /** render 在 resize 后调用，把 client 坐标映射到逻辑屏幕坐标 */
  setMapper(fn) {
    this._mapper = fn;
    this._updatePointer();
  }

  attach(target = window) {
    if (this._bound) return;
    this._bound = true;
    const t = target;

    t.addEventListener('keydown', (e) => {
      const action = KEY_TO_ACTION[e.code];
      if (PREVENT_DEFAULT_CODES.has(e.code)) e.preventDefault();
      if (!action) return;
      this._firstInput();
      if (e.repeat) return;
      this.keysDown.add(e.code);
      this._latch(action, 'key');
      this._refreshHeld();
    });

    t.addEventListener('keyup', (e) => {
      if (PREVENT_DEFAULT_CODES.has(e.code)) e.preventDefault();
      this.keysDown.delete(e.code);
      this._refreshHeld();
    });

    t.addEventListener('mousedown', (e) => {
      const action = MOUSE_BUTTON_TO_ACTION[e.button];
      // 中键会触发浏览器自动滚动、右键会触发菜单，全部拦掉
      if (action) e.preventDefault();
      if (!action) return;
      this._firstInput();
      if (e.button === 0) this.mouseDown.left = true;
      else if (e.button === 2) {
        this.mouseDown.right = true;
        this._slowHeldByRight = true;
      } else this.mouseDown.middle = true;
      this._latch(action, 'mouse');
      this._refreshHeld();
    });

    const upHandler = (e) => {
      if (e.button === 0) this.mouseDown.left = false;
      else if (e.button === 2) {
        this.mouseDown.right = false;
        this._slowHeldByRight = false;
      } else this.mouseDown.middle = false;
      this._refreshHeld();
      // 右键松开后可能还会收到 mousemove，稍后清一次，确保一定停
      if (e.button === 2) {
        this._slowHeldByRight = false;
        this.mouseDown.right = false;
        this._refreshHeld();
      }
      if (e.button === 1 || e.button === 2) e.preventDefault();
    };
    t.addEventListener('mouseup', upHandler);
    window.addEventListener('mouseup', upHandler); // 在画布外松开也要算数
    t.addEventListener('mouseleave', () => {
      this.mouseDown.left = false;
      this.mouseDown.right = false;
      this.mouseDown.middle = false;
      this._slowHeldByRight = false;
      this._refreshHeld();
    });

    t.addEventListener('mousemove', (e) => {
      this._rawX = e.clientX;
      this._rawY = e.clientY;
      this.pointer.inside = true;
      this._updatePointer();
      // 右键按住拖鼠标时（减缓时间）浏览器会持续发 mousemove，
      // 某些实现会把它当成重复的同步事件并重新置位按键状态 → "松开右键还在减速"。
      // 这里在锁定状态下把右键的按下状态重新钉回去。
      if (this._slowHeldByRight && !this.mouseDown.right) {
        this.mouseDown.right = true;
        this._refreshHeld();
      }
    });

    t.addEventListener('contextmenu', (e) => e.preventDefault());
    t.addEventListener('auxclick', (e) => e.preventDefault());
    t.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
    // 失焦时清空按键，避免"按键卡住"（很常见的手感 bug）
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });
  }

  _firstInput() {
    if (this.anyInputSeen) return;
    this.anyInputSeen = true;
    if (this.onFirstInput) this.onFirstInput();
  }

  _updatePointer() {
    if (this._mapper) {
      const p = this._mapper(this._rawX, this._rawY);
      this.pointer.sx = p.x;
      this.pointer.sy = p.y;
    } else {
      this.pointer.sx = this._rawX;
      this.pointer.sy = this._rawY;
    }
  }

  _latch(action, source) {
    this.latches[action] = true;
    if (action === 'attack') this.lastAttackSource = source;
  }

  _refreshHeld() {
    this.held.left = this.keysDown.has('KeyA') || this.keysDown.has('ArrowLeft');
    this.held.right = this.keysDown.has('KeyD') || this.keysDown.has('ArrowRight');
    this.held.jump =
      this.keysDown.has('KeyW') || this.keysDown.has('ArrowUp') || this.keysDown.has('Space');
    this.held.dash = this.keysDown.has('ShiftLeft') || this.keysDown.has('ShiftRight');
    this.held.attack = this.mouseDown.left || this.keysDown.has('KeyJ');
    this.held.slow = this.mouseDown.middle || this.mouseDown.right || this.keysDown.has('KeyL');
    this.held.restart = this.keysDown.has('KeyR');
    this.held.pause = this.keysDown.has('Escape');
  }

  /** 取走一次"按下"事件（取走后同一帧的后续子步不会重复触发） */
  consume(action) {
    if (this.latches[action]) {
      this.latches[action] = false;
      return true;
    }
    return false;
  }

  /** 是否有未处理的按下 */
  peek(action) {
    return this.latches[action] === true;
  }

  clearLatches() {
    for (const a of ACTIONS) this.latches[a] = false;
  }

  releaseAll() {
    this.keysDown.clear();
    this.mouseDown.left = false;
    this.mouseDown.right = false;
    this.mouseDown.middle = false;
    this._slowHeldByRight = false;
    this._refreshHeld();
  }
}

export const input = new Input();
