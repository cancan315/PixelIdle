#!/usr/bin/env node
/**
 * 装备数值校准：跑出「装备带来的 DPS 增益」曲线。
 *
 * 为什么需要它：装备是**免费掉落**，如果强度失控会直接压过金币买的技能，
 * 让整个成长系统失去意义。这个脚本把当前关卡的装备增益量化出来，
 * 调 TUNE.gear.affixes[].per 时先跑一遍。
 *
 * 用法：
 *   node scripts/calibrate-gear.js
 *
 * 做法：在最小 DOM 桩里加载真实的 app/www/index.html（含真实 TUNE），
 * 模拟「逐关推进 + 自动装备 + 买最便宜技能」的普通玩家，统计 DPS。
 * 不需要 canvas 库：桩里的 canvas 只有空方法，因为校准不画任何东西。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'app', 'www', 'index.html');

if (!fs.existsSync(HTML)) {
  console.error('找不到 ' + path.relative(ROOT, HTML) + '，先跑 node scripts/build-web.js');
  process.exit(1);
}

/* ---------- 最小 DOM 桩 ---------- */
const noop = () => {};
function makeCtx() {
  return new Proxy({
    canvas: null, imageSmoothingEnabled: false, globalAlpha: 1,
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createLinearGradient: () => ({ addColorStop: noop })
  }, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => { t[k] = v; return true; } });
}
function makeCanvas() {
  const c = {
    width: 0, height: 0, style: {}, addEventListener: noop,
    clientWidth: 900, clientHeight: 500,
    getBoundingClientRect: () => ({ width: 900, height: 500 })
  };
  c.getContext = () => (c._c || (c._c = makeCtx()));
  return c;
}
const els = {};
function el(id) {
  if (id === 'stage' || id === 'avatar') return makeCanvas();
  if (!els[id]) {
    els[id] = {
      id: id, style: {}, textContent: '', innerHTML: '', className: '', value: '',
      classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      appendChild: noop, removeChild: noop, remove: noop, addEventListener: noop, setAttribute: noop,
      clientWidth: 900, clientHeight: 500,
      getBoundingClientRect: () => ({ width: 900, height: 500 }),
      querySelector: () => null, querySelectorAll: () => [], closest: () => null, dataset: {}
    };
  }
  return els[id];
}

let vnow = 0;
const timers = [];
const rafs = [];

