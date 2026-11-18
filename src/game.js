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
      w: 320, h: 180, groundY: 132, heroX: 74, enemyX: 224,
      heroPx: 3,        // 主角像素倍率（原 2 → 放大一半）
      enemyPx: 3,       // 敌人像素倍率
      swordPx: 2,       // 飞剑倍率（剑本身够长，不跟着放大）
      px: 2             // 兼容位：特效/阴影等通用参考
    },

    hero: {
      baseHp: 100, hpPerLevel: 20,
      baseAtk: 5, atkPerLevel: 2,
      baseInterval: 0.8, minInterval: 0.16,
      baseCrit: 0.05, maxCrit: 0.75,
      baseRegen: 0.3,
      dmgVariance: 0.2,     // ±10%

      /* —— 飞剑（攻击表现 + 伤害结算时机）—— */
      projectile: {
        dur: 0.12,          // 飞行时间。必须 < minInterval(0.16)，否则会出现多把剑同时在飞
        fromDX: 18,         // 出手点相对英雄的横向偏移
        fromDY: -20,        // 出手点相对地面的纵向偏移（约胸口高度）
        arc: 5,             // 飞行途中的弧线抬升（别太高，否则剑会从怪头顶飞过）
        trail: 16,          // 剑气拖尾长度（像素），不是残影份数
        spin: false         // 飞剑是否旋转（像素风水平飞更干净，默认关）
      }
    },

    /* 敌人属性随关卡分层成长 */
    /* —— 关卡结构：每关 10 只，前 5 普通、6-9 精英、10 首领 ——
       unlock(N) = unlockBase + round(unlockStep * (N-1))
       取值比「一次通关自然能到的等级」略高，逼出适度刷取，但不至于挂机一小时。 */
    stage: {
      enemiesPerStage: 10,
      tierMul: 1.55,
      normalCount: 5,
      unlockBase: 2,
      unlockStep: 1.15,
      /* 血量按关卡平滑曲线，而不是沿用「怪物基础血量 × 梯队」——
         后者在换梯队时会砸出锯齿（第 8 关又回到史莱姆，血量骤降），
         导致门槛玩家的击杀时长忽长忽短。曲线由 calibrate-gear.js 拟合：
         达标玩家 DPS ≈ 8.85 × N^0.78，所以普通怪血量 ≈ 70 × N^0.78 → 约 8 秒。 */
      hp: { base: 70, pow: 0.78 },
      /* 攻击力同理：boss 战要打 ~35 秒，若沿用「基础攻击 × 梯队」，
         高关卡的英雄会被打死（实测第 35 关会死 3 次）。曲线按生存性反向定：
         让达标英雄撑完 35 秒后还剩约 40% 血。 */
      atk: { base: 2, pow: 0.55 },
      typeHp: { slime: 0.9, bat: 1.0, skeleton: 1.08, golem: 1.15 },
      typeAtk: { slime: 0.8, bat: 0.9, skeleton: 1.0, golem: 1.2 },
      kind: {
        normal: { label: '普通怪', hpMul: 1.0, atkMul: 1.0,  goldMul: 1,   xpMul: 1 },
        elite:  { label: '精英怪', hpMul: 2.2, atkMul: 1.15, goldMul: 2.5, xpMul: 2 },
        boss:   { label: '首领',   hpMul: 4.4, atkMul: 1.3,  goldMul: 6,   xpMul: 5 }
      },
      // 达标玩家在该只怪上的目标击杀秒数（用于校准敌人血量，不参与运行）
      targetSecs: { normal: 8, elite: 18, boss: 35 }
    },

    /* —— 强化 —— */
    reinforce: {
      maxPlus: 10,          // 强化上限
      costPerLevel: 3,      // 每级消耗 3 颗同等级强化石
      gainPerLevel: 0.06    // 每级 +6% 该件属性（+10 → +60%）
    },

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

    /* —— 关卡背景主题：按「本关出现的怪物种类」选配色与装饰 —— */
    themes: {
      slime: {
        name: '沼泽', deco: 'spores', moon: false, stars: 26,
        sky: ['#07120c', '#0f2417', '#1b3b23'],
        far: '#102016', near: '#0a1610',
        ground: ['#23371d', '#0c130a'], accent: '#7fe07f'
      },
      bat: {
        name: '洞窟', deco: 'cave', moon: false, stars: 0,
        sky: ['#08060f', '#141024', '#221a36'],
        far: '#130f20', near: '#0c0917', ceil: '#2b2342',
        ground: ['#1d1730', '#0a0813'], accent: '#a878e8'
      },
      skeleton: {
        name: '墓园', deco: 'graves', moon: true, stars: 34,
        sky: ['#06080f', '#101622', '#1a2432'],
        far: '#151b27', near: '#0e131d',
        ground: ['#2b3039', '#11141a'], accent: '#9fc4e8'
      },
      golem: {
        name: '熔岩', deco: 'ember', moon: false, stars: 10,
        sky: ['#140706', '#280d0a', '#3d150d'],
        far: '#22100b', near: '#150a07',
        ground: ['#3a1a12', '#170806'], accent: '#ff8a3c'
      }
    },

    /* —— 装备（4 槽 / 3 品质 / 无背包 / 纯自动）——
       取舍：不新增战斗机制，词条只作用于已有的 5 个属性。 */
    gear: {
      slots: [
        { id: 'weapon',  name: '武器', icon: '🗡️', primary: 0 },
        { id: 'armor',   name: '护甲', icon: '🛡️', primary: 1 },
        { id: 'trinket', name: '饰品', icon: '💍', primary: 3 },
        { id: 'rune',    name: '符文', icon: '🔮', primary: 2 }
      ],
      // 索引语义：0 普通 / 1 稀有 / 2 传说（对应普通怪 / 精英怪 / 首领的掉落）
      rarities: [
        { id: 'common', name: '普通', color: '#8a90b0', affixes: 1, salvage: 1.0 },
        { id: 'rare',   name: '稀有', color: '#4d9eff', affixes: 2, salvage: 1.6 },
        { id: 'legend', name: '传说', color: '#ffcc4d', affixes: 3, salvage: 2.4 }
      ],
      // per 系数跑 DPS 校准得出（scripts/calibrate-gear.js），整体 ×0.33 后落在 +15%~+36%
      affixes: [
        { id: 'atk',   name: '锋利', base: 1,   per: 0.16, int: true,  score: 1,   fmt: function (v) { return '攻击 +' + v; } },
        { id: 'hp',    name: '坚固', base: 8,   per: 1.0,  int: true,  score: 0.1, fmt: function (v) { return '生命 +' + v; } },
        { id: 'speed', name: '疾风', base: 2,   per: 0.12, cap: 25,   score: 1,   fmt: function (v) { return '攻速 +' + v + '%'; } },
        { id: 'crit',  name: '锐利', base: 1,   per: 0.08, cap: 12,   score: 1,   fmt: function (v) { return '暴击 +' + v + '%'; } },
        { id: 'regen', name: '再生', base: 0.2, per: 0.03, cap: 6,    score: 2,   fmt: function (v) { return '回复 +' + v; } }
      ],
      salvageBase: 5,
      salvagePer: 3
    },

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
  const SAVE_VERSION = 3;     // v3：关卡进度 / 强化石 / 强化等级
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
    mobIndex: 1,          // 本关第几只怪（1..10）
    maxStage: 1,          // 已解锁的最高关卡
    stones: {},           // 强化石库存：{ 等级: 数量 }
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
    projectiles: [],        // 在飞的飞剑
    equipped: [null, null, null, null],   // 四槽装备
    gearBonus: { atk: 0, hp: 0, speed: 0, crit: 0, regen: 0 },
    lastSave: 0,
    pendingSave: false
  };

  /* 派生属性 */
  const derive = {
    maxHp: () => TUNE.hero.baseHp + state.hero.hpBonus + state.gearBonus.hp
               + (state.hero.level - 1) * TUNE.hero.hpPerLevel,
    atk: () => TUNE.hero.baseAtk + state.hero.atkBonus + state.gearBonus.atk
               + (state.hero.level - 1) * TUNE.hero.atkPerLevel,
    interval: () => Math.max(TUNE.hero.minInterval,
               TUNE.hero.baseInterval / (1 + state.hero.speedBonus + state.gearBonus.speed)),
    crit: () => Math.min(TUNE.hero.maxCrit, TUNE.hero.baseCrit + state.hero.critBonus + state.gearBonus.crit),
    regen: () => TUNE.hero.baseRegen + state.hero.regenBonus + state.gearBonus.regen,
    xpNeed: () => Math.round(TUNE.xp.base + Math.pow(state.hero.level, TUNE.xp.pow) * TUNE.xp.mul),
    skillCost: (sk) => Math.round(sk.baseCost * Math.pow(sk.grow, state.skillLv[sk.id] || 0))
  };

  /**
   * 飞剑在归一化进度 u（0=出手, 1=命中）处的位置。
   *
   * 做成纯函数的原因：残影要根据「过去几个时刻」的位置采样，
   * 如果只存当前位置就得记历史数组，既占内存又依赖帧率。
   * 纯函数采样则与帧率无关，残影间距恒定。
   */
  function projPos(p, u) {
    const k = 1 - Math.pow(1 - Math.max(0, Math.min(1, u)), 2.2);  // 先快后慢
    const lift = Math.sin(u * Math.PI) * TUNE.hero.projectile.arc;  // 中途抬起的弧线
    return {
      x: p.sx + (p.tx - p.sx) * k,
      y: p.sy + (p.ty - p.sy) * k - lift
    };
  }

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
    bladeEdge: '#7fb8f0', bladeCore: '#ffffff',
    hilt: '#8a5a32',
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
    },

    /* 飞剑：朝右，剑柄在左、剑尖在右。上中下三行做成「亮芯 + 蓝边」的发光刃 */
    sword: {
      pal: { h: PAL.hilt, g: PAL.gold, e: PAL.bladeEdge, w: PAL.bladeCore },
      art: [
        '..gg.eeeeee',
        'hhggewwwwww',
        '..gg.eeeeee'
      ]
    }
  };

  /* -------------------------------------------------------------------------
     调色板皮肤（① 配方 + 变体）

     思路借自 Saltline：一个材质配方配不同 seed 能出无数张贴图。
     PixelIdle 的美术是手绘数据，形状改不了，但「颜色」是纯粹的查表，
     所以同一份 art 换一套 pal 就是一个新变体 —— 零新增像素、零体积增长。

     皮肤只覆盖列出的字母，没列出的沿用基础 pal。
     ------------------------------------------------------------------------- */
  const SKINS = {
    slime: {
      elite:     { g: '#7fe0f5', d: '#3f8fa8', e: '#0a2230', w: '#eafcff' },
      corrupted: { g: '#b48aff', d: '#6b4fa8', e: '#1a0a2e', w: '#f0e6ff' }
    },
    bat: {
      elite:     { b: '#e0608f', d: '#9c3a5f', w: '#b04a78', e: '#ffe9a3' },
      corrupted: { b: '#6d8a45', d: '#3f5228', w: '#4f6633', e: '#c8ff7a' }
    },
    skeleton: {
      elite:     { s: '#cfe6ff', d: '#8fa8c4', e: '#7ad4ff' },
      corrupted: { s: '#c9b89a', d: '#8a7a5e', e: '#8dff5a' }
    },
    golem: {
      elite:     { g: '#b8a8ff', d: '#6b5f9a', c: '#ffd23c' },
      corrupted: { g: '#7a6a52', d: '#4a3f2e', c: '#8dff5a' }
    }
  };

  /* 变体的轮廓光颜色：让「这只不一样」一眼可见，不依赖文字（7px 中文看不清） */
  const SKIN_OUTLINE = {
    elite: '#ffd23c',
    corrupted: '#7cff6a'
  };

  /* 把字符串精灵预渲染成离屏 canvas */
  const spriteCache = {};

  /* ③ 缓存粒度下沉：key 必须带上皮肤，否则换表不生效（旧实现在这里有坑） */
  function spriteKey(name, skin) { return skin ? name + '::' + skin : name; }

  /* 确定性哈希：同一格像素永远得到同一个值，损伤贴花才不会每帧闪烁 */
  function cellHash(a, x, y) {
    let h = 2166136261 ^ a;
    h = Math.imul(h ^ x, 16777619);
    h = Math.imul(h ^ y, 16777619);
    h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
  }

  function buildSprite(name, skin) {
    const key = spriteKey(name, skin);
    if (spriteCache[key]) return spriteCache[key];

    const def = SPRITES[name];
    const over = (skin && SKINS[name] && SKINS[name][skin]) || null;
    const pal = over ? Object.assign({}, def.pal, over) : def.pal;

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

    // 轮廓掩码 + 每格原色，后面做轮廓光和损伤层都要用
    const mask = new Uint8Array(w * h);
    const pixels = new Array(w * h);

    for (let y = 0; y < h; y++) {
      const row = rows[y];
      for (let x = 0; x < w; x++) {
        const ch = row[x];
        if (!ch || ch === '.' || ch === ' ') continue;
        const hex = pal[ch];
        if (!hex) continue;
        const c4 = rgba(hex);
        const i = (y * w + x) * 4;
        img.data[i] = c4[0]; img.data[i + 1] = c4[1];
        img.data[i + 2] = c4[2]; img.data[i + 3] = c4[3];
        mask[y * w + x] = 1;
        pixels[y * w + x] = c4;
      }
    }
    g.putImageData(img, 0, 0);

    // 尾部全空的行数：贴地时要扣掉，否则 bat 这类底部留白的精灵会「浮」在空中
    let foot = 0;
    for (let y = h - 1; y >= 0; y--) {
      const row = rows[y] || '';
      if (/^[. ]*$/.test(row)) foot++; else break;
    }

    const entry = {
      canvas: c, w: w, h: h, mask: mask, foot: foot,
      outline: null,
      damage: null
    };

    /* ② 分层损伤贴花：chips（缺口）/ stain（污渍）/ run（锈流）
       全部在构建期算好并按「损伤程度」分成 3 档，绘制时按血量取一档，
       不用每帧算噪声，也不会闪。像素风必须用硬边阶跃，不能线性淡入。 */
    entry.damage = buildDamage(mask, pixels, w, h, name + (skin || ''));
    entry.outline = buildOutline(mask, w, h, SKIN_OUTLINE[skin] || null);

    spriteCache[key] = entry;
    return entry;
  }

  /** 轮廓光：把贴边格子涂成变体色，用来一眼区分精英/腐化 */
  function buildOutline(mask, w, h, color) {
    if (!color) return null;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const img = g.createImageData(w, h);
    const rgb = parseInt(color.slice(1), 16);
    const r = (rgb >> 16) & 255, gg = (rgb >> 8) & 255, b = rgb & 255;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x]) continue;                    // 只在外部描边
        const near =
          (x > 0 && mask[y * w + x - 1]) || (x < w - 1 && mask[y * w + x + 1]) ||
          (y > 0 && mask[(y - 1) * w + x]) || (y < h - 1 && mask[(y + 1) * w + x]);
        if (!near) continue;
        const i = (y * w + x) * 4;
        img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  /** 损伤层：3 档，越靠后越破碎。
   *
   * 两条经验（都是踩坑得来的）：
   * 1. 必须**按 2×2 块**掉块，不能逐像素判定。逐像素时方块状精灵的边
   *    是一整列，会一起被啃掉，结果是一条条竖直暗带。
   * 2. 密度必须低。10×12 的精灵塞满噪点就糊成一团脏污。
   */
  function buildDamage(mask, pixels, w, h, seedStr) {
    let seed = 0;
    for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) | 0;

    const B = 2;                                  // 块边长（美术像素）
    const bw = Math.ceil(w / B), bh = Math.ceil(h / B);

    // 每块的统计：不透明像素数、是否贴边
    const blk = new Array(bw * bh);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let n = 0, edgeCells = 0, cells = [];
        for (let dy = 0; dy < B; dy++) {
          for (let dx = 0; dx < B; dx++) {
            const x = bx * B + dx, y = by * B + dy;
            if (x >= w || y >= h) continue;
            if (!mask[y * w + x]) continue;
            n++; cells.push(y * w + x);
            const l = x === 0 || !mask[y * w + x - 1];
            const r = x === w - 1 || !mask[y * w + x + 1];
            const u = y === 0 || !mask[(y - 1) * w + x];
            const d = y === h - 1 || !mask[(y + 1) * w + x];
            if (l || r || u || d) edgeCells++;
          }
        }
        blk[by * bw + bx] = { n: n, edge: edgeCells > 0, cells: cells };
      }
    }

    const STAGES = 3;
    const out = [];
    for (let s = 1; s <= STAGES; s++) {
      const amt = s / (STAGES + 1);              // 0.25 / 0.5 / 0.75
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      const img = g.createImageData(w, h);
      const paint = (idx, r, gg, b) => {
        const i = idx * 4;
        img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
      };

      for (let bi = 0; bi < blk.length; bi++) {
        const b = blk[bi];
        if (!b.n) continue;
        const t = cellHash(seed, bi, 0);

        // 掉块：边缘块概率高（从轮廓开始崩），内部块概率很低
        const chipP = (b.edge ? 0.62 : 0.12) * amt;
        if (t < chipP) {
          for (const idx of b.cells) {
            const px = pixels[idx];
            paint(idx, Math.round(px[0] * 0.13), Math.round(px[1] * 0.13), Math.round(px[2] * 0.16));
          }
          continue;
        }

        // 污渍：整块压暗，保留色相
        const t2 = cellHash(seed + 7919, bi, 0);
        if (t2 < amt * 0.3) {
          for (const idx of b.cells) {
            const px = pixels[idx];
            paint(idx, Math.round(px[0] * 0.6), Math.round(px[1] * 0.58), Math.round(px[2] * 0.56));
          }
        }
      }
      g.putImageData(img, 0, 0);
      out.push(c);
    }
    return out;
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
     7.5 film 服务 —— pixelfx 特效层（第三方，见 THIRD-PARTY-NOTICES.md）

     为什么单独一层：pixelfx 的绘制模型是「离屏帧缓冲 + 32 位像素数组 + composite」，
     和本项目直接往 ctx 上 fillRect 的方式不同。硬改会动到整条渲染管线，
     所以让它自己画在一张独立的离屏 canvas 上，最后 drawImage 叠回舞台。
     这样 combat / render 都不需要知道它的存在。

     PixelFX 由 scripts/build-fx.js 从 vendor/pixelfx 编译而来；
     如果产物缺失（比如只改了源码没跑构建），这里会安静降级为零特效，
     游戏照常运行，不会白屏。
     ========================================================= */
  const film = (function () {
    const FX = typeof PixelFX !== 'undefined' ? PixelFX : null;
    const V = TUNE.view;
    const live = [];

    let frame = null, img = null, canvas = null, cctx = null;

    if (FX) {
      frame = FX.createFrame(V.w, V.h);
      img = new ImageData(V.w, V.h);
      canvas = document.createElement('canvas');
      canvas.width = V.w;
      canvas.height = V.h;
      cctx = canvas.getContext('2d');
      cctx.imageSmoothingEnabled = false;
    }

    /** 播一个特效。mod 是 PixelFX 上的特效模块；没有则什么都不做。 */
    function play(mod, x, y, opts) {
      if (!FX || !mod) return null;
      const o = Object.assign({ x: x, y: y, seed: (Math.random() * 1e6) | 0 }, opts || {});
      const inst = FX.createFx(mod, o);
      live.push(inst);
      return inst;
    }

    /**
     * 命中特效：普通和暴击用同一套图形，只换调色板。
     *
     * height 必须传 0：这个特效默认向上抬高 20 像素（为了让火花落到地面线），
     * 但本项目的锚点本来就是身体中心，不抵消的话整团光会浮在头顶上方约 17px。
     */
    function hit(x, y, crit) {
      const palette = crit
        ? ['#5a2c05', '#c47a10', '#f2b31d', '#ffd75e', '#ffe9a3', '#fff8d8', '#ffffff']
        : ['#4a1712', '#c9281f', '#f2561d', '#ff8a2a', '#ffe26b', '#fff3a6', '#ffffff'];
      return play(FX && FX.hitSpark, x, y, { palette: palette, height: 0 });
    }

    function update(dt) {
      for (let i = live.length - 1; i >= 0; i--) {
        const inst = live[i];
        inst.update(dt);
        if (inst.done()) live.splice(i, 1);
      }
    }

    function draw(ctx) {
      if (!FX || !live.length) return;
      FX.clearFrame(frame);
      for (const inst of live) inst.draw(frame, 'front');
      FX.composite(frame, img.data, null);
      cctx.putImageData(img, 0, 0);
      ctx.drawImage(canvas, 0, 0);
    }

    function clear() {
      live.length = 0;
    }

    return { play: play, hit: hit, update: update, draw: draw, clear: clear, ready: !!FX };
  })();
  Svc.set('film', film);


  /* =========================================================
     7.6 equip 服务 —— 装备生成 / 自动装备 / 分解 / 加成重算

     设计要点：装备加成**不回写** state.hero.*Bonus（那是技能的领地），
     而是单独存在 state.gearBonus，由本服务在装备变化时整体重算。
     这样换装天然幂等，不存在「卸下时要减回去」的回滚 bug。
     ========================================================= */
  const equip = (function () {
    const G = TUNE.gear;

    /** 词条数值：品质决定条数，等级决定强度 */
    function affixValue(ai, ilvl) {
      const a = G.affixes[ai];
      let v = a.base + ilvl * a.per;
      if (a.cap != null) v = Math.min(a.cap, v);
      if (a.int) return Math.max(1, Math.round(v));
      return Math.max(0.1, Math.round(v * 10) / 10);
    }

    /** 生成一件装备。品质由调用方显式指定（掉落映射：普通怪→0，精英→1，首领→2） */
    function rollItem(slot, ilvl, rarity) {
      const rar = rarity | 0;
      const def = G.rarities[rar];
      const count = def.affixes;
      const used = [];
      const affixes = [];

      // 第一条保证是槽位主属性
      const primary = G.slots[slot].primary;
      used.push(primary);
      affixes.push([primary, affixValue(primary, ilvl)]);

      while (affixes.length < count) {
        const ai = Math.floor(Math.random() * G.affixes.length);
        if (used.indexOf(ai) >= 0) continue;
        used.push(ai);
        affixes.push([ai, affixValue(ai, ilvl)]);
      }
      return { slot: slot, rarity: rar, ilvl: ilvl, plus: 0, affixes: affixes };
    }

    /** 加权分：让不同词条可以横向比较（atk/hp/speed/crit/regen 归一） */
    function score(item) {
      const k = 1 + (item.plus || 0) * TUNE.reinforce.gainPerLevel;
      let s = 0;
      for (const p of item.affixes) s += p[1] * k * G.affixes[p[0]].score;
      return s;
    }

    /** 强化后的实际词条值（含 +N 增益），UI 与加成计算共用 */
    function effValue(item, pair) {
      const k = 1 + (item.plus || 0) * TUNE.reinforce.gainPerLevel;
      const a = G.affixes[pair[0]];
      return a.int ? Math.round(pair[1] * k) : Math.round(pair[1] * k * 10) / 10;
    }

    function salvageValue(item) {
      const mul = G.rarities[item.rarity].salvage;
      return Math.max(1, Math.round((G.salvageBase + item.ilvl * G.salvagePer) * mul));
    }

    /** 重算四槽加成（只在装备变化时调用） */
    function recompute() {
      const g = state.gearBonus;
      g.atk = 0; g.hp = 0; g.speed = 0; g.crit = 0; g.regen = 0;
      for (const it of state.equipped) {
        if (!it) continue;
        for (const p of it.affixes) {
          const id = G.affixes[p[0]].id;
          const v = effValue(it, p);
          if (id === 'atk') g.atk += v;
          else if (id === 'hp') g.hp += v;
          else if (id === 'speed') g.speed += v / 100;
          else if (id === 'crit') g.crit += v / 100;
          else g.regen += v;
        }
      }
      // 上限生命可能变低，钳一下当前血量
      state.hero.hp = Math.min(state.hero.hp, derive.maxHp());
    }

    /** 收到一件装备：更强就换上，否则折算金币 */
    function offer(item) {
      const cur = state.equipped[item.slot];
      const better = !cur || score(item) > score(cur);
      let gold = 0;
      if (better) {
        if (cur) gold = salvageValue(cur);
        state.equipped[item.slot] = item;
        gold += 0;
        state.gold += gold;
        recompute();
        bus.emit('item:equip', { item: item, replaced: cur, gold: gold });
        return { equipped: true, gold: gold };
      }
      gold = salvageValue(item);
      state.gold += gold;
      bus.emit('item:sold', { item: item, gold: gold });
      return { equipped: false, gold: gold };
    }

    /** 优先掉到「品质或等级还不达标」的槽位，避免随机槽位导致四件永远凑不齐 */
    function pickSlot(preferRarity, preferIlvl) {
      const lacking = [];
      for (let i = 0; i < 4; i++) {
        const it = state.equipped[i];
        if (!it || it.rarity < preferRarity || it.ilvl < preferIlvl) lacking.push(i);
      }
      const pool = lacking.length ? lacking : [0, 1, 2, 3];
      return pool[Math.floor(Math.random() * pool.length)];
    }

    /** 固定掉落：普通怪(0)→普通，精英(1)→稀有，首领(2)→传说，等级 = 当前关卡 */
    function dropFor(role, stage) {
      const rarity = role === 'boss' ? 2 : role === 'elite' ? 1 : 0;
      const slot = pickSlot(rarity, stage);
      const item = rollItem(slot, Math.max(1, stage), rarity);
      const r = offer(item);
      bus.emit('item:drop', { item: item, auto: r.equipped, gold: r.gold, role: role });
    }

    /* ---------- 强化石 ---------- */
    function addStones(level, n) {
      const lv = String(level);
      state.stones[lv] = (state.stones[lv] || 0) + n;
      bus.emit('stones:gain', { level: level, n: n });
    }

    function stoneTotal() {
      let t = 0;
      for (const k in state.stones) t += state.stones[k] || 0;
      return t;
    }

    /** 从「等级 >= minLevel」的石头里按等级从低到高消耗 count 颗 */
    function consumeStones(minLevel, count) {
      const levels = Object.keys(state.stones)
        .map(Number).filter(function (l) { return l >= minLevel; })
        .sort(function (a, b) { return a - b; });
      let left = count;
      for (const l of levels) {
        if (left <= 0) break;
        const have = state.stones[String(l)] || 0;
        const use = Math.min(have, left);
        if (use > 0) {
          state.stones[String(l)] = have - use;
          if (state.stones[String(l)] === 0) delete state.stones[String(l)];
          left -= use;
        }
      }
      return left <= 0;
    }

    /**
     * 强化一个槽位。返回值说明失败原因，供 UI 提示。
     * 石头要求：等级 >= 装备 ilvl（高等级石头可以强化低等级装备，反之不行）。
     */
    function strengthen(slotIdx) {
      const it = state.equipped[slotIdx];
      const R = TUNE.reinforce;
      if (!it) return { ok: false, reason: 'empty' };
      if ((it.plus || 0) >= R.maxPlus) return { ok: false, reason: 'max' };
      const cost = R.costPerLevel;
      if (!consumeStones(it.ilvl, cost)) return { ok: false, reason: 'stones', need: cost };
      it.plus = (it.plus || 0) + 1;
      recompute();
      bus.emit('item:strengthen', { item: it, slot: slotIdx, plus: it.plus });
      return { ok: true, plus: it.plus };
    }

    /** 新手礼包：空手开局时给一把普通武器，让装备页不是空的 */
    function gift() {
      if (state.equipped.some(Boolean)) return false;
      const item = rollItem(0, Math.max(1, state.stage), 0);
      state.equipped[0] = item;
      recompute();
      bus.emit('item:equip', { item: item, replaced: null, gold: 0 });
      return true;
    }

    /** 存档用紧凑编码：[slot, rarity, ilvl, plus, [ai, v, ai, v, ...]] */
    function pack(item) {
      if (!item) return 0;
      const flat = [];
      for (const p of item.affixes) { flat.push(p[0], p[1]); }
      return [item.slot, item.rarity, item.ilvl, item.plus || 0, flat];
    }

    function unpack(arr) {
      if (!arr || !Array.isArray(arr) || arr.length < 4) return null;
      const slot = arr[0] | 0, rarity = arr[1] | 0, ilvl = arr[2] | 0;
      // 兼容 v2 的 4 段编码（无 plus）
      const hasPlus = arr.length >= 5 && Array.isArray(arr[4]);
      const plus = hasPlus ? Math.max(0, Math.min(TUNE.reinforce.maxPlus, arr[3] | 0)) : 0;
      const flat = hasPlus ? arr[4] : arr[3];
      if (!(slot >= 0 && slot < G.slots.length)) return null;
      if (!(rarity >= 0 && rarity < G.rarities.length)) return null;
      if (!(ilvl >= 1 && ilvl <= 9999)) return null;
      if (!Array.isArray(flat) || flat.length % 2 !== 0) return null;
      const affixes = [];
      const seen = {};
      for (let i = 0; i < flat.length; i += 2) {
        const ai = flat[i] | 0, v = Number(flat[i + 1]);
        if (!(ai >= 0 && ai < G.affixes.length)) return null;
        if (!isFinite(v) || v <= 0 || v > 9999) return null;
        if (seen[ai]) return null;                       // 同一词条不许重复
        seen[ai] = 1;
        affixes.push([ai, v]);
      }
      if (!affixes.length) return null;
      return { slot: slot, rarity: rar, ilvl: ilvl, plus: 0, affixes: affixes };
    }

    return {
      rollItem: rollItem, score: score, salvageValue: salvageValue,
      recompute: recompute, offer: offer, dropFor: dropFor, gift: gift,
      addStones: addStones, stoneTotal: stoneTotal, strengthen: strengthen,
      effValue: effValue, pack: pack, unpack: unpack,
      text: function (item) {
        if (!item || !item.affixes) return '';
        return item.affixes.map(function (p) { return G.affixes[p[0]].fmt(effValue(item, p)); }).join(' · ');
      }
    };
  })();
  Svc.set('equip', equip);

  /* =========================================================
     8. combat 服务 —— 伤害、成长、关卡推进
     ========================================================= */
  const combat = (function () {
    /* ---------- 关卡结构 ---------- */
    function roleForMob(mobIndex) {
      if (mobIndex <= TUNE.stage.normalCount) return 'normal';
      if (mobIndex < TUNE.stage.enemiesPerStage) return 'elite';
      return 'boss';
    }

    /** 解锁第 stage 关所需等级。第 1 关是新手关，恒为 1 */
    function unlockLevel(stage) {
      if (stage <= 1) return 1;
      return Math.max(1, Math.round(TUNE.stage.unlockBase + TUNE.stage.unlockStep * (stage - 1)));
    }

    /**
     * 门槛判定：返回缺口。
     * 普通怪要「上一关的稀有」，精英与首领要「上一关的传说」，首领再加 +10。
     * 注意 role 与 kind 是两回事：kind 仍是 melee/ranged（战斗用），role 是普通/精英/首领。
     */
    function gateFor(stage, role) {
      if (stage <= 1) return { ok: true, noGate: true };
      const needRarity = role === 'normal' ? 1 : 2;
      const needIlvl = stage - 1;
      const needPlus = role === 'boss' ? TUNE.reinforce.maxPlus : 0;
      let worst = -1;
      for (let i = 0; i < 4; i++) {
        const it = state.equipped[i];
        const ok = !!it && it.rarity >= needRarity && it.ilvl >= needIlvl &&
                   (it.plus || 0) >= needPlus;
        if (!ok) { worst = i; break; }
      }
      return {
        ok: worst < 0, worstSlot: worst,
        needRarity: needRarity, needIlvl: needIlvl, needPlus: needPlus
      };
    }

    function stageEnemy(stage, mobIndex) {
      const pool = TUNE.stagePool;
      const key = pool[(stage - 1) % pool.length];
      const base = TUNE.enemies[key];
      const tier = Math.floor((stage - 1) / pool.length);
      const mul = Math.pow(TUNE.stage.tierMul, tier);

      const role = roleForMob(mobIndex);
      const km = TUNE.stage.kind[role];

      return {
        key: key,
        sprite: key,
        skin: null,
        variant: null,
        role: role,
        roleLabel: km.label,
        name: (role === 'normal' ? '' : km.label) + base.name,
        kind: base.kind,                       // melee / ranged，战斗逻辑用这个
        hp: Math.max(1, Math.round(
          TUNE.stage.hp.base * Math.pow(stage, TUNE.stage.hp.pow) *
          (TUNE.stage.typeHp[key] || 1) * km.hpMul
        )),
        atk: Math.round(
          TUNE.stage.atk.base * Math.pow(stage, TUNE.stage.atk.pow) *
          (TUNE.stage.typeAtk[key] || 1) * km.atkMul * 10
        ) / 10,
        xp: Math.round(base.xp * mul * km.xpMul),
        gold: Math.round(base.gold * mul * km.goldMul),
        scale: base.scale
      };
    }

    /* 门槛不满足时退回本关第 1 只继续刷；第 1 只永远允许战斗，保证不会彻底卡死 */
    let spawnQueued = false;
    function queueSpawn(delay) {
      if (spawnQueued) return;
      spawnQueued = true;
      setTimeout(function () {
        spawnQueued = false;
        ensureSpawn();
      }, delay == null ? 260 : delay);
    }

    function ensureSpawn() {
      const role = roleForMob(state.mobIndex);
      const gate = gateFor(state.stage, role);

      if (!gate.ok && state.stage > 1) {
        /*
         * 打不过当前这只 → 直接退回上一关。
         *
         * 为什么不是「退回本关第 1 只」：本关的传说装备只能从上一关的首领掉，
         * 留在本关只会无限刷普通怪、永远凑不齐 4 件传说。退回上一关才能刷首领。
         * 上一关首领打完且等级够，自然又会回到本关 —— 一个自洽的推进环。
         */
        const from = state.stage;
        state.stage--;
        state.mobIndex = 1;
        state.enemy = null;
        bus.emit('stage:fallback', { from: from, to: state.stage, role: role, gate: gate });
        return ensureSpawn();
      }

      spawnEnemy();
    }

    function spawnEnemy() {
      const def = stageEnemy(state.stage, state.mobIndex);
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

      // 不再立刻扣血：伤害打包进飞剑，命中时才结算（见 resolveProjectile）
      const PJ = TUNE.hero.projectile;
      const fromX = TUNE.view.heroX + PJ.fromDX;
      const fromY = TUNE.view.groundY + PJ.fromDY;
      const to = Svc.get('render').enemyCenter(e);

      state.projectiles.push({
        sx: fromX, sy: fromY,     // 出手点
        tx: to.x, ty: to.y,       // 目标点（发射瞬间锁定）
        x: fromX, y: fromY,
        t: 0, dur: PJ.dur,
        dmg: dmg, crit: crit
      });

      state.heroSwing = 0.22;     // 御剑出手的起手动作
      bus.emit('hero:throw', { x: fromX, y: fromY, crit: crit });
    }

    /** 飞剑命中：结算伤害、触发反馈，必要时击杀 */
    function resolveProjectile(p) {
      const e = state.enemy;
      // 目标已消失（被前一把剑打死且新怪还没进场）——这一剑落空，不补偿
      if (!e) return;

      e.hp -= p.dmg;
      bus.emit('hero:swing', { enemy: e, damage: p.dmg, crit: p.crit, hp: e.hp });
      if (e.hp <= 0) {
        e.hp = 0;
        kill(e);
      }
    }

    /** 推进在飞的飞剑；到点即结算 */
    function tickProjectiles(dt) {
      const list = state.projectiles;
      if (!list.length) return;
      for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i];
        p.t += dt;
        const u = p.dur > 0 ? p.t / p.dur : 1;
        const q = projPos(p, u);
        p.x = q.x;
        p.y = q.y;
        if (u >= 1) {
          resolveProjectile(p);
          list.splice(i, 1);
        }
      }
    }

    function kill(e) {
      const def = e.def;
      state.kills++;
      state.gold += def.gold;
      bus.emit('enemy:killed', { enemy: e, gold: def.gold, xp: def.xp });
      gainXp(def.xp);

      // 固定掉落：普通→普通，精英→稀有，首领→传说（都是当前关卡等级）
      // 强化石：普通 1 颗、精英 2 颗、首领 3 颗（等级 = 当前关卡）
      Svc.get('equip').dropFor(def.role, state.stage);
      Svc.get('equip').addStones(state.stage, def.role === 'boss' ? 3 : def.role === 'elite' ? 2 : 1);

      state.enemy = null;

      const isBoss = def.role === 'boss';
      if (isBoss) {
        // 打完首领：等级够了就进下一关，不够就留在本关重刷
        const nextLevel = unlockLevel(state.stage + 1);
        if (state.hero.level >= nextLevel) {
          state.stage++;
          state.mobIndex = 1;
          state.maxStage = Math.max(state.maxStage, state.stage);
          bus.emit('stage:change', { stage: state.stage });
        } else {
          state.mobIndex = 1;
          bus.emit('stage:locked', { stage: state.stage, need: nextLevel, level: state.hero.level });
        }
      } else {
        state.mobIndex++;
      }

      queueSpawn(260);
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

    /** 切换关卡（只能去已解锁的） */
    function goToStage(n) {
      const target = Math.floor(n);
      if (!(target >= 1 && target <= state.maxStage)) return false;
      if (target === state.stage && state.mobIndex === 1) return false;
      state.stage = target;
      state.mobIndex = 1;
      state.enemy = null;
      spawnQueued = false;
      ensureSpawn();
      bus.emit('stage:change', { stage: target });
      return true;
    }

    return {
      stageEnemy: stageEnemy,
      roleForMob: roleForMob,
      unlockLevel: unlockLevel,
      gateFor: gateFor,
      goToStage: goToStage,
      ensureSpawn: ensureSpawn,
      spawnEnemy: spawnEnemy,
      heroAttack: heroAttack,
      tickProjectiles: tickProjectiles,
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

      // 无版本号的历史存档：按 v1 处理（这里必须写 1，不能写 SAVE_VERSION，
      // 否则会跳过后续所有迁移步骤）
      if (d.v === undefined && typeof d.level === 'number') {
        d = Object.assign({}, d, { v: 1 });
      }

      const v = Number(d.v);
      if (!isFinite(v) || v < 1) return null;

      // 未来版本（玩家降级了应用）：不接受，避免误读
      if (v > SAVE_VERSION) return null;

      if (v === 1) d = migrateV1toV2(d);
      if (Number(d.v) === 2) d = migrateV2toV3(d);

      return sanitize(d);
    }

    /* ——— v2 -> v3：关卡进度 + 强化石 + 强化等级 ———
       老存档的装备 plus 补 0，进度按当前关卡继续。 */
    function migrateV2toV3(d) {
      const out = Object.assign({}, d);
      out.v = 3;
      out.stones = {};
      out.mobIndex = 1;
      out.maxStage = Math.max(1, Number(d.stage) || 1);
      return out;
    }

    /* ——— v1 -> v2：新增装备 ———
       老玩家升级后空手继续，进度一点不丢。 */
    function migrateV1toV2(d) {
      const out = Object.assign({}, d);
      out.v = 2;
      if (!Array.isArray(out.equipped)) out.equipped = [0, 0, 0, 0];
      return out;
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
        equipped: [0, 0, 0, 0],
        stones: {},
        mobIndex: Math.floor(clampNum(d.mobIndex, [1, TUNE.stage.enemiesPerStage], 1)),
        maxStage: Math.floor(clampNum(d.maxStage, LIMIT.stage, 1)),
        time: clampNum(d.time, [0, 4e12], Date.now())
      };
      // 强化石：键必须是正整数等级，值必须非负整数，上限防篡改
      const stSrc = (d.stones && typeof d.stones === 'object') ? d.stones : {};
      for (const k in stSrc) {
        const lv = Math.floor(Number(k));
        const n = Math.floor(Number(stSrc[k]));
        if (!(lv >= 1 && lv <= 9999)) continue;
        if (!isFinite(n) || n <= 0) continue;
        out.stones[String(lv)] = Math.min(99999, n);
      }
      // 装备：非法条目整件丢弃，绝不让半个坏数据进槽位
      const eqSrc = Array.isArray(d.equipped) ? d.equipped : [];
      for (let i = 0; i < 4; i++) {
        out.equipped[i] = Svc.get('equip').unpack(eqSrc[i]) ? eqSrc[i] : 0;
      }
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
        equipped: state.equipped.map(Svc.get('equip').pack),
        stones: state.stones,
        mobIndex: state.mobIndex,
        maxStage: state.maxStage,
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
      // 先重建装备并重算加成，maxHp 才是正确的，再钳血量
      const eq = Svc.get('equip');
      state.equipped = [0, 1, 2, 3].map(function (i) {
        const raw = Array.isArray(d.equipped) ? d.equipped[i] : null;
        return eq.unpack(raw);
      });
      eq.recompute();
      state.stones = Object.assign({}, d.stones || {});
      state.mobIndex = d.mobIndex || 1;
      state.maxStage = Math.max(state.maxStage || 1, d.maxStage || state.stage, state.stage);
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

    function fit() {
      const wrap = document.getElementById('stage-wrap');
      const cw = wrap.clientWidth, ch = wrap.clientHeight;
      if (!cw || !ch) return;
      const s = Math.min(cw / V.w, ch / V.h);
      canvas.style.width = Math.floor(V.w * s) + 'px';
      canvas.style.height = Math.floor(V.h * s) + 'px';
    }

    function drawSprite(name, x, y, scale, flip, skin, damageStage) {
      const sp = buildSprite(name, skin);
      ctx.save();
      ctx.translate(Math.round(x), Math.round(y));
      if (flip) ctx.scale(-1, 1);
      ctx.scale(scale, scale);

      // 变体轮廓光画在主体之后、下面（镜像时同一套变换）
      if (sp.outline) {
        ctx.globalAlpha = 0.85;
        ctx.drawImage(sp.outline, flip ? -sp.w : 0, 0);
        ctx.globalAlpha = 1;
      }
      ctx.drawImage(sp.canvas, flip ? -sp.w : 0, 0);

      // 损伤贴花：按血量档位取一张预先算好的硬边图层
      if (sp.damage && damageStage > 0) {
        ctx.drawImage(sp.damage[Math.min(sp.damage.length, damageStage) - 1],
                      flip ? -sp.w : 0, 0);
      }
      ctx.restore();
    }

    /* ---------- 关卡背景：按怪物种类选主题，按关卡号做差异 ---------- */
    let bgStage = -1, bgCanvas = null;

    function mkRng(seed) {
      let x = (seed >>> 0) || 1;
      return () => {
        x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
        return x / 4294967296;
      };
    }

    /** 本关主题：由 stagePool 推出怪物种类，再查主题表 */
    function themeFor(stage) {
      const pool = TUNE.stagePool;
      const key = pool[((stage - 1) % pool.length + pool.length) % pool.length];
      return TUNE.themes[key] || TUNE.themes.slime;
    }

    function drawHills(c, count, baseY, amp, phase, color) {
      c.fillStyle = color;
      c.beginPath();
      c.moveTo(0, V.h);
      for (let i = 0; i <= count * 2; i++) {
        const x = (i * V.w) / (count * 2);
        const y = baseY - Math.abs(Math.sin(i * 1.7 + phase)) * amp;
        c.lineTo(x, y);
      }
      c.lineTo(V.w, V.h);
      c.closePath();
      c.fill();
    }

    /* 静态部分烘焙成一张图，只在换关时重建 */
    function buildBackdrop(stage, th) {
      const R = mkRng(stage * 2654435761);
      const cv = document.createElement('canvas');
      cv.width = V.w; cv.height = V.h;
      const c = cv.getContext('2d');
      c.imageSmoothingEnabled = false;

      // 天空
      const sky = c.createLinearGradient(0, 0, 0, V.h);
      sky.addColorStop(0, th.sky[0]);
      sky.addColorStop(0.55, th.sky[1]);
      sky.addColorStop(1, th.sky[2]);
      c.fillStyle = sky;
      c.fillRect(0, 0, V.w, V.h);

      // 星星（位置按关卡种子，数量按主题）
      for (let i = 0; i < th.stars; i++) {
        const x = Math.floor(R() * V.w), y = Math.floor(R() * 96);
        const a = 0.25 + R() * 0.5;
        c.fillStyle = 'rgba(210,225,255,' + a.toFixed(3) + ')';
        c.fillRect(x, y, R() < 0.75 ? 1 : 2, 1);
      }

      // 月亮（墓园才有）
      if (th.moon) {
        const mx = 60 + Math.floor(R() * 200), my = 26 + Math.floor(R() * 22);
        c.fillStyle = 'rgba(240,244,255,.14)';
        c.beginPath(); c.arc(mx, my, 16, 0, Math.PI * 2); c.fill();
        c.fillStyle = 'rgba(240,244,255,.82)';
        c.beginPath(); c.arc(mx, my, 12, 0, Math.PI * 2); c.fill();
        c.fillStyle = th.sky[1];
        c.beginPath(); c.arc(mx + 6, my - 4, 10, 0, Math.PI * 2); c.fill();
      }

      // 洞窟：岩顶（必须用比天空亮的颜色，否则和背景糊在一起看不出形状）
      if (th.deco === 'cave') {
        c.fillStyle = th.ceil || '#2b2342';
        c.beginPath();
        c.moveTo(0, 0); c.lineTo(V.w, 0); c.lineTo(V.w, 22);
        for (let x = V.w; x >= 0; x -= 18) c.lineTo(x, 18 + R() * 16);
        c.closePath(); c.fill();
        // 钟乳石
        for (let i = 0; i < 10; i++) {
          const x = R() * V.w, len = 8 + R() * 26, hw = 2 + R() * 4;
          c.beginPath();
          c.moveTo(x - hw, 30); c.lineTo(x, 30 + len); c.lineTo(x + hw, 30);
          c.closePath(); c.fill();
        }
      }

      // 远景装饰（树 / 岩脊）
      if (th.deco === 'spores') {
        for (let i = 0; i < 7 + Math.floor(R() * 4); i++) {
          const x = Math.floor(R() * V.w), base = 104 + R() * 12;
          const hgt = 26 + R() * 44;
          c.fillStyle = th.far;
          c.beginPath();
          c.moveTo(x, base - hgt);
          c.lineTo(x - 9 - R() * 6, base);
          c.lineTo(x + 9 + R() * 6, base);
          c.closePath(); c.fill();
          c.fillRect(x - 1, base - 3, 2, 7);
        }
      } else if (th.deco === 'ember') {
        c.fillStyle = th.far;
        c.beginPath();
        c.moveTo(0, 118);
        for (let x = 0; x <= V.w; x += 12) c.lineTo(x, 96 + R() * 26);
        c.lineTo(V.w, 118); c.closePath(); c.fill();
      } else if (th.deco === 'graves') {
        // 远方枯树
        for (let i = 0; i < 3; i++) {
          const x = 20 + R() * (V.w - 40);
          c.strokeStyle = th.far; c.lineWidth = 2;
          c.beginPath(); c.moveTo(x, 112); c.lineTo(x + (R() - 0.5) * 8, 112 - 30 - R() * 18); c.stroke();
          c.beginPath(); c.moveTo(x, 98); c.lineTo(x - 8, 88); c.stroke();
          c.beginPath(); c.moveTo(x, 104); c.lineTo(x + 9, 92); c.stroke();
        }
      }

      // 远山 / 近山：颜色按关卡种子做明度抖动，保证同主题的不同关也看得出区别
      const shade = (hex, k) => {
        const n = parseInt(hex.slice(1), 16);
        const r = Math.min(255, Math.round(((n >> 16) & 255) * k));
        const g2 = Math.min(255, Math.round(((n >> 8) & 255) * k));
        const b = Math.min(255, Math.round((n & 255) * k));
        return 'rgb(' + r + ',' + g2 + ',' + b + ')';
      };
      drawHills(c, 5 + Math.floor(R() * 3), 104 + R() * 10, 26 + R() * 14, R() * 6.3,
                shade(th.far, 0.8 + R() * 0.45));
      drawHills(c, 7 + Math.floor(R() * 4), 114 + R() * 10, 16 + R() * 14, R() * 6.3,
                shade(th.near, 0.8 + R() * 0.45));

      // 地面
      const gr = c.createLinearGradient(0, V.groundY, 0, V.h);
      gr.addColorStop(0, th.ground[0]);
      gr.addColorStop(1, th.ground[1]);
      c.fillStyle = gr;
      c.fillRect(0, V.groundY, V.w, V.h - V.groundY);

      // 地面装饰
      if (th.deco === 'spores') {
        // 水洼
        for (let i = 0; i < 5; i++) {
          const x = R() * V.w, y = V.groundY + 8 + R() * 34, rx = 6 + R() * 14;
          c.fillStyle = 'rgba(127,224,127,.10)';
          c.beginPath(); c.ellipse(x, y, rx, rx * 0.35, 0, 0, Math.PI * 2); c.fill();
        }
      } else if (th.deco === 'graves') {
        // 墓碑
        for (let i = 0; i < 4 + Math.floor(R() * 3); i++) {
          const x = 14 + R() * (V.w - 28), y = V.groundY + 2 + R() * 20;
          const w = 7 + Math.floor(R() * 5), hh = 12 + Math.floor(R() * 10);
          c.fillStyle = '#3a4150';
          c.fillRect(x, y - hh, w, hh);
          c.beginPath(); c.arc(x + w / 2, y - hh, w / 2, Math.PI, 0); c.fill();
          c.fillStyle = 'rgba(0,0,0,.25)';
          c.fillRect(x + 2, y - hh + 3, w - 4, 1);
        }
      } else if (th.deco === 'cave') {
        // 石笋
        for (let i = 0; i < 5 + Math.floor(R() * 3); i++) {
          const x = 12 + R() * (V.w - 24), hh = 6 + R() * 16, hw = 2 + R() * 3;
          c.fillStyle = '#221b36';
          c.beginPath();
          c.moveTo(x - hw, V.groundY + 6); c.lineTo(x, V.groundY + 6 - hh); c.lineTo(x + hw, V.groundY + 6);
          c.closePath(); c.fill();
        }
        // 水晶
        for (let i = 0; i < 3; i++) {
          const x = 30 + R() * (V.w - 60), y = V.groundY + 10 + R() * 26;
          c.fillStyle = th.accent; c.globalAlpha = 0.35;
          c.fillRect(Math.round(x), Math.round(y), 2, 5);
          c.globalAlpha = 1;
        }
      } else if (th.deco === 'ember') {
        // 地面裂缝，靠动态层发红光
        c.strokeStyle = 'rgba(255,138,60,.25)';
        c.lineWidth = 1;
        for (let i = 0; i < 7; i++) {
          const x = R() * V.w, y = V.groundY + 4 + R() * 36;
          c.beginPath(); c.moveTo(x, y);
          c.lineTo(x + (R() - 0.5) * 26, y + (R() - 0.5) * 8); c.stroke();
        }
      }

      // 地面横向纹理
      c.fillStyle = 'rgba(255,255,255,.04)';
      for (let x = 0; x < V.w; x += 16) c.fillRect(x, V.groundY + 4, 8, 1);

      // 地平线
      c.fillStyle = th.accent;
      c.globalAlpha = 0.35;
      c.fillRect(0, V.groundY, V.w, 1);
      c.globalAlpha = 1;

      return cv;
    }

    /* 动态部分：每帧叠加，便宜（≤ 40 个点） */
    function animBackdrop(t, th, stage) {
      const R = mkRng(stage * 97 + 13);
      const acc = th.accent;

      if (th.deco === 'spores') {
        // 孢子缓缓上浮
        for (let i = 0; i < 22; i++) {
          const bx = R() * V.w, sp = 4 + R() * 10, ph = R() * 6.28;
          const y = V.groundY + 20 - ((t * sp + i * 37) % 110);
          if (y < 20) continue;
          const x = bx + Math.sin(t * 0.8 + ph) * 6;
          ctx.globalAlpha = 0.28 + 0.3 * (0.5 + 0.5 * Math.sin(t * 2 + ph));
          ctx.fillStyle = acc;
          ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
        }
        ctx.globalAlpha = 1;
      } else if (th.deco === 'ember') {
        // 火星上升 + 熔岩脉动
        const pulse = 0.5 + 0.5 * Math.sin(t * 1.6);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const g = ctx.createLinearGradient(0, V.groundY, 0, V.h);
        g.addColorStop(0, 'rgba(255,120,40,' + (0.05 + 0.05 * pulse).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(255,60,20,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, V.groundY, V.w, V.h - V.groundY);
        ctx.restore();

        for (let i = 0; i < 26; i++) {
          const bx = R() * V.w, sp = 10 + R() * 22, ph = R() * 6.28;
          const y = V.groundY + 30 - ((t * sp + i * 43) % 120);
          if (y < 24) continue;
          const x = bx + Math.sin(t * 1.3 + ph) * 5;
          ctx.globalAlpha = (0.3 + 0.5 * (0.5 + 0.5 * Math.sin(t * 3 + ph))) * Math.min(1, (y - 24) / 60);
          ctx.fillStyle = i % 3 === 0 ? '#ffe08a' : acc;
          ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
        }
        ctx.globalAlpha = 1;
      } else if (th.deco === 'graves') {
        // 低空雾带缓慢平移
        ctx.save();
        ctx.globalAlpha = 0.06;
        ctx.fillStyle = acc;
        for (let i = 0; i < 3; i++) {
          const off = (t * (6 + i * 3)) % (V.w + 80);
          ctx.fillRect(-80 + off, V.groundY - 6 + i * 5, 70, 2);
        }
        ctx.restore();
      } else if (th.deco === 'cave') {
        // 水晶脉动 + 偶发滴水
        const p = 0.5 + 0.5 * Math.sin(t * 1.1);
        ctx.globalAlpha = 0.10 + 0.10 * p;
        ctx.fillStyle = acc;
        for (let i = 0; i < 3; i++) ctx.fillRect(30 + i * 90, 30, 2, 26);
        ctx.globalAlpha = 1;
      }

      // 星星闪烁（天空主题都有）
      if (th.stars > 0) {
        const R2 = mkRng(7);
        for (let i = 0; i < Math.min(th.stars, 20); i++) {
          const x = Math.floor(R2() * V.w), y = Math.floor(R2() * 96);
          const a = 0.3 + 0.45 * (0.5 + 0.5 * Math.sin(t * 1.4 + i));
          ctx.fillStyle = 'rgba(210,225,255,' + a.toFixed(3) + ')';
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }

    function background(t) {
      const stage = state.stage;
      const th = themeFor(stage);
      if (stage !== bgStage || !bgCanvas) {
        bgCanvas = buildBackdrop(stage, th);
        bgStage = stage;
      }
      ctx.drawImage(bgCanvas, 0, 0);
      animBackdrop(t, th, stage);
    }

    function shadow(x, y, rx) {
      ctx.fillStyle = PAL.shadow;
      ctx.beginPath();
      ctx.ellipse(x, y, rx, 4, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    /* 贴地：精灵可见底边 = groundY + sink。
       foot 是尾部全空的行数（bat 这类底部留白的必须扣掉，否则浮空）。 */
    function spriteBox(name, scale, skin) {
      const sp = buildSprite(name, skin);
      const h = (sp.h - sp.foot) * scale;
      const w = sp.w * scale;
      return { sp: sp, w: w, h: h, top: V.groundY + 3 - h };
    }

    /** 主角身体中心，供特效锚点使用 */
    function heroCenter() {
      const b = spriteBox('hero', V.heroPx);
      return { x: V.heroX + b.w / 2, y: b.top + b.h / 2 };
    }

    function hero(t) {
      const b = spriteBox('hero', V.heroPx);
      const bob = Math.sin(t * 3) * 1.2;
      // 御剑出手：轻微的「递剑」前倾，不再是挥砍
      const lean = state.heroSwing > 0
        ? Math.sin((state.heroSwing / 0.22) * Math.PI) * 6
        : 0;

      shadow(V.heroX + b.w / 2, V.groundY + 2, b.w * 0.62);
      drawSprite('hero', V.heroX + lean, b.top + 1 + bob, V.heroPx, false);
    }

    /** 飞剑 + 剑气拖尾。位置 p.x/p.y 是剑身中心，不是左上角 */
    function projectiles() {
      if (!state.projectiles.length) return;
      const PJ = TUNE.hero.projectile;
      const sp = buildSprite('sword');
      const offX = (sp.w * V.swordPx) / 2;
      const offY = (sp.h * V.swordPx) / 2;

      for (const p of state.projectiles) {
        const left = p.x - offX;

        // 剑气拖尾：一条向后渐隐的细带。
        // 不复制整把剑 —— 那样会看到一串分离的灰块，像虚线而不是速度感。
        const gx = ctx.createLinearGradient(left - PJ.trail, 0, left + 2, 0);
        gx.addColorStop(0, 'rgba(127,184,240,0)');
        gx.addColorStop(0.7, 'rgba(159,208,255,.28)');
        gx.addColorStop(1, 'rgba(223,243,255,.6)');
        ctx.fillStyle = gx;
        ctx.fillRect(left - PJ.trail, p.y - 1, PJ.trail + 2, 2);

        drawSprite('sword', left, p.y - offY, V.swordPx, false);

        // 剑尖冷光（精灵右端）
        const tipX = left + sp.w * V.swordPx, tipY = p.y;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const g = ctx.createRadialGradient(tipX, tipY, 0, tipX, tipY, 7);
        g.addColorStop(0, 'rgba(200,235,255,.42)');
        g.addColorStop(1, 'rgba(120,180,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(tipX - 7, tipY - 7, 14, 14);
        ctx.restore();
      }
    }

    function enemy(t) {
      const e = state.enemy;
      if (!e) return;

      const bounce = Math.sin(t * 4 + 1) * 1.5;
      const lunge = state.enemyLunge > 0
        ? Math.cos((state.enemyLunge / 0.22) * Math.PI) * 12
        : 0;
      const spriteName0 = e.def.sprite || e.def.key;
      const sc = V.enemyPx * (e.def.scale || 1);
      const box = spriteBox(spriteName0, sc, e.def.skin);
      const y = box.top + bounce;
      const xOff = (spriteName0 === 'slime' ? 0 : 2);

      shadow(e.x + box.w / 2 - xOff, V.groundY + 2, box.w * 0.65);

      // 预警：红色脉动光环
      if (e.phase === 'windup') {
        const pulse = 0.5 + 0.5 * Math.sin(t * TUNE.feel.telegraphPulse);
        ctx.save();
        ctx.globalAlpha = 0.25 + 0.45 * e.flash * pulse;
        ctx.strokeStyle = '#ff5a40';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(e.x + box.w / 2 - xOff, V.groundY - 10, box.w * 0.82 + pulse * 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // 受击/预警染色：叠加一层红色剪影
      // ② 损伤档位：血量越低越破碎，硬边阶跃，不做线性淡入
      const hpRatio = e.hp / e.maxHp;
      const dmgStage = hpRatio <= 0.25 ? 3 : hpRatio <= 0.5 ? 2 : hpRatio <= 0.75 ? 1 : 0;

      drawSprite(spriteName0, e.x + lunge - xOff, y, sc, true, e.def.skin, dmgStage);

      if (e.flash > 0.02) {
        ctx.save();
        ctx.globalAlpha = e.flash * 0.55;
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = '#ff5a40';
        ctx.fillRect(e.x - 4, y - 4, box.w + 20, box.h + 12);
        ctx.restore();
      }

      // 血条：贴在敌人头顶上方。
      // 原来写死 groundY-52，比 12 行高的精灵顶边还高 43px，视觉上完全脱节。
      const bw = Math.max(32, Math.round(box.w * 1.5)), bh = 3;
      const bx = e.x + box.w / 2 - xOff - bw / 2, by = y - 8;
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
      projectiles();
      Svc.get('fx').drawWorld(ctx);
      Svc.get('film').draw(ctx);
      overlay();

      ctx.restore();
    }

    /**
     * 敌人身体中心的屏幕坐标 —— 命中特效的锚点。
     *
     * 为什么要有这个函数：特效是一团静态爆发的光，锚点必须落在身体上，
     * 否则会浮在头顶（实测用 groundY-30 时与骨架纵向重合度为 0%）。
     * 位置公式必须和 enemy() 里画精灵的那套保持一致，改 enemy() 时这里也要改。
     */
    /** 敌人身体中心。锚点必须跟着体型走，否则放大后飞剑会打在脚下 */
    function enemyCenter(target) {
      const e = target || state.enemy;
      if (!e) return { x: V.enemyX + 16, y: V.groundY - 34 };
      const name = e.def.sprite || e.def.key;
      const sc = V.enemyPx * (e.def.scale || 1);
      const box = spriteBox(name, sc, e.def.skin);
      const xOff = (name === 'slime' ? 0 : 2);
      return { x: e.x + box.w / 2 - xOff, y: box.top + box.h / 2 };
    }

    return { draw: draw, fit: fit, canvas: canvas, ctx: ctx, drawSprite: drawSprite,
             enemyCenter: enemyCenter, heroCenter: heroCenter,
             projectiles: projectiles, spriteBox: spriteBox };
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

      // 关卡内进度 + 门槛提示
      const role = Svc.get('combat').roleForMob(state.mobIndex);
      const kindLabel = TUNE.stage.kind[role].label;
      setText('hudMob', kindLabel + ' ' + state.mobIndex + '/' + TUNE.stage.enemiesPerStage);

      const gate = Svc.get('combat').gateFor(state.stage, role);
      const gateEl = el('hudGate');
      if (gateEl) {
        if (gate.ok) {
          gateEl.style.display = 'none';
        } else {
          gateEl.style.display = '';
          gateEl.textContent = '门槛：' + gateText(gate);
        }
      }

      if (currentTab === 'skill') refreshSkillButtons();
      if (currentTab === 'gear') setText('stoneTxt', stoneText());
    }

    /** 强化石库存的可读文本 */
    function stoneText() {
      const lvls = Object.keys(state.stones).map(Number).sort(function (a, b) { return a - b; });
      return lvls.length
        ? lvls.map(function (l) { return l + '级×' + state.stones[String(l)]; }).join('  ')
        : '暂无';
    }

    /** 门槛缺口的可读描述 */
    function gateText(gate) {
      const rar = TUNE.gear.rarities[gate.needRarity];
      let t = rar.name + '(第 ' + gate.needIlvl + ' 关)';
      if (gate.needPlus > 0) t += ' +' + gate.needPlus;
      return t;
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
        const G = TUNE.gear;
        const eq = Svc.get('equip');
        const R = TUNE.reinforce;
        let html = '';

        G.slots.forEach(function (slot, i) {
          const it = state.equipped[i];
          if (!it) {
            html += '<div class="row">' +
              '<div class="icon">' + slot.icon + '</div>' +
              '<div class="info"><div class="nm">' + slot.name + '</div>' +
              '<div class="sub">未装备</div></div></div>';
            return;
          }
          const rar = G.rarities[it.rarity];
          const plus = it.plus || 0;
          const canUp = plus < R.maxPlus;
          html += '<div class="row">' +
            '<div class="icon">' + slot.icon + '</div>' +
            '<div class="info">' +
              '<div class="nm">' + slot.name +
                ' <span style="color:' + rar.color + ';font-size:11px">' + rar.name + '</span>' +
                ' <span style="color:var(--muted);font-size:10px">ilvl ' + it.ilvl + '</span>' +
                (plus > 0 ? ' <span style="color:var(--gold);font-size:11px">+' + plus + '</span>' : '') +
              '</div>' +
              '<div class="sub">' + eq.text(it) + '</div>' +
            '</div>' +
            '<button class="btn' + (canUp ? '' : ' ghost') + '" data-up="' + i + '"' +
              (canUp ? '' : ' disabled') + '>' +
              (canUp ? '强化 ' + R.costPerLevel + '石' : '满级') +
            '</button></div>';
        });

        const total = state.gearBonus;
        html += '<div class="row" style="border-top:1px solid var(--line);margin-top:6px;padding-top:8px">' +
          '<div class="info"><div class="sub" style="line-height:1.7">' +
            '装备合计：攻击 +' + total.atk.toFixed(0) +
            ' · 生命 +' + total.hp.toFixed(0) +
            ' · 攻速 +' + (total.speed * 100).toFixed(1) + '%' +
            ' · 暴击 +' + (total.crit * 100).toFixed(1) + '%' +
            ' · 回复 +' + total.regen.toFixed(1) +
          '</div></div></div>';

        // 强化石库存（文本在 tick 里实时刷新，避免每次掉落都重排整个列表）
        html += '<div class="row"><div class="icon">💎</div><div class="info">' +
          '<div class="nm">强化石</div>' +
          '<div class="sub" id="stoneTxt">' + stoneText() + '</div></div></div>';

        html += '<div style="color:var(--muted);font-size:11px;text-align:center;padding:8px 0 0;line-height:1.6">' +
          '普通怪掉普通 · 精英掉稀有 · 首领掉传说<br/>' +
          '强化消耗同等级或更高等级的石头</div>';

        body.innerHTML = html;

        // 绑定强化按钮
        const ups = document.querySelectorAll('#tabBody button[data-up]');
        ups.forEach(function (btn) {
          btn.onclick = function () {
            const r = Svc.get('equip').strengthen(Number(btn.dataset.up));
            if (r.ok) toast('强化成功 +' + r.plus);
            else if (r.reason === 'max') toast('已达上限 +' + TUNE.reinforce.maxPlus);
            else if (r.reason === 'stones') toast('强化石不足，需要 ' + (r.need || 0) + ' 颗');
            else toast('无法强化');
            renderTab('gear');
          };
        });
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
          '<div class="row"><div class="icon">🗺️</div><div class="info">' +
          '<div class="nm">关卡选择</div>' +
          '<div class="sub">已解锁 ' + state.maxStage + ' 关 · 当前第 ' + state.stage + ' 关</div></div></div>' +
          '<div id="stageList" style="display:flex;flex-wrap:wrap;gap:6px;padding:4px 6px 10px"></div>' +
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
        const list = el('stageList');
        if (list) {
          for (let n = 1; n <= state.maxStage; n++) {
            const b = document.createElement('button');
            b.className = 'btn small' + (n === state.stage ? ' primary' : '');
            b.textContent = '第 ' + n + ' 关';
            b.onclick = function () {
              if (Svc.get('combat').goToStage(n)) {
                toast('已切换到第 ' + n + ' 关');
                renderTab('setting');
              }
            };
            list.appendChild(b);
          }
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

    // 御剑出手：手边一闪，给「剑从这里飞出去」一个起点
    bus.on('hero:throw', (p) => {
      fx.flash(p.x, p.y, 14, p.crit ? 'rgb(255,214,110)' : 'rgb(190,230,255)', 0.12);
      fx.hit(p.x, p.y, p.crit ? '#ffcc4d' : '#dff3ff', 3);
    });

    bus.on('hero:swing', (p) => {
      const e = p.enemy;
      const crit = p.crit;
      // pixelfx 的命中特效，锚在敌人身体中心（见 render.enemyCenter）
      const c = Svc.get('render').enemyCenter(e);
      Svc.get('film').hit(c.x, c.y, crit);
      fx.hit(c.x, c.y, crit ? '#ffcc4d' : '#ffffff', crit ? 10 : 5);
      fx.float(c.x, c.y - 10, (crit ? '暴击 ' : '') + p.damage, crit ? PAL.gold : '#ffffff');
      fx.flash(c.x, c.y - 4, 26, 'rgb(180,220,255)', 0.16);
      fx.shake(F.shakeHit);
      fx.hitStop(F.hitStopHit);
    });

    bus.on('enemy:killed', (p) => {
      // 锚点跟体型走（p.enemy 此刻还没被清空）
      const c = p.enemy ? Svc.get('render').enemyCenter(p.enemy)
                        : { x: V.enemyX + 16, y: V.groundY - 34 };
      fx.float(c.x - 4, c.y - 12, '+' + p.gold + '金', PAL.gold);
      fx.hit(c.x, c.y, '#8ee6a0', 12);
      fx.flash(c.x, c.y + 4, 44, 'rgb(140,255,180)', 0.26);
      fx.shake(F.shakeKill);
      fx.hitStop(F.hitStopKill);
    });

    bus.on('enemy:telegraph', (p) => {
      // 预警：扩散环 + 轻微光斑，玩家能预判“要挨打了”
      const c = p.enemy ? Svc.get('render').enemyCenter(p.enemy)
                        : { x: p.pos.x + 16, y: V.groundY - 20 };
      fx.ring(c.x, V.groundY - 10, 30, '#ff6b4a', p.time * 0.75);
      fx.ring(c.x, V.groundY - 10, 18, '#ffcc4d', p.time * 0.5);
      fx.flash(c.x, c.y, 22, 'rgb(255,90,60)', 0.12);
    });

    bus.on('hero:hurt', (p) => {
      state.hurtFlash = F.hurtFlash;
      const c = Svc.get('render').heroCenter();
      fx.float(c.x, c.y - 14, '-' + p.damage, '#ff6b6f');
      fx.hit(c.x, c.y + 4, '#ff6b6f', 6);
      fx.shake(F.shakeHit * 1.6);
    });

    bus.on('hero:levelup', (p) => {
      ui.toast('升级！Lv.' + p.level);
      const c = Svc.get('render').heroCenter();
      fx.float(c.x, c.y - 26, 'LEVEL UP', '#7dd3fc');
      fx.ring(c.x, V.groundY - 10, 44, '#7dd3fc', 0.6);
      fx.flash(c.x, c.y, 40, 'rgb(125,211,252)', 0.3);
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

    /* —— 装备：只发提示，不阻塞战斗 —— */
    function itemLabel(item) {
      const G = TUNE.gear;
      return G.rarities[item.rarity].name + G.slots[item.slot].name;
    }

    bus.on('item:drop', (p) => {
      // 普通怪每杀必掉，不再弹提示（否则一路刷屏）；精英/首领才提示
      if (p.role !== 'normal') {
        ui.toast(p.auto ? '获得 ' + itemLabel(p.item) + '（已装备）'
                        : '获得 ' + itemLabel(p.item) + '，折 +' + p.gold + ' 金');
      }
      if (ui.getTab() === 'gear') ui.renderTab('gear');
    });

    bus.on('item:equip', () => {
      if (ui.getTab() === 'gear') ui.renderTab('gear');
    });

    /* —— 关卡门槛：只提示一次，避免循环刷取时刷屏 —— */
    let gateToastAt = 0;
    bus.on('stage:gate', (p) => {
      if (!p.reset) return;                       // 第 1 只不提示
      const now = Date.now();
      if (now - gateToastAt < 8000) return;        // 8 秒内不重复
      gateToastAt = now;
      const gate = p.gate;
      const rar = TUNE.gear.rarities[gate.needRarity];
      ui.toast('门槛不足：' + TUNE.stage.kind[p.role].label +
               '需要 ' + rar.name + '(第 ' + gate.needIlvl + ' 关)' +
               (gate.needPlus > 0 ? ' +' + gate.needPlus : '') + '，已回第 1 只继续刷');
    });

    bus.on('stage:locked', (p) => {
      ui.toast('第 ' + (p.stage + 1) + ' 关需 Lv.' + p.need + '（当前 ' + p.level + '），继续刷本关');
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

    // 飞剑推进放在敌人判定之外：敌人死了，在飞的剑也要走完全程再落空
    Svc.get('combat').tickProjectiles(dt);

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
    Svc.get('film').update(dt);
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

    // 空手开局给一把普通武器，让装备页不是空的（老存档若已有装备则跳过）
    if (state.kills === 0 && !state.equipped.some(Boolean)) {
      Svc.get('equip').gift();
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
