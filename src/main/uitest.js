'use strict';
/**
 * uitest —— MDZ_UITEST=1 时的 UI 全路径回归（只用于开发验证，不影响正常运行）
 *
 * 覆盖：版本列表渲染 → 存档页过滤 → 内嵌播放器 → 分辨率切换 → 窗口模式 →
 *       联机配置页 → 多人版配置弹窗 → 信令/分发服务 → 客户端播放 → 存档隔离。
 * 每一步都往 stdout 打 `[uitest] xxx=` 便于比对；最终输出 RESULT=UI-OK / RESULT=FAIL 并退出进程。
 *
 * 这些断言依赖真实窗口与真实游戏包，因此只能在桌面 Electron 里跑，不在单测范围。
 */
const { formatConsoleMessage } = require('./dev-harness');

/**
 * @param {object} deps
 * @param {()=>BrowserWindow|null} deps.getLauncher
 * @param {()=>BrowserWindow|null} deps.getGame
 * @param {object} deps.windows game-windows 控制器（关窗要同时清状态）
 * @param {object} deps.lanServices
 * @param {(code:number)=>void} deps.exit
 * @param {(args:any[])=>string} [deps.formatConsole]
 */
function runUITest(deps) {
  deps.formatConsole = deps.formatConsole || formatConsoleMessage;
  let done = false;
  const finish = (code, msg) => {
    if (done) return;
    done = true;
    console.log('[uitest] ' + msg);
    setTimeout(() => deps.exit(code), 600);
  };
  const js = (code) => deps.getLauncher().webContents.executeJavaScript(code);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const WAIT = (ms) => { const t0 = Date.now(); return () => Date.now() - t0 > ms; };
  // 转发 launcher 页面 console（含 iframe 内同源游戏页）→ stdout，诊断加载错误
  deps.getLauncher().webContents.on('console-message', (...a) => {
    try { console.log('[uitest][console] ' + deps.formatConsole(a).slice(0, 300)); } catch (e) {}
  });

  (async () => {
    try {
      // 1) 等版本列表渲染（异步 fetchVersionList + refresh）
      let n = 0, listN = 0;
      const deadline = WAIT(20000);
      while (!deadline()) {
        n = await js('(function(){ var a=window.__webApp; return a ? a.versions() : -1; })()');
        listN = await js("document.querySelectorAll('#versions .list-row, #versions .vcard, #versions .card').length");
        if (n >= 1 && listN >= 1) break;
        await sleep(300);
      }
      if (n < 1 || listN < 1) { finish(1, 'RESULT=FAIL no list rendered (v=' + n + ' cards=' + listN + ')'); return; }
      // 2) 列表断言：v0.7.20 起置顶块 = 「MINIDAYZ PC版」系列（单机版 + 多人版同系列）→
      //    首项应为该系列头（父级行），块内有 MiniDayZ PC 版 / 多人版两个子项，且与后续版本之间有虚线分隔
      await js("(function(){ try { localStorage.removeItem('mdz-playmode-minidayz-pc'); localStorage.removeItem('mdz-res-minidayz-pc'); } catch(e){} return 1; })()"); // v0.7.6：每轮清播放方式/分辨率残留，确保 embed+默认分辨率起点
      const listInfo = await js(`(function(){
        var wrap = document.getElementById('versions');
        var cards = Array.from(wrap.querySelectorAll('.list-row, .vcard, .card'));
        var names = cards.map(function(c){ return (c.textContent || '').trim().slice(0, 40); });
        var first = names[0] || '';
        var head = (wrap.querySelector('.series-head') || {}).textContent || '';
        var all = wrap.textContent || '';
        // 分隔线：仅当置顶块之后还有其它版本时才应出现（测试环境通常只有两个内置版 → 无需分隔线）
        var seps = wrap.querySelectorAll('.list-first-sep').length;
        var topCount = wrap.children.length - seps;
        return JSON.stringify({ total: cards.length, names: names.slice(0, 8),
          firstIsPc: (first.indexOf('MiniDayZ PC') >= 0 || /PC版/.test(first) || /PC版/.test(head)),
          // v0.7.25：多人版客户端是合成版本条目（名字含「多人版」，与单机版同系列）
      hasMp: /多人版/.test(all),
          topCount: topCount,
          sepAfterFirst: (topCount <= 1) ? true : (seps > 0),
          importBtn: !!document.getElementById('pc-btn-import'),
          noticeBtn: !!document.getElementById('btn-notice') }); // v0.7.10：PC 无公告 → 不应出现侧边栏公告按钮
      })()`);
      console.log('[uitest] list=' + listInfo);
      const li = JSON.parse(listInfo);
      if (!li.firstIsPc || !li.hasMp || !li.sepAfterFirst || !li.importBtn || li.noticeBtn) { finish(1, 'RESULT=FAIL list assertions: ' + listInfo); return; }
      // 3) 存档管理器：切存档视图 → 卡无 minidayz-pc
      await js("(function(){ var b=document.querySelector('[data-view=saves]'); if(b) b.click(); return !!b; })()");
      await sleep(1500);
      const saveInfo = await js(`(function(){
        var names = Array.from(document.querySelectorAll('#save-list .save-card h3')).map(function(h){ return h.textContent; });
        return JSON.stringify({ names: names, hasPc: names.some(function(x){ return x.indexOf('MiniDayZ PC') >= 0; }) });
      })()`);
      console.log('[uitest] saves=' + saveInfo);
      const si = JSON.parse(saveInfo);
      if (si.hasPc) { finish(1, 'RESULT=FAIL saves contains minidayz-pc: ' + saveInfo); return; }
      // 4) 回版本列表 → 选中 minidayz-pc → 详情「启动」
      // v0.7.16：PC 默认播放方式=窗口模式——内嵌断言前显式改回 embed 测试内嵌链路
      await js("(function(){ try { localStorage.setItem('mdz-playmode-minidayz-pc', JSON.stringify('embed')); } catch(e){} return 1; })()");
      await js("(function(){ Array.from(document.querySelectorAll('[data-view]')).forEach(function(x){ if(x.dataset.view==='versions') x.click(); }); return 1; })()");
      await sleep(700);
      const clicked = await js(`(async function(){
        var rows = Array.from(document.querySelectorAll('#versions .list-row, #versions .vcard, #versions .card'));
        var hit = rows.find(function(r){ return (r.textContent||'').indexOf('MiniDayZ PC') >= 0; });
        if (!hit) return 'no-row';
        hit.click();
        await new Promise(function(res){ setTimeout(res, 800); });
        var btns = Array.from(document.querySelectorAll('#detail-panel button'));
        var play = btns.find(function(b){ return b.textContent.indexOf('启动') >= 0; });
        if (!play) return 'no-play-btn';
        play.click(); return 'clicked';
      })()`);
      console.log('[uitest] click=' + clicked);
      // 5) 等 iframe 加载 minidayz-pc
      let snap = null;
      const d2 = WAIT(25000);
      while (!d2()) {
        snap = await js(`(function(){
          var fr = document.getElementById('embed-frame');
          if (!fr || !fr.src || fr.src.indexOf('minidayz-pc') < 0) return null;
          var st = document.getElementById('embed-stage');
          try {
            var d = fr.contentDocument;
            if (!d) return { state: 'loading-doc' };
            var el = d.scrollingElement || d.documentElement;
            var cv = d.getElementById('c2canvas');
            return {
              state: d.getElementById('mods') ? 'mods' : 'loaded',
              frameRes: fr.dataset.resW + 'x' + fr.dataset.resH,
              frameCss: fr.style.width + 'x' + fr.style.height + ' t=' + (fr.style.transform || 'none'),
              stageStyleH: st.style.height || '',
              scrollEq: el.scrollHeight === el.clientHeight,
              overflowHidden: getComputedStyle(d.documentElement).overflowY === 'hidden',
              canvas: cv ? cv.clientWidth + 'x' + cv.clientHeight : null,
              hasMods: !!d.getElementById('mods')
            };
          } catch (e) { return { state: 'err:' + e }; }
        })()`);
        if (snap && (snap.state === 'mods' || snap.state === 'loaded' || snap.state.indexOf('err') === 0)) break;
        await sleep(400);
      }
      console.log('[uitest] embed=' + JSON.stringify(snap));
      if (!snap || snap.state === 'err') { finish(1, 'RESULT=FAIL embed: ' + JSON.stringify(snap)); return; }
      // v0.7.8：自由分辨率——iframe 布局=默认 defaultRes(850×890)、overflow hidden、canvas 完整
      if (!snap.overflowHidden || String(snap.frameRes) !== '850x890' || String(snap.canvas) !== '850x890') {
        finish(1, 'RESULT=FAIL embed geometry: ' + JSON.stringify(snap)); return;
      }
      // 6) 点 Start 进游戏，确认 canvas 完整运行
      await js("(function(){ try { var d=document.getElementById('embed-frame').contentDocument; var s=d.querySelector('#mods .start'); if(s) s.dispatchEvent(new PointerEvent('pointerup',{bubbles:true})); return !!s; } catch(e){ return false; } })()");
      await sleep(8000);
      const game = await js(`(function(){
        try {
          var fr=document.getElementById('embed-frame'); var d=fr.contentDocument;
          var el=d.scrollingElement||d.documentElement; var cv=d.getElementById('c2canvas');
          return { hasMods: !!d.getElementById('mods'), canvas: cv ? cv.clientWidth+'x'+cv.clientHeight : null,
            scrollEq: el.scrollHeight === el.clientHeight };
        } catch(e){ return 'err:'+e; }
      })()`);
      console.log('[uitest] game=' + JSON.stringify(game));
      if (!game || typeof game !== 'object' || game.hasMods || !game.canvas) {
        finish(1, 'RESULT=FAIL game start: ' + JSON.stringify(game)); return;
      }
      // 6.5) v0.7.6：分辨率可调——关闭播放器 → 设 1280×720 → 重启动 → iframe 布局 1280×914
      await js("(function(){ var b=document.getElementById('btn-embed-close'); if(b) b.click(); return !!b; })()");
      await sleep(1000);
      await js("(function(){ try { localStorage.setItem('mdz-res-minidayz-pc', JSON.stringify({w:1280,h:720})); } catch(e){} return 1; })()");
      const clicked2 = await js(`(async function(){
        var rows = Array.from(document.querySelectorAll('#versions .list-row, #versions .vcard, #versions .card'));
        var hit = rows.find(function(r){ return (r.textContent||'').indexOf('MiniDayZ PC') >= 0; });
        if (!hit) return 'no-row';
        hit.click();
        await new Promise(function(res){ setTimeout(res, 600); });
        var btns = Array.from(document.querySelectorAll('#detail-panel button'));
        var play = btns.find(function(b){ return b.textContent.indexOf('启动') >= 0; });
        if (!play) return 'no-play-btn';
        play.click(); return 'ok';
      })()`);
      console.log('[uitest] resclick=' + clicked2);
      let snapRes = null;
      const d3 = WAIT(25000);
      while (!d3()) {
        snapRes = await js(`(function(){
          var fr = document.getElementById('embed-frame');
          if (!fr || !fr.src || fr.src.indexOf('minidayz-pc') < 0) return null;
          var d = fr.contentDocument;
          if (!d || !d.getElementById('mods')) return { state: 'loading' };
          return { state: 'mods', frameRes: fr.dataset.resW + 'x' + fr.dataset.resH,
            resSel: (function(){ var s=document.getElementById('embed-res'); return s ? s.value : '-'; })() };
        })()`);
        if (snapRes && snapRes.state === 'mods') break;
        await sleep(400);
      }
      console.log('[uitest] res-snap=' + JSON.stringify(snapRes));
      if (!snapRes || snapRes.frameRes !== '1280x720' || snapRes.resSel !== '1280x720') {
        finish(1, 'RESULT=FAIL resolution: ' + JSON.stringify(snapRes)); return;
      }
      // 7) v0.7.11：PC「窗口模式」（原全屏）→ 独立游戏窗口（IPC versions:launch → createGameWindow）
      await js("(function(){ try { localStorage.setItem('mdz-playmode-minidayz-pc', JSON.stringify('fullscreen')); } catch(e){} return 1; })()");
      const clicked3 = await js(`(async function(){
        var rows = Array.from(document.querySelectorAll('#versions .list-row, #versions .vcard, #versions .card'));
        var hit = rows.find(function(r){ return (r.textContent||'').indexOf('MiniDayZ PC') >= 0; });
        if (!hit) return 'no-row';
        hit.click();
        await new Promise(function(res){ setTimeout(res, 600); });
        var btns = Array.from(document.querySelectorAll('#detail-panel button'));
        var play = btns.find(function(b){ return b.textContent.indexOf('启动') >= 0; });
        if (!play) return 'no-play-btn';
        play.click(); return 'ok';
      })()`);
      console.log('[uitest] winclick=' + clicked3);
      let winOk = null;
      const d4 = WAIT(20000);
      while (!d4()) {
        winOk = (deps.getGame() && !deps.getGame().isDestroyed())
          ? { url: deps.getGame().webContents.getURL(), content: deps.getGame().getContentSize() }
          : null;
        if (winOk && String(winOk.url).indexOf('minidayz-pc') >= 0) break;
        await sleep(400);
      }
      console.log('[uitest] gamewin=' + JSON.stringify(winOk));
      if (!winOk || String(winOk.url).indexOf('minidayz-pc') < 0) { finish(1, 'RESULT=FAIL window-mode: ' + JSON.stringify(winOk)); return; }
      // 7.5) v0.7.13：wrapper 壳页内游戏真实加载（无滚动条 + mapper 注入 + 画布存在）
      let inner = null;
      const d5 = WAIT(30000);
      while (!d5()) {
        if (!deps.getGame() || deps.getGame().isDestroyed()) { inner = { state: 'gone' }; break; }
        inner = await deps.getGame().webContents.executeJavaScript(`(function(){
          try {
            var f = document.getElementById('game');
            if (!f) return null;
            var d = f.contentDocument;
            if (!d || !d.documentElement) return null;
            var cv = d.getElementById('c2canvas');
            if (!cv) return { state: 'loading-canvas' };
            var ov = getComputedStyle(d.documentElement).overflowY;
            return { state: 'ok', canvas: cv.clientWidth + 'x' + cv.clientHeight,
              overflow: ov, mapper: !!d.getElementById('mdz-web-mapper') };
          } catch (e) { return { state: 'err:' + e }; }
        })()`);
        if (inner && inner.state === 'ok') break;
        await sleep(500);
      }
      console.log('[uitest] win-inner=' + JSON.stringify(inner));
      // v0.7.17：minidayz-pc = noKeymap（内置 PC 版键鼠原生）→ 壳页应有 overflow/画布处理但【不注入 mapper】
      if (!inner || inner.state !== 'ok' || inner.overflow !== 'hidden' || inner.mapper !== false) {
        finish(1, 'RESULT=FAIL window-inner: ' + JSON.stringify(inner)); return;
      }
      // 7.6) v0.7.17：noKeymap（minidayz-pc）窗口模式下 F10 不应出现校准面板（mapper 未注入）。
      // 普通版本窗口 mapper/F10 正向链路与内嵌 mapper 一致（web-smoke 校准断言覆盖）
      let f10 = null;
      try {
        f10 = await deps.getGame().webContents.executeJavaScript(`(async function(){
          try {
            var f = document.getElementById('game');
            if (!f || !f.contentWindow) return 'no-frame';
            var d = f.contentDocument;
            if (!d || !d.documentElement) return 'no-doc';
            var mapper = !!(d.getElementById('mdz-web-mapper') || d.getElementById('mdz-keymap-preset'));
            await new Promise(function (r) { setTimeout(r, 1200); });
            var sent = 0, panelShown = false;
            while (sent < 4) {
              try { f.contentWindow.dispatchEvent(new KeyboardEvent('keydown', { code: 'F10', bubbles: true, cancelable: true })); } catch (e) {}
              sent++;
              await new Promise(function (r) { setTimeout(r, 400); });
              if (d.getElementById('mdz-keycal')) { panelShown = true; break; }
            }
            return JSON.stringify({ mapper: mapper, panelShown: panelShown });
          } catch (e) { return 'err:' + e; }
        })()`);
        const fo = (typeof f10 === 'string') ? JSON.parse(f10) : f10;
        if (!fo || fo.mapper || fo.panelShown) { finish(1, 'RESULT=FAIL window-nokeymap: ' + JSON.stringify(f10)); return; }
        console.log('[uitest] win-nokeymap=' + JSON.stringify(f10));
      } catch (e2) { finish(1, 'RESULT=FAIL window-nokeymap exception: ' + e2); return; }
      try { deps.windows.closeGame(); } catch (e) {}
      await js("(function(){ try { localStorage.removeItem('mdz-playmode-minidayz-pc'); } catch(e){} return 1; })()");

      // 7.8) v0.7.22 新增 / v0.7.25 调整：局域网能力回归（控制面板已从设置页移到侧边栏「联机配置」页）
      //   a) 侧边栏有「联机配置」入口（放在 index.html 里，随导航绑定一起生效——不是后注入的按钮）
      const lanNav = await js(`(function(){ var b=document.querySelector('.nav-item[data-view="lan"]'); if(!b) return 'none';
        return JSON.stringify({ found:true, text:(b.textContent||'').trim(), isButton:b.tagName === 'BUTTON' }); })()`);
      console.log('[uitest] lan-nav=' + lanNav);
      if (String(lanNav).indexOf('none') === 0) { finish(1, 'RESULT=FAIL lan nav missing'); return; }

      //   a2) v0.7.25：侧边栏「联机配置」页（服务器/分发/建房程序三件套都在这一页；版本列表里不再放这三项）
      await js("(function(){ var n=document.querySelector('.nav-item[data-view=\"lan\"]'); if(n) n.click(); return 1; })()");
      await sleep(900);
      const lanPage = await js(`(function(){ var p=document.getElementById('lan-panel'); var v=document.getElementById('view-lan');
        if(!p||!v) return 'no-panel';
        var txt=p.textContent||'';
        return JSON.stringify({ active:v.classList.contains('active'), cards:p.querySelectorAll('.settings-card').length,
          btns:p.querySelectorAll('button').length, hasSignal:/信令/.test(txt), hasServe:/分发/.test(txt),
          hasName:/玩家名称/.test(txt), nameRows:[].slice.call(p.querySelectorAll('.row')).filter(function(r){ return r.querySelector('input') && (r.textContent||'').indexOf('玩家名称')>=0; }).length, hasHost:/建房程序/.test(txt), hasLog:!!document.getElementById('lan-log') }); })()`);
      console.log('[uitest] lan-page=' + lanPage);
      if (String(lanPage).indexOf('no-panel') === 0) { finish(1, 'RESULT=FAIL lan page missing'); return; }
      const lp = JSON.parse(lanPage);
      /* v0.7.30：玩家名称已挪到「多人版 → 配置」弹窗 → 联机配置页不该再有「玩家名称」输入行
         （不能只看文本——卡片提示里会提到这个词；也不能数文本框——建房程序目录也是文本框） */
      if (!lp.active || lp.cards < 3 || lp.btns < 5 || !lp.hasSignal || !lp.hasServe || !lp.hasHost || lp.nameRows !== 0 || !lp.hasLog) {
        finish(1, 'RESULT=FAIL lan page content: ' + lanPage); return;
      }
      //   a3) 多人版客户端 = 合成版本条目（与单机版同系列；父级块里有子项）
      await js("(function(){ var n=document.querySelector('.nav-item[data-view=\"versions\"]'); if(n) n.click(); return 1; })()");
      await sleep(900);
      const mpRow = await js(`(function(){ var wrap=document.getElementById('versions'); if(!wrap) return 'no-wrap';
        var txt=wrap.textContent||'';
        var head=wrap.querySelector('.list-row.series-head');
        /* v0.7.28：多人版图标/封面必须真加载出图像（此前写死 mp-icon.png/mp-cover.png → 图裂成一块蓝色，
           用户反馈「元数据没了、变成一块蓝色」）。这里按 naturalWidth 断言真图，而不是只看元素存在。 */
        var row=null, rows=[].slice.call(wrap.querySelectorAll('.list-row'));
        for (var i=0;i<rows.length;i++){ if((rows[i].textContent||'').indexOf('多人版')>=0){ row=rows[i]; break; } }
        var out={ hasMP:/多人版/.test(txt), seriesHead: head ? (head.textContent||'').slice(0,30) : 'none', img:null, imgOk:false };
        if (row) {
          var im=row.querySelector('img');
          if (im) { out.img = im.getAttribute('src'); out.imgOk = !!(im.naturalWidth > 0); }
          else out.img = 'no-img';
        } else out.img = 'no-row';
        return JSON.stringify(out); })()`);
      console.log('[uitest] lan-client-row=' + mpRow);
      const mp2 = (function () { try { return JSON.parse(mpRow); } catch (e) { return null; } })();
      if (!mp2 || !mp2.hasMP) { finish(1, 'RESULT=FAIL mp client row: ' + mpRow); return; }
      if (!mp2.imgOk) { finish(1, 'RESULT=FAIL mp client icon/cover 没加载出来（一块蓝色）: ' + mpRow); return; }
      /* v0.7.30：「服务器地址 + 玩家名称」在多人版**配置弹窗**里（用户要求从「联机配置」页挪过来），保存要真落盘 */
      const mpCfg = await js(`(async function(){
        var wrap=document.getElementById('versions');
        var rows=[].slice.call(wrap.querySelectorAll('.list-row'));
        var row=rows.filter(function(r){ return (r.textContent||'').indexOf('多人版')>=0; })[0];
        if(!row){ var hs=[].slice.call(wrap.querySelectorAll('.series-expand'));
          var h=hs.filter(function(b){ return (b.textContent||'').indexOf('展开')>=0; })[0];
          if(h){ h.click(); await new Promise(function(s){ setTimeout(s,800); }); }
          rows=[].slice.call(wrap.querySelectorAll('.list-row'));
          row=rows.filter(function(r){ return (r.textContent||'').indexOf('多人版')>=0; })[0];
        }
        if(!row) return 'no-mp-row';
        var cfg=row.querySelector('.lr-config'); if(!cfg) return 'no-cfg-btn'; cfg.click();
        await new Promise(function(s){ setTimeout(s,900); });
        var d=document.querySelector('.cd-dialog')||document.querySelector('.config-dialog');
        if(!d) return 'no-dialog';
        var ins=[].slice.call(d.querySelectorAll('input[type=text]'));
        if(ins.length<2) return 'inputs=' + ins.length;
        var before=(window.__launcherNative? await window.__launcherNative.lanStatus() : null);
        ins[0].value='192.168.7.7:8790';
        ins[1].value='UItestName';
        var bs=[].slice.call(d.querySelectorAll('button')).filter(function(b){ return (b.textContent||'').trim()==='保存'; });
        if(bs.length<2) return 'save-btns=' + bs.length;
        bs[0].click(); await new Promise(function(s){ setTimeout(s,700); });
        var d2=document.querySelector('.cd-dialog')||document.querySelector('.config-dialog');
        var ins2=[].slice.call(d2.querySelectorAll('input[type=text]'));
        ins2[1].value='UItestName';
        var bs2=[].slice.call(d2.querySelectorAll('button')).filter(function(b){ return (b.textContent||'').trim()==='保存'; });
        bs2[1].click(); await new Promise(function(s){ setTimeout(s,700); });
        var st=window.__launcherNative? await window.__launcherNative.lanStatus() : null;
        var d3=document.querySelector('.cd-dialog')||document.querySelector('.config-dialog');
        if(d3){ var cs=d3.querySelector('.cd-close'); if(cs) cs.click(); }
        return JSON.stringify({ inputs:ins.length, before: before? (before.lan.serverHost+'|'+before.lan.playerName) : 'n/a',
          host: st? st.lan.serverHost : 'n/a', sigPort: st? st.lan.signalPort : 0, name: st? st.lan.playerName : 'n/a',
          txt:(d3? (d3.textContent||'') : '').indexOf('多人联机')>=0 });
      })()`);
      console.log('[uitest] mp-config=' + mpCfg);
      const mc = (function () { try { return JSON.parse(mpCfg); } catch (e) { return null; } })();
      if (!mc || mc.inputs < 2 || mc.host !== '192.168.7.7' || mc.sigPort !== 8790 || mc.name !== 'UItestName') {
        finish(1, 'RESULT=FAIL mp config（服务器地址/玩家名称）: ' + mpCfg); return;
      }
      // 复位（后续步骤与用户日常都基于 127.0.0.1:8787 + MiniPlayer）
      await js("(async function(){ if(window.__launcherNative){ await window.__launcherNative.setLan({serverHost:'', signalPort:8787, playerName:'MiniPlayer'}); } return 1; })()");
      await sleep(500);
      const stReset = deps.lanServices.status();
      console.log('[uitest] mp-config-reset=' + JSON.stringify({ host: stReset.lan.serverHost, sig: stReset.lan.signalPort, name: stReset.playerName }));
      if (stReset.lan.serverHost !== '' || stReset.lan.signalPort !== 8787 || stReset.playerName !== 'MiniPlayer') {
        finish(1, 'RESULT=FAIL mp config reset: ' + JSON.stringify(stReset.lan)); return;
      }

      //   b) 进程内起信令服务器 → 配电服务 → 分发内容确实注入了自适应信令地址 → 再全部停掉
      deps.lanServices.startSignal();
      await sleep(1200);
      const stA = deps.lanServices.status();
      console.log('[uitest] lan-signal=' + JSON.stringify({ running: stA.signal.running, port: stA.signal.port, dir: stA.lanDir || '' }));
      if (!stA.signal.running || !stA.lanDir) { finish(1, 'RESULT=FAIL signal server not running'); return; }

      deps.lanServices.startServe();
      await sleep(1500);
      const stB = deps.lanServices.status();
      console.log('[uitest] lan-serve=' + JSON.stringify({ running: stB.serve.running, port: stB.serve.port, url: (stB.serve.urls || [])[0] || '', builtinMp: stB.builtinMp || '' }));
      if (!stB.serve.running || !stB.builtinMp) { finish(1, 'RESULT=FAIL serve not running'); return; }

      let injectOk = false;
      try {
        const httpMod = require('http');
        const body = await new Promise((resolve, reject) => {
          const req = httpMod.get('http://127.0.0.1:' + stB.serve.port + '/mods.js', (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => resolve(d)); });
          req.on('error', reject);
          req.setTimeout(5000, () => req.destroy(new Error('timeout')));
        });
        injectOk = /location\.hostname\s*\+\s*':\d+'/.test(body) && /mdz-signal/.test(body);
      } catch (e) { console.log('[uitest] lan-inject error: ' + e.message); }
      console.log('[uitest] lan-inject=' + injectOk + ' lan-host=' + JSON.stringify({ exists: stB.host.exists }));
      if (!injectOk) { finish(1, 'RESULT=FAIL distribute injection'); return; }

      deps.lanServices.stopServe();
      deps.lanServices.stopSignal();
      await sleep(700);
      const stC = deps.lanServices.status();
      console.log('[uitest] lan-stopped=' + JSON.stringify({ sig: stC.signal.running, serve: stC.serve.running }));
      if (stC.signal.running || stC.serve.running) { finish(1, 'RESULT=FAIL lan stop'); return; }

      //   c) v0.7.26：点「多人游戏客户端」= **本地**把客户端发出来（127.0.0.1:临时端口）+ 信令地址注入，
      //      窗口真的加载到游戏页（修「忘了先起服务 → 黑窗口」与「内嵌黑屏」）
      await js("(function(){ window.__playRes=''; window.__launcherNative.lanPlay().then(function(r){ window.__playRes=JSON.stringify(r); }).catch(function(e){ window.__playRes='ERR '+e.message; }); return 1; })()");
      await sleep(6000);
      const playRes = await js("window.__playRes || '(pending)'");
      console.log('[uitest] lan-play=' + playRes);
      let pr = null; try { pr = JSON.parse(playRes); } catch (e) {}
      if (!pr || pr.error || String(pr.url || '').indexOf('__lan_client__') < 0 || !pr.started || !pr.started.local) {
        finish(1, 'RESULT=FAIL lan:play local client: ' + playRes); return;
      }
      let playPage = 'none';
      const dPage = WAIT(30000);
      while (!dPage()) {
        if (!deps.getGame() || deps.getGame().isDestroyed()) { playPage = 'gone'; break; }
        try {
          /* v0.7.27：多人版现在和单机版同一条管线（壳页 game-window.html + 游戏 iframe），
             所以要看 iframe 里的游戏页，而不是壳页自身 */
          playPage = await deps.getGame().webContents.executeJavaScript("(function(){ try{ var f=document.getElementById('game'); var w=f&&f.contentWindow; var d=f&&f.contentDocument; if(!w||!d) return 'no-doc'; return (d.getElementById('mods')?'mods-ui':'no-mods') + '|canvas=' + (!!d.getElementById('c2canvas')) + '|sig=' + (w.__mdzMpSignal||'') + '|src=' + (f.getAttribute('src')||''); }catch(e){ return 'err:'+e.message; } })()");
        } catch (e) { playPage = 'err:' + e.message; }
        if (/canvas=true/.test(String(playPage))) break;
        await sleep(500);
      }
      console.log('[uitest] lan-play-page=' + playPage);
      if (!/mods-ui\|canvas=true/.test(String(playPage))) { finish(1, 'RESULT=FAIL lan play page (black screen?): ' + playPage); return; }
      if (String(playPage).indexOf('sig=ws://') < 0) { finish(1, 'RESULT=FAIL lan signal not injected: ' + playPage); return; }
      /* v0.7.29：客户端页地址必须带 mdz=1（据此 html,body{overflow:hidden}，不出滚动条）与 user=（玩家名） */
      if (String(playPage).indexOf('mdz=1') < 0) { finish(1, 'RESULT=FAIL 客户端地址缺 mdz=1（会出滚动条）: ' + playPage); return; }
      if (String(playPage).indexOf('user=') < 0) { finish(1, 'RESULT=FAIL 客户端地址缺 user=（玩家名）: ' + playPage); return; }
      //   c2) v0.7.24：在服务器分发的客户端里点 Start → C2 runtime 起来（顶替原「内置多人版内嵌启动」回归）
      try {
        await deps.getGame().webContents.executeJavaScript("(function(){ try{ var f=document.getElementById('game'); var d=f&&f.contentDocument; if(!d) return 0; var s=d.querySelector('#mods .start'); if(!s) return 0; s.dispatchEvent(new f.contentWindow.PointerEvent('pointerup',{bubbles:true})); return 1; }catch(e){ return 0; } })()");
      } catch (e) {}
      await sleep(9000);
      let srvRun = 'none';
      try {
        if (deps.getGame() && !deps.getGame().isDestroyed()) {
          /* v0.7.28：壳页 + iframe → C2 runtime 在 iframe 的 window 上；
             并验证客户端真的装了我们的**信令地址模组**（否则连的是官方=已停服，用户看到「原版、没房间」） */
          srvRun = await deps.getGame().webContents.executeJavaScript("(function(){ try{ var f=document.getElementById('game'); var w=f&&f.contentWindow; if(!w) return JSON.stringify({err:'no-frame'}); var d=w.document; var c=d&&d.getElementById('c2canvas');" +
            "var mpMods=''; try{ mpMods=String(w.localStorage.getItem('mp.mods')||''); }catch(e){}" +
            "var patched=false; try{ patched=!!(w.C2Multiplayer && w.C2Multiplayer.prototype && w.C2Multiplayer.prototype.__mdzSignalPatched); }catch(e){}" +
            "var addr=''; try{ addr=String(w.__mdzMpSignal||''); }catch(e){}" +
            /* v0.7.32：directUrl 客户端的「存档隔离」是否装上（壳页注入 / 客户端自带 P6 均可） */
            "var isoDb=''; try{ isoDb=String(w.__mdzDbKey||''); }catch(e){}" +
            "var isoOn=''; try{ isoOn=String(w.__mdzIsolation||''); }catch(e){}" +
            "return JSON.stringify({ runtime: !!w.c2runtime, modsGone: !(d&&d.getElementById('mods')), canvas: c ? (c.width+'x'+c.height) : null, sigMod: mpMods.indexOf('mdz-signal')>=0, sigPatched: patched, sigAddr: addr, isoDbKey: isoDb, isoOn: isoOn }); }catch(e){ return JSON.stringify({err:String(e)}); } })()");
        }
      } catch (e) { srvRun = 'err:' + e.message; }
      console.log('[uitest] lan-play-run=' + srvRun);
      const srr = (function () { try { return JSON.parse(srvRun); } catch (e) { return null; } })();
      if (!srr || !srr.runtime || !srr.modsGone) { finish(1, 'RESULT=FAIL server client run (black screen?): ' + srvRun); return; }
      /* v0.7.28：客户端必须挂上我们的信令模组（否则是「原版」= 连官方已停服 → 看不到自建服务器里的房间） */
      if (!srr.sigMod) { finish(1, 'RESULT=FAIL 客户端未启用 mdz-signal 模组（会连官方、看不到房间）: ' + srvRun); return; }
      if (String(srr.sigAddr || '').indexOf('ws://') !== 0) { finish(1, 'RESULT=FAIL 客户端未拿到局域网信令地址: ' + srvRun); return; }
      /* v0.7.32：多人版是 directUrl 直链加载 —— 必须已经装上「存档隔离」（库名带 __lan_client__ 后缀），
         否则它写裸库、与其它版本互相覆盖（用户反馈「存档隔离不起作用」） */
      if (String(srr.isoDbKey || '') !== '__lan_client__') { finish(1, 'RESULT=FAIL 多人版客户端未装存档隔离: ' + srvRun); return; }
      try { deps.windows.closeGame(); } catch (e) {}

      //   d) v0.7.25：从**版本列表**点「MiniDayZ 多人版」启动 → 走 lan:play（服务器分发页；PC 默认全屏，与单机版一致）
      await js("(function(){ var n=document.querySelector('.nav-item[data-view=\"versions\"]'); if(n) n.click(); return 1; })()");
      await sleep(800);
      const mpClick = await js(`(async function(){ var rows=[].slice.call(document.querySelectorAll('#versions .list-row'));
        var hit=rows.find(function(r){ return (r.textContent||'').indexOf('多人版')>=0 && r.querySelectorAll('button').length>1; });
        if(!hit) return 'no-row'; hit.click();
        await new Promise(function(s){ setTimeout(s,900); });
        var bs=[].slice.call(document.querySelectorAll('#detail-panel button'));
        var p=bs.find(function(b){ return (b.textContent||'').indexOf('启动')>=0; });
        if(!p) return 'no-play'; p.click(); return 'clicked'; })()`);
      console.log('[uitest] mp-launch-click=' + mpClick);
      await sleep(5000);
      let mpWin = 'none';
      try { if (deps.getGame() && !deps.getGame().isDestroyed()) mpWin = JSON.stringify({ url: deps.getGame().webContents.getURL(), fs: deps.getGame().isFullScreen() }); } catch (e) { mpWin = 'err:' + e.message; }
      console.log('[uitest] mp-launch-win=' + mpWin);
      if (String(mpWin).indexOf('__lan_client__') < 0) { finish(1, 'RESULT=FAIL mp launch from list: ' + mpWin); return; }
      /* 顺带确认壳页里真的把多人版客户端加载出来了（不是黑屏壳） */
      const mpInner = await (async () => {
        try {
          if (!deps.getGame() || deps.getGame().isDestroyed()) return 'gone';
          return await deps.getGame().webContents.executeJavaScript("(function(){ try{ var f=document.getElementById('game'); var d=f&&f.contentDocument; if(!d) return 'no-doc'; return (d.getElementById('mods')?'mods-ui':'no-mods') + '|canvas=' + (!!d.getElementById('c2canvas')); }catch(e){ return 'err:'+e.message; } })()");
        } catch (e) { return 'err:' + e.message; }
      })();
      console.log('[uitest] mp-launch-page=' + mpInner);
      if (!/canvas=true/.test(String(mpInner))) { finish(1, 'RESULT=FAIL mp launch page: ' + mpInner); return; }
      try { deps.windows.closeGame(); } catch (e) {}
      await js("(function(){ Array.from(document.querySelectorAll('[data-view]')).forEach(function(x){ if(x.dataset.view==='versions') x.click(); }); return 1; })()");
      deps.lanServices.stopServe();
      deps.lanServices.stopSignal();
      await sleep(500);

      finish(0, 'RESULT=UI-OK');
    } catch (e) {
      finish(1, 'RESULT=FAIL exception: ' + (e && e.stack || e));
    }
  })();

}

module.exports = { runUITest };