const sandbox = {
  console: console, Math: Math, Date: Date, JSON: JSON,
  Object: Object, Array: Array, String: String, Number: Number, Boolean: Boolean, Error: Error,
  Promise: Promise, Map: Map, Set: Set, WeakMap: WeakMap, Symbol: Symbol, Proxy: Proxy, Reflect: Reflect,
  Uint8Array: Uint8Array, Uint32Array: Uint32Array, Uint8ClampedArray: Uint8ClampedArray,
  ArrayBuffer: ArrayBuffer, Float64Array: Float64Array, Int32Array: Int32Array,
  ImageData: class {
    constructor(a, b, c) {
      if (a instanceof Uint8ClampedArray) { this.data = a; this.width = b; this.height = c; }
      else { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
    }
  },
  setTimeout: (fn, ms) => { timers.push({ at: vnow + (ms || 0), fn: fn }); },
  clearTimeout: noop, setInterval: () => 0, clearInterval: noop, queueMicrotask: queueMicrotask,
  requestAnimationFrame: (fn) => { rafs.push(fn); },
  performance: { now: () => vnow },
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(null), text: () => Promise.resolve('') }),
  location: { pathname: '/app/PixelIdle/', href: 'http://x/app/PixelIdle/', origin: 'http://x' },
  navigator: { sendBeacon: () => true, userAgent: 'node' },
  document: {
    getElementById: el, createElement: (t) => (t === 'canvas' ? makeCanvas() : el('t' + Math.random())),
    addEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
    body: el('body'), documentElement: el('html'), hidden: false, visibilityState: 'visible',
    readyState: 'complete'
  },
  localStorage: {
    _d: {},
    getItem(k) { return this._d[k] == null ? null : this._d[k]; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
  }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.addEventListener = noop;
vm.createContext(sandbox);

const html = fs.readFileSync(HTML, 'utf8');
const blocks = [...html.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].map((m) => m[1]);
for (let i = 0; i < blocks.length; i++) vm.runInContext(blocks[i], sandbox, { filename: 'block' + i + '.js' });

/* ---------- 校准 ---------- */
setTimeout(() => {
  const api = sandbox.__pixelidle;
  if (!api) { console.error('游戏脚本未初始化（__pixelidle 不存在）'); process.exit(1); }

  const T = api.TUNE;
  const S = api.state;
  const eq = api.Svc.get('equip');
  const combat = api.Svc.get('combat');

  // derive 是服务内私有的，这里按同一公式复刻（改公式时两边要同步）
  const xpNeed = (lv) => Math.round(T.xp.base + Math.pow(lv, T.xp.pow) * T.xp.mul);
  const ZERO = { atk: 0, hp: 0, speed: 0, crit: 0, regen: 0 };
  function dps(withGear) {
    const g = withGear ? S.gearBonus : ZERO;
    const atk = T.hero.baseAtk + S.hero.atkBonus + g.atk + (S.hero.level - 1) * T.hero.atkPerLevel;
    const crit = Math.min(T.hero.maxCrit, T.hero.baseCrit + S.hero.critBonus + g.crit);
    const interval = Math.max(T.hero.minInterval,
      T.hero.baseInterval / (1 + S.hero.speedBonus + g.speed));
    return atk * (1 + crit) / interval;
  }

  function resetState() {
    S.hero.level = 1; S.hero.xp = 0; S.hero.hp = 100;
    S.hero.atkBonus = 0; S.hero.hpBonus = 0; S.hero.speedBonus = 0;
    S.hero.critBonus = 0; S.hero.regenBonus = 0;
    S.gold = 0; S.kills = 0; S.stage = 1;
    S.skillLv = { atk: 0, hp: 0, speed: 0, crit: 0, regen: 0 };
    S.equipped = [null, null, null, null];
    eq.recompute();
  }

  // 普通玩家行为：有钱就买最便宜的技能
  function buyCheapest() {
    for (let guard = 0; guard < 500; guard++) {
      let best = null, bestCost = Infinity;
      for (const sk of T.skills) {
        const lv = S.skillLv[sk.id] || 0;
        const cost = Math.round(sk.baseCost * Math.pow(sk.grow, lv));
        if (cost <= S.gold && cost < bestCost) { bestCost = cost; best = sk; }
      }
      if (!best) return;
      S.gold -= bestCost;
      S.skillLv[best.id] = (S.skillLv[best.id] || 0) + 1;
      if (best.id === 'atk') S.hero.atkBonus += 1;
      else if (best.id === 'hp') S.hero.hpBonus += 15;
      else if (best.id === 'speed') S.hero.speedBonus += 0.08;
      else if (best.id === 'crit') S.hero.critBonus += 0.03;
      else S.hero.regenBonus += 0.5;
    }
  }

  function simulate(targetStage) {
    resetState();
    for (let st = 1; st <= targetStage; st++) {
      S.stage = st;                                  // 掉落 ilvl 取当前关卡
      for (let k = 1; k <= T.stage.enemiesPerStage; k++) {
        const def = combat.stageEnemy(st, k);
        S.kills++; S.gold += def.gold; S.hero.xp += def.xp;
        while (S.hero.xp >= xpNeed(S.hero.level)) {
          S.hero.xp -= xpNeed(S.hero.level); S.hero.level++;
        }
        eq.dropFor(def.role, st);
        eq.addStones(st, def.role === 'boss' ? 3 : def.role === 'elite' ? 2 : 1);
      }
      buyCheapest();
    }
    S.stage = targetStage;
  }

  const STAGES = [6, 12, 24, 36, 48];
  const N = Number(process.argv[2] || 40);

  console.log('装备数值校准（每档 ' + N + ' 次模拟取平均）');
  console.log('');
  console.log('stage | level | 技能atk | 装备atk | 装备hp | 攻速   | 暴击  | DPS无装 | DPS有装 | 增益');
  console.log('------|-------|---------|---------|--------|--------|-------|---------|---------|------');

  let warn = false;
  for (const st of STAGES) {
    const acc = { lv: 0, sk: 0, ga: 0, gh: 0, gs: 0, gc: 0, d0: 0, d1: 0 };
    for (let n = 0; n < N; n++) {
      simulate(st);
      acc.lv += S.hero.level; acc.sk += S.hero.atkBonus; acc.ga += S.gearBonus.atk;
      acc.gh += S.gearBonus.hp; acc.gs += S.gearBonus.speed; acc.gc += S.gearBonus.crit;
      acc.d0 += dps(false); acc.d1 += dps(true);
    }
    const r = (x) => x / N;
    const gain = 100 * (r(acc.d1) / r(acc.d0) - 1);
    if (gain > 60) warn = true;
    console.log(
      String(st).padStart(5) + ' | ' +
      r(acc.lv).toFixed(0).padStart(5) + ' | ' +
      r(acc.sk).toFixed(0).padStart(7) + ' | ' +
      r(acc.ga).toFixed(0).padStart(7) + ' | ' +
      r(acc.gh).toFixed(0).padStart(6) + ' | ' +
      (r(acc.gs) * 100).toFixed(0).padStart(5) + '% | ' +
      (r(acc.gc) * 100).toFixed(0).padStart(4) + '% | ' +
      r(acc.d0).toFixed(1).padStart(7) + ' | ' +
      r(acc.d1).toFixed(1).padStart(7) + ' | ' +
      gain.toFixed(0).padStart(4) + '%'
    );
  }

  console.log('');
  console.log('目标区间：+15% ~ +40%（装备免费，不应压过金币买的技能）');
  if (warn) {
    console.log('⚠ 有档位超过 60%：装备过强，把 TUNE.gear.affixes[].per 往下调');
    process.exitCode = 2;
  } else {
    console.log('✓ 在目标区间内');
  }

  /* ---------- 关卡段：达标玩家的击杀时长 ---------- */
  console.log('');
  console.log('=== 门槛达标玩家的击杀时长（目标 普通 8s / 精英 18s / 首领 35s）');
  console.log('stage | 门槛Lv | 装备(atk/hp) | 角色atk | DPS | 普通怪HP/秒 | 精英HP/秒 | 首领HP/秒');
  console.log('------|--------|--------------|---------|-----|-------------|-----------|----------');

  function statsOf(withPlus) {
    const g = S.gearBonus;
    const atk = T.hero.baseAtk + S.hero.atkBonus + g.atk + (S.hero.level - 1) * T.hero.atkPerLevel;
    const crit = Math.min(T.hero.maxCrit, T.hero.baseCrit + S.hero.critBonus + g.crit);
    const interval = Math.max(T.hero.minInterval, T.hero.baseInterval / (1 + S.hero.speedBonus + g.speed));
    return { atk: atk, dps: atk * (1 + crit) / interval };
  }

  // 构造「刚好达标」的玩家：等级=门槛，四件装备刚好满足门槛，无技能加成
  function buildMinimum(stage, withPlus) {
    S.hero.atkBonus = 0; S.hero.hpBonus = 0; S.hero.speedBonus = 0;
    S.hero.critBonus = 0; S.hero.regenBonus = 0;
    S.hero.level = combat.unlockLevel(stage);
    const ilvl = Math.max(1, stage - 1);
    S.equipped = [0, 1, 2, 3].map(function (slot) {
      const it = eq.rollItem(slot, ilvl, slot === 0 ? 2 : 2);   // 都用传说（最严门槛）
      it.plus = withPlus ? T.reinforce.maxPlus : 0;
      return it;
    });
    eq.recompute();
  }

  for (const st of [2, 3, 5, 8, 12, 20]) {
    buildMinimum(st, false);
    const a = statsOf(false);
    const rows = ['normal', 'elite', 'boss'].map(function (role, idx) {
      const mob = idx === 0 ? 1 : idx === 1 ? 6 : 10;
      const def = combat.stageEnemy(st, mob);
      return { role: role, hp: def.hp, secs: def.hp / a.dps };
    });
    console.log(
      String(st).padStart(5) + ' | ' +
      S.hero.level.toString().padStart(6) + ' | ' +
      (S.gearBonus.atk.toFixed(0) + '/' + S.gearBonus.hp.toFixed(0)).padStart(12) + ' | ' +
      a.atk.toFixed(0).padStart(7) + ' | ' +
      a.dps.toFixed(1).padStart(4) + ' | ' +
      (rows[0].hp + '/' + rows[0].secs.toFixed(1) + 's').padStart(11) + ' | ' +
      (rows[1].hp + '/' + rows[1].secs.toFixed(1) + 's').padStart(9) + ' | ' +
      (rows[2].hp + '/' + rows[2].secs.toFixed(1) + 's').padStart(9)
    );
  }

  process.exit(process.exitCode || 0);
}, 250);