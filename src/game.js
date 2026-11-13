/* =========================================================
   像素放置 · Pixel Idle
   架构参考 Saltline：
     · TUNE      —— 所有可调数值集中在一处
     · Bus       —— 事件总线，模块之间只通过事件通信
     · Services  —— 服务定位器，逻辑不直接依赖渲染/存档实现
   无外部依赖，纯 Canvas。
   ========================================================= */
(function () {
  'use strict';

  /* =========================================================
     1. TUNE —— 唯一数值来源
     调平衡只改这里，不用翻代码。
     ========================================================= */
  const TUNE = {
    view: {
      w: 320, h: 180, groundY: 132, heroX: 74, enemyX: 224, px: 2
    },

    hero: {
      baseHp: 100, hpPerLevel: 20,
      baseAtk: 5, atkPerLevel: 2,
      baseInterval: 0.8, minInterval: 0.16,
      baseCrit: 0.05, maxCrit: 0.75,
      baseRegen: 0.3,
      dmgVariance: 0.2      // ±10%
    },

    /* 敌人属性随关卡分层成长 */
    stage: { enemiesPerStage: 10, tierMul: 1.55 },

    xp: { base: 10, pow: 1.75, mul: 6 },

    /* —— 手感参数（借鉴 Saltline 的反馈层设计）—— */
    feel: {
      hitStopHit: 0.035,     // 命中顿帧
      hitStopKill: 0.10,     // 击杀顿帧（更重）
      hitStopScale: 0.08,    // 顿帧期间时间缩放
      shakeHit: 1.1,
      shakeKill: 2.6,
      shakeDecay: 9,         // 指数衰减速率
      floatLife: 0.9,
      particleLife: 0.5,
      telegraphPulse: 12,    // 预警环脉动频率
      hurtFlash: 0.6         // 受伤红屏持续时间
    },

    /* —— 预警（telegraph）：敌人出手前先给视觉信号 —— */
    telegraph: {
      melee: 0.42,           // 近身攻击预警更短
      ranged: 0.62,
      flashRate: 5           // 预警发光爬升速率
    },

    enemies: {
      slime:    { name: '史莱姆', hp: 20,  atk: 2,  xp: 6,  gold: 3,  scale: 1.0, kind: 'melee'  },
      bat:      { name: '蝙蝠',   hp: 34,  atk: 4,  xp: 11, gold: 6,  scale: 1.0, kind: 'melee'  },
      skeleton: { name: '骷髅',   hp: 62,  atk: 7,  xp: 20, gold: 12, scale: 1.0, kind: 'ranged' },
      golem:    { name: '石魔',   hp: 120, atk: 12, xp: 38, gold: 26, scale: 1.0, kind: 'ranged' }
    },

    stagePool: ['slime', 'slime', 'bat', 'bat', 'skeleton', 'golem'],

    enemyCooldown: { base: 1.25, variance: 0.25 },

    offline: { goldPerSec: 0.3, maxHours: 8 },

    skills: [
      { id: 'atk',   name: '力量训练', icon: '⚔️', baseCost: 25, grow: 1.35, desc: '攻击力 +1' },
      { id: 'hp',    name: '体魄锻炼', icon: '❤️', baseCost: 30, grow: 1.32, desc: '最大生命 +15' },
      { id: 'speed', name: '疾风步',   icon: '💨', baseCost: 40, grow: 1.42, desc: '攻速 +8%' },
      { id: 'crit',  name: '致命一击', icon: '🎯', baseCost: 60, grow: 1.50, desc: '暴击率 +3%' },
      { id: 'regen', name: '自然恢复', icon: '🌿', baseCost: 55, grow: 1.40, desc: '每秒回复 +0.5' }
    ]
  };

  /* =========================================================
     2. 数学工具
     ========================================================= */
  const U = {
    clamp(v, a, b) { return v < a ? a : v > b ? b : v; },
    clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; },
    lerp(a, b, t) { return a + (b - a) * t; },

    /** smootherstep：C² 连续，两端一阶二阶导数都为 0（Saltline 的 Yo） */
    smooth(x) {
      const t = U.clamp01(x);
      return t * t * t * (t * (t * 6 - 15) + 10);
    },

    /** 帧率无关的指数平滑（Saltline 的 kn） */
    expSmooth(cur, target, rate, dt) {
      return cur + (target - cur) * (1 - Math.exp(-rate * dt));
    },

    /** 弹簧：半隐式欧拉 + 固定子步长，避免高刚度时发散（Saltline 的 ma） */
    spring(s, target, dt) {
      const steps = dt > 0.012 ? Math.ceil(dt / 0.008) : 1;
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        s.v += ((target - s.x) * s.k - s.v * s.c) * h;
        s.x += s.v * h;
      }
      return s.x;
    },

    makeSpring(k, c) { return { x: 0, v: 0, k, c }; }
  };

  /* =========================================================
     3. 事件总线
     模块之间不直接调用，只发事件 / 订阅事件。
     ========================================================= */
  class Bus {
    constructor() { this.map = new Map(); }
    on(evt, fn) {
      if (!this.map.has(evt)) this.map.set(evt, []);
      this.map.get(evt).push(fn);
      return () => this.off(evt, fn);
    }
    off(evt, fn) {
      const a = this.map.get(evt);
      if (!a) return;
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    }
    once(evt, fn) {
      const un = this.on(evt, (p) => { un(); fn(p); });
      return un;
    }
    emit(evt, payload) {
      const a = this.map.get(evt);
      if (!a) return;
      // 拷贝，允许回调里再订阅/退订
      for (const fn of a.slice()) {
        try { fn(payload); } catch (e) {
          console.error('[bus] handler error on "' + evt + '":', e);
        }
      }
    }
  }

  /* =========================================================
     4. 服务定位器
     逻辑层通过 Svc.get('fx') 取能力，不关心具体实现。
     ========================================================= */
  const Svc = {
    _m: new Map(),
    set(name, impl) { this._m.set(name, impl); return impl; },
    get(name) {
      const s = this._m.get(name);
      if (!s) throw new Error('[services] 未注册: ' + name);
      return s;
    },
    has(name) { return this._m.has(name); }
  };

  const bus = new Bus();

  /* =========================================================
     5. 游戏状态
     ========================================================= */
  const SAVE_KEY = 'pixelidle.save.v1';
  const SAVE_VERSION = 1;
  const BASE_PATH = (function () {
    let p = location.pathname.replace(/index\.html?$/i, '');
    if (!p.endsWith('/')) p += '/';
    return p;
  })();
  const SAVE_API = BASE_PATH + 'api/save';
  const VERSION_API = BASE_PATH + 'api/version';

  const state = {
    hero: {
      level: 1, xp: 0, hp: 100,
      atkBonus: 0, hpBonus: 0, speedBonus: 0, critBonus: 0, regenBonus: 0
    },
    gold: 0,
    stage: 1,
    kills: 0,
    skillLv: { atk: 0, hp: 0, speed: 0, crit: 0, regen: 0 },

    /* 战斗运行时 */
    enemy: null,
    heroAtkTimer: 0,
    enemyAtkTimer: 0,
    regenAcc: 0,

    /* 表现层运行时 */
    t: 0,
    hitStop: 0,
    shake: 0,
    hurtFlash: 0,
    heroSwing: 0,
    enemyLunge: 0,
    lastSave: 0,
    pendingSave: false
  };

  /* 派生属性 */
  const derive = {
    maxHp: () => TUNE.hero.baseHp + state.hero.hpBonus + (state.hero.level - 1) * TUNE.hero.hpPerLevel,
    atk: () => TUNE.hero.baseAtk + state.hero.atkBonus + (state.hero.level - 1) * TUNE.hero.atkPerLevel,
    interval: () => Math.max(TUNE.hero.minInterval, TUNE.hero.baseInterval / (1 + state.hero.speedBonus)),
    crit: () => Math.min(TUNE.hero.maxCrit, TUNE.hero.baseCrit + state.hero.critBonus),
    regen: () => TUNE.hero.baseRegen + state.hero.regenBonus,
    xpNeed: () => Math.round(TUNE.xp.base + Math.pow(state.hero.level, TUNE.xp.pow) * TUNE.xp.mul),
    skillCost: (sk) => Math.round(sk.baseCost * Math.pow(sk.grow, state.skillLv[sk.id] || 0))
  };

  /* =========================================================
     6. 精灵资源
     ========================================================= */
  const PAL = {
    skin: '#f0c49a', hair: '#3a2a2a',
    cloth: '#4a6fdc', clothDark: '#33509f',
    metal: '#c8cede',
    gold: '#ffcc4d',
    slime: '#5ecf7a', slimeDark: '#389a52', slimeEye: '#10281a',
    bat: '#8a5ad4', batDark: '#5c3699', batWing: '#4a2b7a',
    skel: '#e8e6d8', skelDark: '#a8a597', skelEye: '#ff5b5b',
    golem: '#9a8f7a', golemDark: '#6b6250', golemCore: '#5adcff',
    shadow: 'rgba(0,0,0,.28)'
  };

  const SPRITES = {
    hero: {
      pal: { k: PAL.hair, s: PAL.skin, c: PAL.cloth, d: PAL.clothDark, e: '#1a1a2a', m: PAL.metal },
      art: [
        '...kkkk...', '..kkkkkk..', '..kssssk..', '..kesseek.',
        '..kssssk..', '...ssss...', '..cccccc..', '.mccccccm.',
        '.mcddd dcm'.replace(/ /g, 'c'), '..cccccc..', '..dd..dd..',
        '..dd..dd..', '.kk....kk.'
      ]
    },
    slime: {
      pal: { g: PAL.slime, d: PAL.slimeDark, e: PAL.slimeEye, w: '#ffffff' },
      art: [
        '..........', '..........', '..........', '....gg....',
        '...gggg...', '..gggggg..', '.ggeggegg.', '.gggggggg.',
        '.gwwggwwg.', '.dddddddd.'
      ]
    },
    bat: {
      pal: { b: PAL.bat, d: PAL.batDark, w: PAL.batWing, e: '#ffe14d' },
      art: [
        '..........', '..w....w..', '.www..www.', '.wwbbbbww.',
        '..bbbbbb..', '..bebbeb..', '...bbbb...', '....dd....',
        '..........', '..........'
      ]
    },
    skeleton: {
      pal: { s: PAL.skel, d: PAL.skelDark, e: PAL.skelEye, k: '#2a2a35' },
      art: [
        '...ssss...', '..ssssss..', '..sessse..', '..ssssss..',
        '...ssss...', '...kkkk...', '..ssssss..', '.ssssssss.',
        '..s.ss.s..', '..d.dd.d..', '..d.dd.d..', '.dd.dd.dd.'
      ]
    },
    golem: {
      pal: { g: PAL.golem, d: PAL.golemDark, c: PAL.golemCore },
      art: [
        '...gggg...', '..gggggg..', '..gccggg..', '..gggggg..',
        '.gggggggg.', 'ggggddgggg', 'gggggggggg', 'ggdggggdgg',
        'ggdggggdgg', '.dd....dd.', '.dd....dd.', '.dd....dd.'
      ]
    }
  };

  /* 把字符串精灵预渲染成离屏 canvas */
  const spriteCache = {};
  function buildSprite(name) {
    if (spriteCache[name]) return spriteCache[name];
    const def = SPRITES[name];
    const rows = def.art;
    const h = rows.length;
    const w = Math.max.apply(null, rows.map(r => r.length));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const img = g.createImageData(w, h);
    const cache = {};
    const rgba = (hex) => {
      if (cache[hex]) return cache[hex];
      const n = parseInt(hex.slice(1), 16);
      const v = [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
      cache[hex] = v;
      return v;
    };
    for (let y = 0; y < h; y++) {
      const row = rows[y];
      for (let x = 0; x < w; x++) {
        const ch = row[x];
        if (!ch || ch === '.' || ch === ' ') continue;
        const hex = def.pal[ch];
        if (!hex) continue;
        const c4 = rgba(hex);
        const i = (y * w + x) * 4;
        img.data[i] = c4[0]; img.data[i + 1] = c4[1];
        img.data[i + 2] = c4[2]; img.data[i + 3] = c4[3];
      }
    }
    g.putImageData(img, 0, 0);
    spriteCache[name] = { canvas: c, w: w, h: h };
    return spriteCache[name];
  }

  /* =========================================================
     7. fx 服务 —— 粒子 / 飘字 / 抖动 / 顿帧 / 光斑
     ========================================================= */
  const fx = (function () {
    const particles = [];
    const floats = [];
    const rings = [];
    const flashes = [];

    function hit(x, y, color, n) {
      const count = n || 5;
      for (let i = 0; i < count; i++) {
        particles.push({
          x: x, y: y,
          vx: (Math.random() - 0.5) * 70,
          vy: -Math.random() * 60 - 12,
          life: TUNE.feel.particleLife * (0.8 + Math.random() * 0.5),
          age: 0,
          color: color || '#ffe14d',
          size: Math.random() < 0.5 ? 1 : 2
        });
      }
    }

    function float(x, y, text, color) {
      floats.push({ x: x, y: y, text: text, color: color || '#fff', age: 0, life: TUNE.feel.floatLife });
    }

    /** 预警环：预警开始时扩散一圈，给玩家“要来了”的提示 */
    function ring(x, y, radius, color, dur) {
      rings.push({ x: x, y: y, r0: radius * 0.3, r1: radius, color: color, age: 0, life: dur || 0.5 });
    }

    /** 屏幕光斑（借鉴 Saltline 的 lightPool） */
    function flash(x, y, radius, color, dur) {
      flashes.push({ x: x, y: y, r: radius, color: color, age: 0, life: dur || 0.18 });
    }

    function shake(amount) {
      state.shake = Math.min(6, state.shake + amount);
    }

    function hitStop(seconds) {
      state.hitStop = Math.max(state.hitStop, seconds);
    }

    function update(dt) {
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.age += dt;
        if (p.age >= p.life) { particles.splice(i, 1); continue; }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 180 * dt;
      }
      for (let i = floats.length - 1; i >= 0; i--) {
        const f = floats[i];
        f.age += dt;
        if (f.age >= f.life) { floats.splice(i, 1); continue; }
        f.y -= 22 * dt;
      }
      for (let i = rings.length - 1; i >= 0; i--) {
        const r = rings[i];
        r.age += dt;
        if (r.age >= r.life) rings.splice(i, 1);
      }
      for (let i = flashes.length - 1; i >= 0; i--) {
        const f = flashes[i];
        f.age += dt;
        if (f.age >= f.life) flashes.splice(i, 1);
      }

      // 抖动指数衰减
      if (state.shake > 0) {
        state.shake *= Math.exp(-TUNE.feel.shakeDecay * dt);
        if (state.shake < 0.05) state.shake = 0;
      }
      if (state.hurtFlash > 0) {
        state.hurtFlash = Math.max(0, state.hurtFlash - dt);
      }
    }

    function drawWorld(ctx) {
      // 光斑（叠加混合）
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const f of flashes) {
        const t = f.age / f.life;
        const a = (1 - t) * 0.55;
        const r = f.r * (0.6 + t * 0.8);
        const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, r);
        g.addColorStop(0, f.color.replace('rgb', 'rgba').replace(')', ',' + a.toFixed(3) + ')'));
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(f.x - r, f.y - r, r * 2, r * 2);
      }
      ctx.restore();

      // 预警环
      for (const r of rings) {
        const t = r.age / r.life;
        ctx.globalAlpha = (1 - t) * 0.8;
        ctx.strokeStyle = r.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(r.x, r.y, U.lerp(r.r0, r.r1, U.smooth(t)), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // 粒子
      for (const p of particles) {
        ctx.globalAlpha = 1 - p.age / p.life;
        ctx.fillStyle = p.color;
        ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
      }
      ctx.globalAlpha = 1;

      // 飘字
      ctx.font = 'bold 7px monospace';
      ctx.textAlign = 'center';
      for (const f of floats) {
        const a = 1 - f.age / f.life;
        ctx.globalAlpha = a;
        ctx.fillStyle = '#000';
        ctx.fillText(f.text, Math.round(f.x) + 1, Math.round(f.y) + 1);
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, Math.round(f.x), Math.round(f.y));
      }
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
    }

    function clear() {
      particles.length = 0; floats.length = 0; rings.length = 0; flashes.length = 0;
    }

    return { hit: hit, float: float, ring: ring, flash: flash, shake: shake,
             hitStop: hitStop, update: update, drawWorld: drawWorld, clear: clear };
  })();
  Svc.set('fx', fx);

  /* =========================================================
     8. combat 服务 —— 伤害、成长、关卡推进
     ========================================================= */
  const combat = (function () {
    function stageEnemy(stage) {
      const pool = TUNE.stagePool;
      const key = pool[(stage - 1) % pool.length];
      const base = TUNE.enemies[key];
      const tier = Math.floor((stage - 1) / pool.length);
      const mul = Math.pow(TUNE.stage.tierMul, tier);
      return {
        key: key,
        name: base.name,
        kind: base.kind,
        hp: Math.round(base.hp * mul),
        atk: Math.round(base.atk * mul * 10) / 10,
        xp: Math.round(base.xp * mul),
        gold: Math.round(base.gold * mul),
        scale: base.scale
      };
    }

    function spawnEnemy() {
      const def = stageEnemy(state.stage);
      state.enemy = {
        def: def,
        hp: def.hp,
        maxHp: def.hp,
        x: TUNE.view.enemyX + 30,
        /* 预警状态机 */
        phase: 'enter',        // enter | idle | windup | strike | recover
        phaseT: 0,
        flash: 0,              // 预警发光强度 0..1
        cooldown: 0.6
      };
      state.enemyAtkTimer = 0;
      bus.emit('enemy:spawn', { enemy: state.enemy, stage: state.stage });
    }

    function heroAttack() {
      const e = state.enemy;
      if (!e || e.phase === 'enter') return;

      const crit = Math.random() < derive.crit();
      let dmg = derive.atk() * (1 + (Math.random() - 0.5) * TUNE.hero.dmgVariance);
      if (crit) dmg *= 2;
      dmg = Math.max(1, Math.round(dmg));

      e.hp -= dmg;
      state.heroSwing = 0.22;

      bus.emit('hero:swing', { enemy: e, damage: dmg, crit: crit, hp: e.hp });
      if (e.hp <= 0) {
        e.hp = 0;
        kill(e);
      }
    }

    function kill(e) {
      const def = e.def;
      state.kills++;
      state.gold += def.gold;
      bus.emit('enemy:killed', { enemy: e, gold: def.gold, xp: def.xp });
      gainXp(def.xp);

      if (state.kills % TUNE.stage.enemiesPerStage === 0) {
        state.stage++;
        bus.emit('stage:change', { stage: state.stage });
      }

      state.enemy = null;
      setTimeout(() => { if (!state.enemy) spawnEnemy(); }, 260);
    }

    function gainXp(amount) {
      state.hero.xp += amount;
      let need = derive.xpNeed();
      while (state.hero.xp >= need) {
        state.hero.xp -= need;
        state.hero.level++;
        state.hero.hp = derive.maxHp();
        bus.emit('hero:levelup', { level: state.hero.level });
        need = derive.xpNeed();
      }
    }

    /* —— 敌人出手：先 windup（预警），再 strike —— */
    function enemyTick(dt) {
      const e = state.enemy;
      if (!e) return;
      if (e.phase === 'enter') {
        e.x = Math.max(TUNE.view.enemyX, e.x - 6 * dt * 6);
        if (e.x <= TUNE.view.enemyX) { e.phase = 'idle'; e.phaseT = 0; }
        return;
      }

      e.phaseT += dt;
      if (e.flash > 0) e.flash = Math.max(0, e.flash - dt * 2);

      switch (e.phase) {
        case 'idle':
          e.cooldown -= dt;
          if (e.cooldown <= 0 && state.hero.hp > 0) {
            const isMelee = e.def.kind === 'melee';
            const dur = isMelee ? TUNE.telegraph.melee : TUNE.telegraph.ranged;
            e.phase = 'windup';
            e.phaseT = 0;
            e.windupDur = dur;
            bus.emit('enemy:telegraph', {
              enemy: e, kind: e.def.kind, time: dur, pos: { x: e.x, y: TUNE.view.groundY }
            });
          }
          break;

        case 'windup':
          // 发光爬升，给玩家“要打过来了”的视觉信号
          e.flash = Math.min(1, e.flash + dt * TUNE.telegraph.flashRate);
          if (e.phaseT >= e.windupDur) {
            e.phase = 'strike';
            e.phaseT = 0;
            enemyStrike(e);
          }
          break;

        case 'strike':
          if (e.phaseT >= 0.18) {
            e.phase = 'recover';
            e.phaseT = 0;
            e.flash = 0;
          }
          break;

        case 'recover':
          if (e.phaseT >= 0.25) {
            e.phase = 'idle';
            e.phaseT = 0;
            const cd = TUNE.enemyCooldown;
            e.cooldown = cd.base + (Math.random() - 0.5) * cd.variance * 2;
          }
          break;
      }
    }

    function enemyStrike(e) {
      const dmg = Math.max(1, Math.round(e.def.atk * (0.85 + Math.random() * 0.3)));
      state.hero.hp -= dmg;
      state.enemyLunge = 0.22;

      bus.emit('hero:hurt', { damage: dmg, hp: state.hero.hp, enemy: e });

      if (state.hero.hp <= 0) {
        const lost = Math.floor(state.gold * 0.1);
        state.gold -= lost;
        state.hero.hp = derive.maxHp();
        state.enemy = null;
        bus.emit('hero:defeat', { lost: lost });
        setTimeout(() => { if (!state.enemy) spawnEnemy(); }, 700);
      }
    }

    function buySkill(sk) {
      const cost = derive.skillCost(sk);
      if (state.gold < cost) return false;
      state.gold -= cost;
      state.skillLv[sk.id] = (state.skillLv[sk.id] || 0) + 1;

      switch (sk.id) {
        case 'atk': state.hero.atkBonus += 1; break;
        case 'hp': state.hero.hpBonus += 15; state.hero.hp = derive.maxHp(); break;
        case 'speed': state.hero.speedBonus += 0.08; break;
        case 'crit': state.hero.critBonus += 0.03; break;
        case 'regen': state.hero.regenBonus += 0.5; break;
      }

      bus.emit('skill:bought', { skill: sk, level: state.skillLv[sk.id] });
      return true;
    }

    return {
      stageEnemy: stageEnemy,
      spawnEnemy: spawnEnemy,
      heroAttack: heroAttack,
      enemyTick: enemyTick,
      buySkill: buySkill,
      gainXp: gainXp
    };
  })();
  Svc.set('combat', combat);

  /* =========================================================
     9. save 服务 —— 双写（localStorage + 服务端）
     ========================================================= */
  const save = (function () {
    /* —— 数值合法范围：防止坏档 / 篡改导致崩溃 —— */
    const LIMIT = {
      level: [1, 9999],
      xp: [0, 1e12],
      hp: [0, 1e12],
      gold: [0, 1e15],
      stage: [1, 1e5],
      kills: [0, 1e12],
      bonus: [0, 1e9],     // atk/hp/speed/crit/regen 加成
      skill: [0, 1000]
    };

    function clampNum(v, range, fallback) {
      const n = Number(v);
      if (!isFinite(n)) return fallback;
      return U.clamp(n, range[0], range[1]);
    }

    /* —— 版本迁移：老存档必须能升级，否则玩家进度会直接清零 —— */
    function migrate(raw) {
      if (!raw || typeof raw !== 'object') return null;

      let d = raw;

      // 无版本号的历史存档：按 v1 处理
      if (d.v === undefined && typeof d.level === 'number') {
        d = Object.assign({}, d, { v: SAVE_VERSION });
      }

      const v = Number(d.v);
      if (!isFinite(v) || v < 1) return null;

      // 未来版本（玩家降级了应用）：不接受，避免误读
      if (v > SAVE_VERSION) return null;

      // 预留：v1 -> v2 的迁移写在这里
      // if (v === 1) { d = migrateV1toV2(d); }

      return sanitize(d);
    }

    /* —— 规范化字段，任何异常值都退回安全默认 —— */
    function sanitize(d) {
      if (!d || typeof d !== 'object') return null;
      const out = {
        v: SAVE_VERSION,
        level: Math.floor(clampNum(d.level, LIMIT.level, 1)),
        xp: clampNum(d.xp, LIMIT.xp, 0),
        hp: clampNum(d.hp, LIMIT.hp, 0),
        atkBonus: clampNum(d.atkBonus, LIMIT.bonus, 0),
        hpBonus: clampNum(d.hpBonus, LIMIT.bonus, 0),
        speedBonus: clampNum(d.speedBonus, LIMIT.bonus, 0),
        critBonus: clampNum(d.critBonus, LIMIT.bonus, 0),
        regenBonus: clampNum(d.regenBonus, LIMIT.bonus, 0),
        gold: Math.floor(clampNum(d.gold, LIMIT.gold, 0)),
        stage: Math.floor(clampNum(d.stage, LIMIT.stage, 1)),
        kills: Math.floor(clampNum(d.kills, LIMIT.kills, 0)),
        skillLv: {},
        time: clampNum(d.time, [0, 4e12], Date.now())
      };
      const src = (d.skillLv && typeof d.skillLv === 'object') ? d.skillLv : {};
      TUNE.skills.forEach((sk) => {
        out.skillLv[sk.id] = Math.floor(clampNum(src[sk.id], LIMIT.skill, 0));
      });
      return out;
    }

    function snapshot(now) {
      return {
        v: SAVE_VERSION,
        level: state.hero.level,
        xp: state.hero.xp,
        hp: state.hero.hp,
        atkBonus: state.hero.atkBonus,
        hpBonus: state.hero.hpBonus,
        speedBonus: state.hero.speedBonus,
        critBonus: state.hero.critBonus,
        regenBonus: state.hero.regenBonus,
        gold: state.gold,
        stage: state.stage,
        kills: state.kills,
        skillLv: state.skillLv,
        time: now || Date.now()
      };
    }

    function writeLocal(data) {
      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify(data));
        return true;
      } catch (e) { return false; }
    }

    /** 周期保存：本地同步写 + 服务端异步写 */
    function write() {
      const data = snapshot();
      state.lastSave = data.time;
      state.pendingSave = true;

      // 本地先写，保证任何情况下不丢
      writeLocal(data);

      try {
        fetch(SAVE_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        }).then(() => { state.pendingSave = false; })
          .catch(() => { state.pendingSave = false; });
      } catch (e) {
        state.pendingSave = false;
      }

      bus.emit('save:written', { at: data.time, source: 'interval' });
      return true;
    }

    /** 关页时保存：用 sendBeacon，比 fetch 更可能送达 */
    function writeOnExit() {
      const data = snapshot();
      writeLocal(data);
      state.lastSave = data.time;

      try {
        if (typeof navigator !== 'undefined' && navigator.sendBeacon &&
            typeof Blob !== 'undefined') {
          const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
          if (navigator.sendBeacon(SAVE_API, blob)) {
            bus.emit('save:written', { at: data.time, source: 'beacon' });
            return true;
          }
        }
      } catch (e) { /* 退回到普通写 */ }

      return write();
    }

    function readLocal() {
      try { return migrate(JSON.parse(localStorage.getItem(SAVE_KEY) || 'null')); }
      catch (e) { return null; }
    }

    /**
     * 读取存档：本地与服务端比对时间戳，取较新的那份。
     * 以前无条件信任服务端，服务宕机期间玩的进度会被回滚。
     */
    async function read() {
      const local = readLocal();
      let remote = null;

      try {
        const res = await fetch(SAVE_API, { headers: { 'Accept': 'application/json' } });
        if (res.ok) remote = migrate(await res.json());
      } catch (e) { /* 离线，只用本地 */ }

      if (remote && local) {
        const useLocal = (local.time || 0) > (remote.time || 0);
        state.saveSource = useLocal ? 'local-newer' : 'server';
        return useLocal ? local : remote;
      }
      if (remote) { state.saveSource = 'server'; return remote; }
      if (local) { state.saveSource = 'local'; return local; }
      state.saveSource = 'none';
      return null;
    }

    function apply(d) {
      state.hero.level = d.level;
      state.hero.xp = d.xp;
      state.hero.atkBonus = d.atkBonus;
      state.hero.hpBonus = d.hpBonus;
      state.hero.speedBonus = d.speedBonus;
      state.hero.critBonus = d.critBonus;
      state.hero.regenBonus = d.regenBonus;
      state.gold = d.gold;
      state.stage = d.stage;
      state.kills = d.kills;
      state.skillLv = Object.assign(
        { atk: 0, hp: 0, speed: 0, crit: 0, regen: 0 }, d.skillLv || {}
      );
      state.hero.hp = Math.min(derive.maxHp(), d.hp || derive.maxHp());
    }

    async function reset() {
      try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* 忽略 */ }
      try { await fetch(SAVE_API, { method: 'DELETE' }); } catch (e) { /* 忽略 */ }
    }

    return {
      write: write, writeOnExit: writeOnExit, read: read, apply: apply,
      reset: reset, readLocal: readLocal, migrate: migrate, sanitize: sanitize
    };
  })();
  Svc.set('save', save);

  /* =========================================================
     10. render 服务 —— 负责一切绘制
     ========================================================= */
  const render = (function () {
    const canvas = document.getElementById('stage');
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    const V = TUNE.view;
    canvas.width = V.w;
    canvas.height = V.h;

    const stars = [];
    for (let i = 0; i < 46; i++) {
      stars.push({
        x: Math.random() * V.w, y: Math.random() * 80,
        r: Math.random() < 0.75 ? 0.5 : 1, p: Math.random() * Math.PI * 2
      });
    }

    function fit() {
      const wrap = document.getElementById('stage-wrap');
      const cw = wrap.clientWidth, ch = wrap.clientHeight;
      if (!cw || !ch) return;
      const s = Math.min(cw / V.w, ch / V.h);
      canvas.style.width = Math.floor(V.w * s) + 'px';
      canvas.style.height = Math.floor(V.h * s) + 'px';
    }

    function drawSprite(name, x, y, scale, flip) {
      const sp = buildSprite(name);
      ctx.save();
      ctx.translate(Math.round(x), Math.round(y));
      if (flip) ctx.scale(-1, 1);
      ctx.scale(scale, scale);
      ctx.drawImage(sp.canvas, flip ? -sp.w : 0, 0);
      ctx.restore();
    }

    function hills(count, baseY, amp, off) {
      ctx.beginPath();
      ctx.moveTo(0, V.h);
      for (let i = 0; i <= count * 2; i++) {
        const x = (i * V.w) / (count * 2);
        const y = baseY - Math.abs(Math.sin(i * 1.7 + off * 0.05)) * amp;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(V.w, V.h);
      ctx.closePath();
      ctx.fill();
    }

    function background(t) {
      const sky = ctx.createLinearGradient(0, 0, 0, V.h);
      sky.addColorStop(0, '#0d0f1e');
      sky.addColorStop(0.55, '#1b1f3a');
      sky.addColorStop(1, '#2a2450');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, V.w, V.h);

      for (const s of stars) {
        const a = 0.35 + 0.45 * Math.sin(t * 1.4 + s.p);
        ctx.fillStyle = 'rgba(200,215,255,' + a.toFixed(3) + ')';
        ctx.fillRect(s.x, s.y, s.r, s.r);
      }

      // 月亮
      ctx.fillStyle = 'rgba(240,240,255,.16)';
      ctx.beginPath(); ctx.arc(268, 34, 15, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(240,240,255,.85)';
      ctx.beginPath(); ctx.arc(268, 34, 12, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1b1f3a';
      ctx.beginPath(); ctx.arc(274, 30, 10, 0, Math.PI * 2); ctx.fill();

      ctx.fillStyle = '#171a30'; hills(6, 108, 34, t * 0.6);
      ctx.fillStyle = '#121425'; hills(9, 118, 24, t * 1.1);

      const gr = ctx.createLinearGradient(0, V.groundY, 0, V.h);
      gr.addColorStop(0, '#2b3a2e');
      gr.addColorStop(1, '#141a17');
      ctx.fillStyle = gr;
      ctx.fillRect(0, V.groundY, V.w, V.h - V.groundY);

      ctx.fillStyle = 'rgba(120,160,120,.10)';
      for (let x = 0; x < V.w; x += 16) {
        ctx.fillRect(x + ((t * 6) % 16), V.groundY + 4, 8, 1);
      }
      ctx.fillStyle = 'rgba(90,140,100,.35)';
      ctx.fillRect(0, V.groundY, V.w, 1);
    }

    function shadow(x, y, rx) {
      ctx.fillStyle = PAL.shadow;
      ctx.beginPath();
      ctx.ellipse(x, y, rx, 4, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    function hero(t) {
      const bob = Math.sin(t * 3) * 1.2;
      const swing = state.heroSwing > 0
        ? -Math.sin((state.heroSwing / 0.22) * Math.PI) * 14
        : 0;

      shadow(V.heroX + 16, V.groundY + 2, 13);

      // 挥砍弧线
      if (state.heroSwing > 0) {
        const p = state.heroSwing / 0.22;
        ctx.save();
        ctx.globalAlpha = p * 0.8;
        ctx.strokeStyle = '#bfe4ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(V.heroX + 20, V.groundY - 20, 16, -0.9 + (1 - p) * 0.8, 0.5 + (1 - p) * 0.8);
        ctx.stroke();
        ctx.restore();
      }

      drawSprite('hero', V.heroX + swing, V.groundY - 24 + bob, V.px, false);
    }

    function enemy(t) {
      const e = state.enemy;
      if (!e) return;

      const bounce = Math.sin(t * 4 + 1) * 1.5;
      const lunge = state.enemyLunge > 0
        ? Math.cos((state.enemyLunge / 0.22) * Math.PI) * 12
        : 0;
      const sc = 1.6 * (e.def.scale || 1);
      const y = V.groundY - 10 * (sc / 1.6) + bounce;

      shadow(e.x + 16, V.groundY + 2, 14);

      // 预警：红色脉动光环
      if (e.phase === 'windup') {
        const pulse = 0.5 + 0.5 * Math.sin(t * TUNE.feel.telegraphPulse);
        ctx.save();
        ctx.globalAlpha = 0.25 + 0.45 * e.flash * pulse;
        ctx.strokeStyle = '#ff5a40';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(e.x + 16, V.groundY - 14, 22 + pulse * 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // 受击/预警染色：叠加一层红色剪影
      drawSprite(e.def.key, e.x + lunge - (e.def.key === 'slime' ? 0 : 2), y, V.px * sc / 1.6, true);

      if (e.flash > 0.02) {
        ctx.save();
        ctx.globalAlpha = e.flash * 0.55;
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = '#ff5a40';
        ctx.fillRect(e.x - 4, y - 4, 40, 48);
        ctx.restore();
      }

      // 血条
      const bw = 40, bh = 3;
      const bx = e.x + 16 - bw / 2, by = V.groundY - 52;
      ctx.fillStyle = 'rgba(0,0,0,.65)';
      ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
      const ratio = Math.max(0, e.hp / e.maxHp);
      ctx.fillStyle = ratio > 0.5 ? '#4ade80' : ratio > 0.22 ? '#facc15' : '#ef4444';
      ctx.fillRect(bx, by, bw * ratio, bh);
      ctx.strokeStyle = 'rgba(255,255,255,.18)';
      ctx.strokeRect(bx - 1.5, by - 1.5, bw + 3, bh + 3);
    }

    function overlay() {
      // 受伤红屏
      if (state.hurtFlash > 0) {
        ctx.save();
        ctx.globalAlpha = (state.hurtFlash / TUNE.feel.hurtFlash) * 0.35;
        ctx.fillStyle = '#ff2d2d';
        ctx.fillRect(0, 0, V.w, V.h);
        ctx.restore();
      }

      // 暗角，收拢视线
      const vg = ctx.createRadialGradient(V.w / 2, V.h / 2, V.h * 0.35, V.w / 2, V.h / 2, V.h * 0.95);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(0,0,0,.45)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, V.w, V.h);
    }

    function draw() {
      const t = state.t;
      // 抖动：整体平移
      const sx = state.shake ? (Math.random() - 0.5) * state.shake * 2 : 0;
      const sy = state.shake ? (Math.random() - 0.5) * state.shake * 2 : 0;

      ctx.save();
      ctx.translate(Math.round(sx), Math.round(sy));

      background(t);
      enemy(t);
      hero(t);
      Svc.get('fx').drawWorld(ctx);
      overlay();

      ctx.restore();
    }

    return { draw: draw, fit: fit, canvas: canvas, ctx: ctx, drawSprite: drawSprite };
  })();
  Svc.set('render', render);

  /* =========================================================
     11. ui 服务 —— 右侧面板
     ========================================================= */
  const ui = (function () {
    const el = (id) => document.getElementById(id);
    const cache = {};
    let currentTab = 'hero';
    let acc = 0;

    function setText(id, val) {
      if (cache[id] === val) return;
      cache[id] = val;
      const n = el(id);
      if (n) n.textContent = val;
    }

    function toast(msg) {
      const wrap = el('toasts');
      if (!wrap) return;
      const d = document.createElement('div');
      d.className = 'toast';
      d.textContent = msg;
      wrap.appendChild(d);
      setTimeout(() => {
        d.style.transition = 'opacity .3s';
        d.style.opacity = '0';
        setTimeout(() => d.remove(), 320);
      }, 1500);
    }

    function tick(dt) {
      acc += dt;
      if (acc < 0.1) return;
      acc = 0;

      const hp = Math.max(0, Math.round(state.hero.hp));
      const mhp = derive.maxHp();
      setText('heroLv', state.hero.level);
      setText('heroAtk', derive.atk().toFixed(0));
      setText('hpTxt', hp + ' / ' + mhp);
      setText('xpTxt', Math.floor(state.hero.xp) + ' / ' + derive.xpNeed());
      if (el('hpFill')) el('hpFill').style.width = (hp / mhp * 100).toFixed(1) + '%';
      if (el('xpFill')) el('xpFill').style.width = (state.hero.xp / derive.xpNeed() * 100).toFixed(1) + '%';
      setText('hudGold', state.gold);
      setText('hudStage', state.stage);
      setText('hudKills', state.kills);

      if (currentTab === 'skill') refreshSkillButtons();
    }

    function refreshSkillButtons() {
      const nodes = document.querySelectorAll('#tabBody button[data-skill]');
      nodes.forEach((btn) => {
        const id = btn.dataset.skill;
        const sk = TUNE.skills.find((s) => s.id === id);
        if (!sk) return;
        const cost = derive.skillCost(sk);
        btn.textContent = cost + ' 金';
        btn.disabled = state.gold < cost;
      });
    }

    function renderTab(name) {
      const body = el('tabBody');
      if (!body) return;
      body.innerHTML = '';

      if (name === 'hero') {
        body.innerHTML =
          '<div class="row"><div class="icon">⚔️</div><div class="info">' +
          '<div class="nm">攻击力 ' + derive.atk().toFixed(0) + '</div>' +
          '<div class="sub">基础 + 等级 + 技能</div></div></div>' +
          '<div class="row"><div class="icon">❤️</div><div class="info">' +
          '<div class="nm">最大生命 ' + derive.maxHp() + '</div>' +
          '<div class="sub">每秒回复 ' + derive.regen().toFixed(1) + '</div></div></div>' +
          '<div class="row"><div class="icon">💨</div><div class="info">' +
          '<div class="nm">攻击间隔 ' + (derive.interval() * 1000).toFixed(0) + ' ms</div>' +
          '<div class="sub">攻速加成 ' + (state.hero.speedBonus * 100).toFixed(0) + '%</div></div></div>' +
          '<div class="row"><div class="icon">🎯</div><div class="info">' +
          '<div class="nm">暴击率 ' + (derive.crit() * 100).toFixed(0) + '%</div>' +
          '<div class="sub">暴击造成 2 倍伤害</div></div></div>' +
          '<div class="row"><div class="icon">🗡️</div><div class="info">' +
          '<div class="nm">累计击杀 ' + state.kills + '</div>' +
          '<div class="sub">每 ' + TUNE.stage.enemiesPerStage + ' 只进入下一关</div></div></div>';
        return;
      }

      if (name === 'gear') {
        body.innerHTML =
          '<div class="row"><div class="icon">🗡️</div><div class="info">' +
          '<div class="nm">武器</div><div class="sub">未装备 · 开发中</div></div>' +
          '<button class="btn ghost" disabled>空</button></div>' +
          '<div style="color:var(--muted);font-size:12px;text-align:center;padding:14px 0">' +
          '装备系统将在下个版本加入</div>';
        return;
      }

      if (name === 'skill') {
        TUNE.skills.forEach((sk) => {
          const lv = state.skillLv[sk.id] || 0;
          const cost = derive.skillCost(sk);
          const row = document.createElement('div');
          row.className = 'row';
          row.innerHTML =
            '<div class="icon">' + sk.icon + '</div>' +
            '<div class="info"><div class="nm">' + sk.name +
            ' <span style="color:var(--gold);font-size:11px">Lv.' + lv + '</span></div>' +
            '<div class="sub">' + sk.desc + '</div></div>';
          const btn = document.createElement('button');
          btn.className = 'btn';
          btn.dataset.skill = sk.id;
          btn.textContent = cost + ' 金';
          btn.onclick = () => {
            if (Svc.get('combat').buySkill(sk)) renderTab('skill');
          };
          row.appendChild(btn);
          body.appendChild(row);
        });
        refreshSkillButtons();
        return;
      }

      if (name === 'setting') {
        body.innerHTML =
          '<div class="row"><div class="icon">💾</div><div class="info">' +
          '<div class="nm">存档</div><div class="sub">自动保存（本地 + 服务端）</div></div>' +
          '<button class="btn" id="saveBtn">立即保存</button></div>' +
          '<div class="row"><div class="icon">🗑️</div><div class="info">' +
          '<div class="nm">重置进度</div><div class="sub">清空等级、金币与技能</div></div>' +
          '<button class="btn ghost" id="resetBtn">重置</button></div>' +
          '<div style="color:var(--muted);font-size:11px;line-height:1.8;padding:10px 6px">' +
          '离线收益：关闭页面后按每秒 ' + TUNE.offline.goldPerSec +
          ' 金币累计，最多 ' + TUNE.offline.maxHours + ' 小时。</div>' +
          '<div class="row"><div class="icon">🏷️</div><div class="info">' +
          '<div class="nm">版本</div><div class="sub" id="verTxt">读取中…</div></div></div>';

        if (el('saveBtn')) {
          el('saveBtn').onclick = () => {
            Svc.get('save').write() ? toast('已保存') : toast('保存失败');
          };
        }
        if (el('resetBtn')) {
          el('resetBtn').onclick = async () => {
            if (!confirm('确定要清空全部进度吗？此操作不可恢复。')) return;
            await Svc.get('save').reset();
            location.reload();
          };
        }

        (async () => {
          const n = el('verTxt');
          if (!n) return;
          try {
            const r = await fetch(VERSION_API, { headers: { 'Accept': 'application/json' } });
            if (!r.ok) throw new Error('bad');
            const v = await r.json();
            n.textContent = v.version + ' · ' + v.size + ' 字节 · ' + v.fingerprint;
          } catch (e) {
            n.textContent = '离线模式（未连接服务端）';
          }
        })();
        return;
      }
    }

    function bindTabs() {
      document.querySelectorAll('.tab').forEach((t) => {
        t.onclick = () => {
          document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
          t.classList.add('active');
          currentTab = t.dataset.tab;
          renderTab(currentTab);
        };
      });
    }

    function drawAvatar() {
      const av = el('avatar');
      if (!av) return;
      const g = av.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.clearRect(0, 0, 16, 16);
      const sp = buildSprite('hero');
      g.drawImage(sp.canvas, 0, 0, sp.w, sp.h, 0, 2, 16, 16);
    }

    return {
      tick: tick, toast: toast, renderTab: renderTab, bindTabs: bindTabs,
      drawAvatar: drawAvatar, getTab: () => currentTab
    };
  })();
  Svc.set('ui', ui);

  /* =========================================================
     12. 事件订阅 —— 表现层只订阅，不侵入逻辑
     ========================================================= */
  (function wire() {
    const V = TUNE.view;
    const F = TUNE.feel;

    bus.on('enemy:spawn', () => { state.heroAtkTimer = 0; });

    bus.on('hero:swing', (p) => {
      const e = p.enemy;
      const crit = p.crit;
      fx.hit(e.x + 14, V.groundY - 30, crit ? '#ffcc4d' : '#ffffff', crit ? 10 : 5);
      fx.float(e.x + 14, V.groundY - 40, (crit ? '暴击 ' : '') + p.damage, crit ? PAL.gold : '#ffffff');
      fx.flash(e.x + 14, V.groundY - 30, 26, 'rgb(180,220,255)', 0.16);
      fx.shake(F.shakeHit);
      fx.hitStop(F.hitStopHit);
    });

    bus.on('enemy:killed', (p) => {
      fx.float(V.enemyX + 12, V.groundY - 46, '+' + p.gold + '金', PAL.gold);
      fx.hit(V.enemyX + 16, V.groundY - 34, '#8ee6a0', 12);
      fx.flash(V.enemyX + 16, V.groundY - 30, 44, 'rgb(140,255,180)', 0.26);
      fx.shake(F.shakeKill);
      fx.hitStop(F.hitStopKill);
    });

    bus.on('enemy:telegraph', (p) => {
      // 预警：扩散环 + 轻微光斑，玩家能预判“要挨打了”
      fx.ring(p.pos.x + 16, V.groundY - 14, 30, '#ff6b4a', p.time * 0.75);
      fx.ring(p.pos.x + 16, V.groundY - 14, 18, '#ffcc4d', p.time * 0.5);
      fx.flash(p.pos.x + 16, V.groundY - 20, 22, 'rgb(255,90,60)', 0.12);
    });

    bus.on('hero:hurt', (p) => {
      state.hurtFlash = F.hurtFlash;
      fx.float(V.heroX + 16, V.groundY - 44, '-' + p.damage, '#ff6b6f');
      fx.hit(V.heroX + 16, V.groundY - 24, '#ff6b6f', 6);
      fx.shake(F.shakeHit * 1.6);
    });

    bus.on('hero:levelup', (p) => {
      ui.toast('升级！Lv.' + p.level);
      fx.float(V.heroX + 16, V.groundY - 56, 'LEVEL UP', '#7dd3fc');
      fx.ring(V.heroX + 16, V.groundY - 20, 40, '#7dd3fc', 0.6);
      fx.flash(V.heroX + 16, V.groundY - 20, 40, 'rgb(125,211,252)', 0.3);
    });

    bus.on('stage:change', (p) => { ui.toast('进入第 ' + p.stage + ' 关'); });

    bus.on('hero:defeat', (p) => {
      ui.toast(p.lost > 0 ? '被击败了…损失 ' + p.lost + ' 金币' : '被击败了…');
      fx.shake(4);
      fx.hitStop(0.16);
    });

    bus.on('skill:bought', (p) => {
      ui.toast(p.skill.name + ' 提升至 Lv.' + p.level);
    });
  })();

  /* =========================================================
     13. 主循环
     ========================================================= */
  function update(dt) {
    // 顿帧：短暂把时间压慢，制造打击感（Saltline 的 hit-stop 思路）
    if (state.hitStop > 0) {
      state.hitStop = Math.max(0, state.hitStop - dt);
      dt *= TUNE.feel.hitStopScale;
    }

    state.t += dt;

    if (state.heroSwing > 0) state.heroSwing = Math.max(0, state.heroSwing - dt);
    if (state.enemyLunge > 0) state.enemyLunge = Math.max(0, state.enemyLunge - dt);

    const e = state.enemy;
    if (e) {
      if (e.phase === 'enter') {
        Svc.get('combat').enemyTick(dt);
        return;
      }

      // 生命回复
      state.regenAcc += derive.regen() * dt;
      if (state.regenAcc >= 1) {
        const heal = Math.floor(state.regenAcc);
        state.regenAcc -= heal;
        state.hero.hp = Math.min(derive.maxHp(), state.hero.hp + heal);
      }

      // 英雄自动攻击
      state.heroAtkTimer += dt;
      const ai = derive.interval();
      while (state.heroAtkTimer >= ai) {
        state.heroAtkTimer -= ai;
        Svc.get('combat').heroAttack();
        if (!state.enemy) break;
      }

      // 敌人状态机（含预警）
      if (state.enemy) Svc.get('combat').enemyTick(dt);
    }

    Svc.get('fx').update(dt);
  }

  let last = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (!last) last = now;
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.25) dt = 0.25;

    update(dt);
    Svc.get('render').draw();
    Svc.get('ui').tick(dt);
  }

  /* =========================================================
     14. 离线收益
     ========================================================= */
  function applyOffline(saved) {
    const now = Date.now();
    const away = Math.max(0, Math.floor((now - (saved.time || now)) / 1000));
    if (away < 60) return;

    const capped = Math.min(away, TUNE.offline.maxHours * 3600);
    const gold = Math.floor(capped * TUNE.offline.goldPerSec);
    if (gold <= 0) return;

    const tEl = document.getElementById('offTime');
    const gEl = document.getElementById('offGold');
    const box = document.getElementById('offline');
    if (!box) return;

    if (tEl) tEl.textContent = formatDuration(capped);
    if (gEl) gEl.textContent = gold + ' 金币';
    box.classList.add('show');

    const ok = document.getElementById('offOk');
    if (ok) {
      ok.onclick = () => {
        state.gold += gold;
        box.classList.remove('show');
        Svc.get('save').write();
      };
    }
  }

  function formatDuration(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return h + ' 小时 ' + m + ' 分钟';
    if (m > 0) return m + ' 分钟 ' + s + ' 秒';
    return s + ' 秒';
  }

  /* =========================================================
     15. 启动
     ========================================================= */
  async function boot() {
    const saveSvc = Svc.get('save');
    let saved = null;
    try {
      saved = await saveSvc.read();
    } catch (e) {
      saved = saveSvc.readLocal();
    }

    if (saved) {
      saveSvc.apply(saved);
      applyOffline(saved);
    } else {
      state.hero.hp = derive.maxHp();
    }

    Svc.get('render').fit();
    Svc.get('ui').drawAvatar();
    Svc.get('ui').bindTabs();
    Svc.get('ui').renderTab('hero');

    Svc.get('combat').spawnEnemy();

    // 若本地档比服务端新（例如服务宕机期间玩过），立即回写对齐两端
    if (state.saveSource === 'local-newer' || state.saveSource === 'local') {
      saveSvc.write();
    }

    /* —— 自动保存：定时 + 重要节点 + 关页 —— */
    setInterval(() => saveSvc.write(), 5000);

    // 关键进度立刻落盘，避免"刚升级就崩溃"丢档
    bus.on('hero:levelup', () => saveSvc.write());
    bus.on('skill:bought', () => saveSvc.write());
    bus.on('stage:change', () => saveSvc.write());

    window.addEventListener('pagehide', () => saveSvc.writeOnExit());
    window.addEventListener('beforeunload', () => saveSvc.writeOnExit());
    window.addEventListener('resize', () => Svc.get('render').fit());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveSvc.writeOnExit();
    });

    const cv = Svc.get('render').canvas;
    if (cv) {
      cv.addEventListener('pointerdown', () => {
        fx.hit(TUNE.view.heroX + 20, TUNE.view.groundY - 20, '#7dd3fc', 3);
      });
    }

    // 调试入口（开发期用）
    window.__pixelidle = { state: state, TUNE: TUNE, bus: bus, Svc: Svc };

    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { boot().catch((e) => console.error(e)); });
  } else {
    boot().catch((e) => console.error(e));
  }
})();
