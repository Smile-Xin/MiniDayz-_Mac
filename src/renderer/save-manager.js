'use strict';
/**
 * 启动器页存档读写（复用原 C2 工具 v5 的核心逻辑）。
 * 本页与游戏同源（app://game），可直接读写各版本的 IndexedDB，
 * 无需启动游戏窗口。
 * 库名规则：_C2SaveStates_<dbKey> / localforage_<dbKey>（隔离补丁加后缀后的全名）。
 */
(function () {
  const FORMAT_V = 6;

  function expectedDbNames(dbKey) {
    return ['_C2SaveStates_' + dbKey, 'localforage_' + dbKey];
  }

  // === 底层工具（同 v5） ===
  function serKey(k) {
    if (typeof k === 'number') return JSON.stringify({ t: 'n', v: k });
    if (k instanceof Date) return JSON.stringify({ t: 'd', v: k.getTime() });
    return JSON.stringify({ t: 's', v: String(k) });
  }
  function deserKey(s) {
    try { const o = JSON.parse(s); return o.t === 'n' ? Number(o.v) : o.t === 'd' ? new Date(o.v) : o.v; }
    catch (e) { return s; }
  }
  /**
   * 打开库。storeDefs 非空时按需创建 store（导入用）；
   * 无 storeDefs 时是「只读打开」，若库不存在则中止创建并报错——
   * 否则会把一个版本 1 的空库写进浏览器，之后游戏打开同名库时
   * onupgradeneeded 不再触发、store 建不出来，游戏存档直接失败。
   */
  function openDB(name, storeDefs) {
    return new Promise(function (res, rej) {
      const r = indexedDB.open(name);
      r.onupgradeneeded = function (e) {
        const db = e.target.result;
        if (storeDefs && storeDefs.length) {
          storeDefs.forEach(function (def) {
            if (db.objectStoreNames.contains(def.name)) return;
            // 按备份中的 _meta 还原 keyPath/autoIncrement，避免内联键 store 被建成外置键
            if (def.keyPath) db.createObjectStore(def.name, { keyPath: def.keyPath, autoIncrement: !!def.autoIncrement });
            else db.createObjectStore(def.name, { autoIncrement: !!def.autoIncrement });
          });
        } else {
          // 只读打开却触发了升级（= 库原本不存在，正在被创建）：回滚，避免留空库
          try { e.target.transaction.abort(); } catch (err) { /* abort 后 onerror 兜底 */ }
          rej(new Error('库不存在: ' + name));
        }
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error || new Error('打开库失败: ' + name)); };
      r.onblocked = function () { rej(new Error('库被占用(有窗口正在使用): ' + name)); };
    });
  }
  function readAll(db, sn) {
    return new Promise(function (res, rej) {
      const tx = db.transaction(sn, 'readonly');
      const out = {};
      tx.objectStore(sn).openCursor().onsuccess = function (e) {
        const c = e.target.result;
        if (c) { out[serKey(c.key)] = c.value; c.continue(); } else res(out);
      };
      tx.onerror = function () { rej(tx.error || new Error('读取 store 失败: ' + sn)); };
      tx.onabort = function () { rej(tx.error || new Error('读取 store 中止: ' + sn)); };
    });
  }
  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error || new Error('写入事务失败')); };
      tx.onabort = function () { reject(tx.error || new Error('写入事务中止')); };
    });
  }

  // === 发现该版本相关的库（白名单 + 枚举增强；无后缀遗留库仅兜底） ===
  const BARE_PREFIXES = ['_C2SaveStates', 'localforage']; // 无后缀库：注入失效/无隔离环境遗留（旧数据）
  // v0.6.32：per-prefix 独立兜底——此前只要任一带后缀库存在就整体排除无后缀库，
  // 导致「隔离补丁上线前创建的旧 C2 存档（无后缀 _C2SaveStates）」被漏导（用户实测：个别版本导出只有 localforage 设置、缺进度、文件异常小）。
  // 现在每个前缀独立判断：带后缀存在 → 用带后缀；带后缀缺失但无后缀存在 → 用无后缀兜底（绝不双份）。
  async function discoverDbs(dbKey, opts) {
    const suffix = '_' + dbKey;
    const prefixes = ['_C2SaveStates', 'localforage'];
    try {
      if (!indexedDB.databases) return expectedDbNames(dbKey);
      const all = await indexedDB.databases();
      const names = all.map(d => d.name).filter(Boolean);
      const out = [];
      for (const p of prefixes) {
        const full = p + suffix;
        if (names.indexOf(full) !== -1) { out.push(full); continue; }
        /* v1.0.14：无后缀遗留库（裸库）只在「历史裸库归属者」（directUrl 内置版：PC 版/多人版）
           且显式允许时才带上。否则会把裸库（所有版本共享）算成这个版本的存档 ——
           用户反馈「存档隔离不起作用/串档」的成因之一。 */
        if (opts && opts.allowBare && names.indexOf(p) !== -1) out.push(p);
      }
      return out;
    } catch (e) { return expectedDbNames(dbKey); }
  }

  // === 导出 ===
  function isMobileExport() {
    try {
      return window.matchMedia('(max-width:820px)').matches || window.matchMedia('(max-width:1000px) and (pointer:coarse)').matches;
    } catch (e) { return false; }
  }
  async function exportVersion(dbKey, opts) {
    const targets = await discoverDbs(dbKey, opts);
    const backup = {
      _c2: true,
      _fmt: 'mdz-portable',
      _v: FORMAT_V,
      _game: 'Mini DAYZ',
      _dbKey: dbKey,
      _srcPlatform: isMobileExport() ? 'mobile' : 'pc',
      _ts: Date.now(),
      _active: expectedDbNames(dbKey),
      dbs: {}
    };
    let total = 0;
    for (const dbName of targets) {
      let db;
      try { db = await openDB(dbName); } catch (e) { console.warn('[save] 跳过库:', dbName, e.message); continue; }
      try {
        const stores = Array.from(db.objectStoreNames);
        if (stores.length === 0) continue; // 空库（无 store）不导出
        /* v1.0.15：库存在但一个记录都没有时，**不再留下空对象条目**。
           旧实现先写 `backup.dbs[dbName] = {}`，若该库所有 store 都空就留下 `{}`；
           导入侧遇到空条目会走 openDB(name, [])（= 只读打开分支）→ 目标机没有这个库时报
           「库不存在」→ **整次导入中断**（前面的库已写入，用户只看到"导入失败"）。 */
        const bag = {};
        for (const sn of stores) {
          const store = db.transaction(sn, 'readonly').objectStore(sn);
          const meta = { keyPath: store.keyPath, autoIncrement: store.autoIncrement };
          const records = await readAll(db, sn);
          if (Object.keys(records).length > 0) {
            bag[sn] = { _meta: meta, data: records };
            total += Object.keys(records).length;
          }
        }
        if (Object.keys(bag).length > 0) backup.dbs[dbName] = bag;
      } finally {
        db.close();
      }
    }
    // v0.6.38：分析 C2 存档状态（对局中/主菜单）——帮助用户确认导出内容
    let c2State = null;
    try {
      const c2db = backup.dbs['_C2SaveStates_' + dbKey] || backup.dbs['_C2SaveStates'];
      if (c2db && c2db.saves && c2db.saves.data) {
        const ck = Object.keys(c2db.saves.data)[0];
        const rec = ck ? c2db.saves.data[ck] : null;
        if (rec && rec.data) {
          const d = JSON.parse(rec.data);
          let inst = 0;
          const types = d.types || {};
          for (const t of Object.keys(types)) { if (types[t] && types[t].instances) inst += types[t].instances.length; }
          const rt = (d.rt && d.rt.time) || 0;
          c2State = (inst > 0 && rt > 0) ? ('对局中（运行 ' + Math.round(rt) + ' 秒 / ' + inst + ' 实例 / 槽 ' + (rec.slot || ck) + '）') : (rt === 0 ? '主菜单/未开始对局（实例 ' + inst + '）' : '对局外状态');
        }
      }
    } catch (e) {}
    return { backup, count: total, c2Missing: !Object.keys(backup.dbs).some(function (n) { return n.indexOf('_C2SaveStates') === 0; }), c2State }; // v0.6.32：C2 存档库缺失标记；v0.6.38：+ c2State 状态标记
  }

  // v0.6.33：PC 版游戏历史缺隔离补丁（读写无后缀库）与启动器存档管理（带后缀库）错配——
  // 启动游戏前把无后缀遗留库（_C2SaveStates / localforage）数据迁移到带后缀库（仅当带后缀该前缀无数据），
  // 保证 PC 游戏读带后缀库后旧存档不丢、导入立即生效。web/安卓有隔离补丁无需迁移，调用无害。
  async function migrateLegacyDbs(dbKey, opts) {
    /* v1.0.14（重要修复）：只有「历史上真的写裸库的版本」才允许自动迁移裸库。
       原先对所有版本都迁移 → 任何"还没有自己存档"的版本都会被灌入裸库（= PC 版/多人版写的）数据，
       用户反馈的「存档隔离不起作用」正是这个现象。opts.allowBare=false 时直接返回，不做任何事。 */
    const moved = [];
    if (!(opts && opts.allowBare)) return moved;
    const suffix = '_' + dbKey;
    const prefixes = ['_C2SaveStates', 'localforage'];
    for (const p of prefixes) {
      const full = p + suffix;
      try {
        if (!indexedDB.databases) continue;
        const names = (await indexedDB.databases()).map(d => d.name);
        if (names.indexOf(p) === -1) continue; // 无后缀库不存在
        // 带后缀库已有该前缀数据 → 无后缀是旧数据，跳过（防覆盖）
        if (names.indexOf(full) !== -1) {
          const db = await openDB(full);
          let cnt = 0;
          for (const sn of Array.from(db.objectStoreNames)) cnt += Object.keys(await readAll(db, sn)).length;
          db.close();
          if (cnt > 0) continue;
        }
        // 迁移：无后缀 → 带后缀（复制 store 结构与记录，不删无后缀库）
        const bare = await openDB(p);
        for (const sn of Array.from(bare.objectStoreNames)) {
          const records = await readAll(bare, sn);
          if (!Object.keys(records).length) continue;
          const meta = (function () {
            try { const t = bare.transaction(sn).objectStore(sn); return { keyPath: t.keyPath, autoIncrement: t.autoIncrement }; }
            catch (e) { return { keyPath: null, autoIncrement: false }; }
          })();
          const db2 = await openDB(full, [{ name: sn, keyPath: meta.keyPath || null, autoIncrement: !!meta.autoIncrement }]);
          const tx = db2.transaction(sn, 'readwrite');
          const st = tx.objectStore(sn);
          st.clear();
          const hasInline = st.keyPath !== null && st.keyPath !== undefined && st.keyPath !== '';
          for (const k of Object.keys(records)) {
            try { if (hasInline) st.put(records[k]); else st.put(records[k], deserKey(k)); }
            catch (err) { if (hasInline && err && err.name === 'DataError') st.put(records[k], deserKey(k)); else throw err; }
          }
          await txDone(tx);
          db2.close();
          moved.push(p + ':' + Object.keys(records).length);
        }
        bare.close();
      } catch (e) { console.warn('[save] migrateLegacyDbs skip ' + p + ': ' + e.message); }
    }
    return moved;
  }

  // === 导入（支持跨 dbKey 迁移） ===
  async function importVersion(dbKey, text) {
    const backup = JSON.parse(text);
    if (!backup || typeof backup !== 'object') throw new Error('无效的存档文件');
    if (backup._c2 !== true || !backup.dbs) throw new Error('不是 C2 存档导出文件（缺少 _c2/dbs）');
    if (backup._dbKey && backup._dbKey !== dbKey) {
      console.warn('[save] 存档来自 dbKey=' + backup._dbKey + '，目标=' + dbKey + '，将按目标 dbKey 迁移恢复');
    }
    const allowed = expectedDbNames(dbKey);
    let restored = 0, skipped = 0;
    // 备份里同一目标库可能同时有「带后缀源」和「无后缀遗留源」（旧版本导出的双份数据）。
    // 必须带后缀源优先（新数据）：先按「无后缀在前」排序，后面同目标库的带后缀源覆盖；
    // 最终写入时只用每个目标库的带后缀源，无后缀遗留库跳过——否则同库双写、旧数据覆盖新数据。
    // （此前实现按 Object.keys 顺序遍历，无后缀库先写后带后缀被跳过 → 恢复的是旧数据）
    const targetSource = {}; // dbName -> rawDbName（带后缀源优先）
    for (const rawDbName of Object.keys(backup.dbs)) {
      // 跨 dbKey 迁移：备份库名 <前缀>_<备份dbKey> → <前缀>_<目标dbKey>（否则会被当非本版本库跳过，恢复 0 条）
      let dbName = rawDbName;
      if (backup._dbKey && backup._dbKey !== dbKey) {
        const suf = '_' + backup._dbKey;
        if (rawDbName.endsWith(suf)) dbName = rawDbName.slice(0, rawDbName.length - suf.length) + '_' + dbKey;
      }
      // 无后缀库迁移：无隔离环境遗留（_C2SaveStates / localforage）→ 目标带后缀库
      if (BARE_PREFIXES.indexOf(rawDbName) !== -1) dbName = rawDbName + '_' + dbKey;
      if (allowed.indexOf(dbName) === -1) { console.warn('[save] 跳过非本版本库:', rawDbName); skipped++; continue; }
      const isBare = BARE_PREFIXES.indexOf(rawDbName) !== -1;
      const prev = targetSource[dbName];
      if (prev === undefined) targetSource[dbName] = rawDbName;
      else if (!isBare) { // 同目标库：带后缀源覆盖无后缀源（无后缀是旧数据，跳过）
        if (BARE_PREFIXES.indexOf(prev) !== -1) { targetSource[dbName] = rawDbName; skipped++; }
        else skipped++;
      } else skipped++;
    }
    const orderedRaw = Object.keys(targetSource).map(dbName => ({ dbName, rawDbName: targetSource[dbName] }));
    let c2Count = 0; // v0.6.35：C2 存档库恢复条数（供 UI 明确提示）
    for (const { dbName, rawDbName } of orderedRaw) {
      const stores = backup.dbs[rawDbName];
      /* v1.0.15：空条目（旧版导出的 `{}` 库记录）直接跳过 —— 否则 openDB(name, []) 会落到
         "只读打开"分支，目标机没有该库时抛「库不存在」，把整次导入打断。 */
      if (!stores || !Object.keys(stores).length) { skipped++; continue; }
      // 按备份 _meta 重建 store（keyPath/autoIncrement），修复安卓等跨端 keyPath 差异导致的导入失败
      const storeDefs = Object.keys(stores).map(function (sn) {
        const m = (stores[sn] && stores[sn]._meta) || {};
        return { name: sn, keyPath: m.keyPath || null, autoIncrement: !!(m.autoIncrement) };
      });
      const db = await openDB(dbName, storeDefs);
      for (const sn of Object.keys(stores)) {
        if (!db.objectStoreNames.contains(sn)) continue;
        const entry = stores[sn];
        const meta = (entry && entry._meta) || {};
        const records = (entry && entry.data) || entry || {};
        // v0.6.65 回退：恢复「每 store 单事务」原子写入（v0.6.64 分块写入在安卓 16 真机导致导入不正常，
        // 用户要求退回原版；安卓 7 闪退问题另待 logcat 定位）
        const tx = db.transaction(sn, 'readwrite');
        const store = tx.objectStore(sn);
        store.clear();
        // 以实时 store 配置决定写入方式（兼容 keyPath 记录与实际不一致）
        const liveKey = store.keyPath;
        const hasInline = liveKey !== null && liveKey !== undefined && liveKey !== '';
        let n = 0;
        for (const k of Object.keys(records)) {
          try {
            const v = records[k];
            if (hasInline) store.put(v);
            else store.put(v, deserKey(k));
          } catch (err) {
            // 值里缺少 keyPath 字段时退回外置键
            if (hasInline && err && err.name === 'DataError') store.put(records[k], deserKey(k));
            else throw err;
          }
          n++;
        }
        // 事务提交失败必须报错（此前 onerror 也当成功，会假报"恢复 N 条"实际没写入）
        try { await txDone(tx); }
        catch (e) { db.close(); throw new Error('写入失败（库 ' + dbName + ' / store ' + sn + '）: ' + ((e && e.message) || e)); }
        restored += n;
        if (dbName.indexOf('_C2SaveStates') === 0) c2Count += n;
      }
      db.close();
    }
    return { restored, skipped, c2Count }; // v0.6.35：c2Count = C2 存档恢复条数（0 = 该版本无进度数据）
  }

  /** 诊断：枚举本 origin 所有 IndexedDB 库 + store 名（排查存档读/写库不一致） */
  async function listDbs() {
    const out = [];
    try {
      if (!indexedDB.databases) { out.push({ name: '（此浏览器不支持 indexedDB.databases() 枚举）', stores: [] }); return out; }
      const all = await indexedDB.databases();
      for (const d of all) {
        let stores = [];
        try {
          const db = await openDB(d.name);
          stores = Array.from(db.objectStoreNames);
          db.close();
        } catch (e) { stores = ['ERR ' + e.message]; }
        out.push({ name: d.name, stores });
      }
    } catch (e) { out.push({ name: 'ERR ' + e.message, stores: [] }); }
    return out;
  }

  /** v0.5.1：删除指定版本的全部存档库（discoverDbs 实际库 + blocked 重试；失败不阻断）。
   *  v0.6.23：改用实际存在的库（discoverDbs，覆盖游戏可能用的真实库名）；onblocked 等待 500ms 重试
   *  （最多 3 次——游戏 iframe 保持 IndexedDB 连接时会阻塞 deleteDatabase → 删除无效「刷新又回来」，
   *  配合调用方「删除前关闭游戏」连接释放后重试成功）。 */
  function deleteDbWithRetry(name, tries) {
    tries = tries || 0;
    return new Promise(function (res, rej) {
      try {
        const rq = indexedDB.deleteDatabase(name);
        rq.onsuccess = function () { res(); };
        rq.onerror = function () { rej(rq.error || new Error('deleteDatabase 失败')); };
        rq.onblocked = function () {
          if (tries < 3) setTimeout(function () { deleteDbWithRetry(name, tries + 1).then(res, rej); }, 500);
          else rej(new Error('库被占用: ' + name));
        };
      } catch (e) { rej(e); }
    });
  }
  async function deleteVersionSaves(dbKey) {
    let targets = [];
    try { targets = await discoverDbs(dbKey); } catch (e) { targets = expectedDbNames(dbKey); }
    if (!targets.length) targets = expectedDbNames(dbKey);
    const del = [];
    for (const n of targets) {
      try {
        await deleteDbWithRetry(n);
        del.push(n);
      } catch (e) { /* 个别库失败不阻断其余 */ }
    }
    // 注意：只删当前存档，不删备份槽（mdz_save_slots）——用户确认「删除存档只删当前存档、保留备份」（v0.6.24）
    return del;
  }

  // === 多存档备份槽（v0.5.2）：每个版本可保存多份存档快照 ===
  const SLOTS_DB = 'mdz_save_slots';
  function openSlotsDb() { return openDB(SLOTS_DB, [{ name: 'slots', keyPath: 'key' }]); }
  function slotKey(dbKey, name) { return dbKey + '::' + name; }
  async function listSlots(dbKey) {
    const db = await openSlotsDb();
    const out = [];
    await new Promise(function (res, rej) {
      const tx = db.transaction('slots', 'readonly');
      const rq = tx.objectStore('slots').openCursor();
      rq.onsuccess = function (e) {
        const c = e.target.result;
        if (c) {
          if (c.value && c.value.dbKey === dbKey) {
            const v = Object.assign({}, c.value);
            v.size = JSON.stringify(v.data).length; // 近似大小（字符数≈字节）
            delete v.data; // 列表不携带数据
            out.push(v);
          }
          c.continue();
        } else { res(); }
      };
      rq.onerror = function () { rej(rq.error || new Error('读取备份槽失败')); };
    });
    db.close();
    out.sort(function (a, b) { return (b.created || 0) - (a.created || 0); });
    return out;
  }
  /** 把当前存档快照存入命名槽（同名覆盖；v0.6.0：空存档不创建备份） */
  async function createSlot(dbKey, name) {
    const { backup, count } = await exportVersion(dbKey);
    if (count === 0) throw new Error('该版本还没有存档数据（不创建空备份）');
    const db = await openSlotsDb();
    const rec = { key: slotKey(dbKey, name), dbKey: dbKey, name: name, created: Date.now(), count: count, data: backup };
    await new Promise(function (res, rej) {
      const tx = db.transaction('slots', 'readwrite');
      tx.objectStore('slots').put(rec);
      tx.oncomplete = function () { res(); };
      tx.onerror = function () { rej(tx.error || new Error('写入备份槽失败')); };
      tx.onabort = function () { rej(tx.error || new Error('写入备份槽中止')); };
    });
    db.close();
    return { name: name, count: count };
  }
  /** 读取单个槽完整数据（导出用） */
  async function getSlot(dbKey, name) {
    const db = await openSlotsDb();
    const rec = await new Promise(function (res, rej) {
      const tx = db.transaction('slots', 'readonly');
      const rq = tx.objectStore('slots').get(slotKey(dbKey, name));
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error || new Error('读取备份槽失败')); };
    });
    db.close();
    return rec || null;
  }
  /** 从槽恢复（覆盖当前存档） */
  async function restoreSlot(dbKey, name) {
    const db = await openSlotsDb();
    const rec = await new Promise(function (res, rej) {
      const tx = db.transaction('slots', 'readonly');
      const rq = tx.objectStore('slots').get(slotKey(dbKey, name));
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error || new Error('读取备份槽失败')); };
    });
    db.close();
    if (!rec) throw new Error('备份不存在：' + name);
    return await importVersion(dbKey, JSON.stringify(rec.data));
  }
  /** 删除槽 */
  async function deleteSlot(dbKey, name) {
    const db = await openSlotsDb();
    await new Promise(function (res, rej) {
      const tx = db.transaction('slots', 'readwrite');
      tx.objectStore('slots').delete(slotKey(dbKey, name));
      tx.oncomplete = function () { res(); };
      tx.onerror = function () { rej(tx.error || new Error('删除备份槽失败')); };
    });
    db.close();
    return { ok: true };
  }
  /** v0.6.1：重命名槽（key + name 同步更新） */
  async function renameSlot(dbKey, oldName, newName) {
    if (!newName || newName === oldName) return { ok: true };
    const db = await openSlotsDb();
    const rec = await new Promise(function (res, rej) {
      const tx = db.transaction('slots', 'readonly');
      const rq = tx.objectStore('slots').get(slotKey(dbKey, oldName));
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error || new Error('读取备份槽失败')); };
    });
    if (!rec) { db.close(); throw new Error('备份不存在：' + oldName); }
    rec.key = slotKey(dbKey, newName);
    rec.name = newName;
    await new Promise(function (res, rej) {
      const tx = db.transaction('slots', 'readwrite');
      tx.objectStore('slots').delete(slotKey(dbKey, oldName));
      tx.objectStore('slots').put(rec);
      tx.oncomplete = function () { res(); };
      tx.onerror = function () { rej(tx.error || new Error('重命名备份槽失败')); };
      tx.onabort = function () { rej(tx.error || new Error('重命名备份槽中止')); };
    });
    db.close();
    return { ok: true };
  }

  /** v0.6.0：备份默认名称「备份_<版本id>_<时间到分钟>」（防重名加序号）
   *  v1.0.15：时间戳改用**本地时间**（原来 toISOString 是 UTC，国内用户看到的槽名时间早 8 小时） */
  function stamp() {
    const d = new Date();
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes());
  }
  async function nextSlotName(dbKey) {
    const ts = stamp(); // YYYYMMDDHHMM（本地）
    const base = '备份_' + String(dbKey || 'game').replace(/^version_/, '') + '_' + ts;
    const slots = await listSlots(dbKey);
    const names = {};
    for (const s of slots) names[s.name] = true;
    let n = base, i = 2;
    while (names[n]) { n = base + '_' + i; i++; }
    return n;
  }

  // v0.6.4：是否有存档数据（任何库任何 store 存在记录）——存档页「无存档整卡收起」检测用
  // v0.6.70：store.count() 判定存在性（不再 readAll 读全部记录值——大库/真机逐次进页的卡顿源）
  async function hasSaveData(dbKey) {
    const targets = await discoverDbs(dbKey);
    let total = 0;
    for (const dbName of targets) {
      let db;
      try { db = await openDB(dbName); } catch (e) { continue; }
      try {
        const stores = Array.from(db.objectStoreNames);
        for (const sn of stores) {
          const cnt = await new Promise(function (res) {
            try {
              const tx = db.transaction(sn, 'readonly');
              const rq = tx.objectStore(sn).count();
              rq.onsuccess = function () { res(rq.result || 0); };
              rq.onerror = function () { res(0); };
            } catch (e) { res(0); }
          });
          total += cnt;
          if (total > 0) break;
        }
      } finally { db.close(); }
      if (total > 0) break;
    }
    return total > 0;
  }

  // v0.7.2：列出所有有存档数据的 dbKey（含已删除版本但保留存档的「孤儿」dbKey）——
  // 存档库名 `_C2SaveStates_<dbKey>` / `localforage_<dbKey>`，备份槽库 mdz_save_slots 的 key 为 `dbKey::name`
  async function allDbKeysWithData() {
    const keys = new Set();
    try {
      if (!indexedDB.databases) return [];
      const all = await indexedDB.databases();
      const names = (all.map(function (d) { return d.name; }) || []).filter(Boolean);
      for (const n of names) {
        for (const p of ['_C2SaveStates_', 'localforage_']) {
          if (n.indexOf(p) === 0) { keys.add(n.slice(p.length)); break; }
        }
      }
      if (names.indexOf('mdz_save_slots') >= 0) {
        try {
          const db = await openDB('mdz_save_slots');
          const klist = await new Promise(function (res) {
            try {
              const tx = db.transaction('slots', 'readonly');
              const req = tx.objectStore('slots').getAllKeys();
              req.onsuccess = function () { res(req.result || []); };
              req.onerror = function () { res([]); };
            } catch (e) { res([]); }
          });
          db.close();
          for (const k of klist) { if (typeof k === 'string') keys.add(k.split('::')[0]); }
        } catch (e) {}
      }
    } catch (e) {}
    return Array.from(keys);
  }

  // v0.6.61：轻量返回「有备份槽的 dbKey → 槽数」映射——只读 store key，不读槽 data
//（listSlots 为算 size 会对每个槽 JSON.stringify 整份备份数据，扫描「是否有数据」时用本函数避免大对象开销）
async function slotDbKeyCounts() {
  const out = {};
  try {
    const db = await openDB(SLOTS_DB);
    try {
      const keys = await new Promise(function (res) {
        try {
          const tx = db.transaction('slots', 'readonly');
          const req = tx.objectStore('slots').getAllKeys();
          req.onsuccess = function () { res(req.result || []); };
          req.onerror = function () { res([]); };
        } catch (e) { res([]); }
      });
      for (const k of keys) { if (typeof k === 'string') { const dk = k.split('::')[0]; out[dk] = (out[dk] || 0) + 1; } }
    } catch (e) {}
    db.close();
  } catch (e) {}
  return out;
}

window.__saveManager = { exportVersion, importVersion, expectedDbNames, discoverDbs, listDbs, deleteVersionSaves, hasSaveData, allDbKeysWithData, listSlots, getSlot, createSlot, restoreSlot, deleteSlot, renameSlot, nextSlotName, migrateLegacyDbs, slotDbKeyCounts };
})();
