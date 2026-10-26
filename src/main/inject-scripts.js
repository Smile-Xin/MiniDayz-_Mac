'use strict';
/**
 * inject-scripts —— 注入到游戏页的脚本片段（纯字符串，不含逻辑）
 *
 * 为什么要「动态注入」而不是改游戏文件：版本包升级/替换后注入会丢，
 * 而这些能力（存档隔离、按键映射、画面缩放）属于启动器的职责。
 * 注入点分两类：
 *   1) 主进程 dom-ready 时 executeJavaScript（direct 直开窗口的顶层页面）
 *   2) 协议层改写 HTML（壳页 iframe 内的游戏页，见 protocol.js）
 */

/**
 * 键盘映射器加载器：先装默认方案 preset，再装 mapper。
 * mapper 通过 app://game/_launcher/ 提供，与启动器同源 → 升级启动器即更新映射逻辑，无需重导入版本。
 */
const MAPPER_LOADER = `(function(){
  try {
    if (document.getElementById('mdz-web-mapper')) return;
    if (!document.getElementById('mdz-keymap-preset')) {
      var p = document.createElement('script');
      p.id = 'mdz-keymap-preset';
      p.src = 'app://game/_launcher/mdz-keymap-preset.js';
      (document.head || document.documentElement).appendChild(p);
    }
    var s = document.createElement('script');
    s.id = 'mdz-web-mapper';
    s.src = 'app://game/_launcher/mapper.js';
    (document.head || document.documentElement).appendChild(s);
  } catch(e) {}
})();`;

/**
 * IndexedDB 存档隔离补丁（direct 直开窗口版）。
 * 所有版本共用 app://game 同源，靠给库名加 `_<dbKey>` 后缀实现存档隔离。
 * 壳页 iframe 版由 protocol.js 在 HTML 响应里注入（时机必须更早：C2 在解析阶段就会 open）。
 */
const DBKEY_PATCH = `(function(){
  try {
    if (document.getElementById('mdz-dbkey-patch')) return;
    var m = (location.search || '').match(/[?&]dbKey=([^&]+)/);
    var k = m ? decodeURIComponent(m[1]) : '';
    if (!k) return;
    var s = '_' + k;
    var o = window.indexedDB.open.bind(window.indexedDB);
    window.indexedDB.open = function(n, v) {
      if (n && typeof n === 'string' && !n.endsWith(s)) return o(n + s, v);
      return o(n, v);
    };
  } catch(e) {}
})();`;

/**
 * 画面等比铺满：把 #c2canvas 按 min(窗口/逻辑分辨率) 缩放并居中。
 * 旧实现靠 CSS width:auto，但 canvas 的 inline style 优先级更高导致失效
 * （全屏后画面只剩左上角一小块）。Canvas 事件用本地坐标系，缩放后点击仍然准确。
 */
function scaleFitScript(logicalWidth, logicalHeight) {
  const lw = logicalWidth || 1280;
  const lh = logicalHeight || 720;
  return '(function(){try{var s=document.getElementById(\'mdz-scale-css\');if(!s){s=document.createElement(\'style\');s.id=\'mdz-scale-css\';(document.head||document.documentElement).appendChild(s);}s.textContent=\'html,body{overflow:hidden!important;margin:0!important;background:#000!important;}#c2canvas{margin:0!important;max-width:none!important;max-height:none!important;}\';' +
    'var fit=function(){var cv=document.getElementById("c2canvas");if(!cv)return;' +
    'var iw=window.innerWidth||document.documentElement.clientWidth;var ih=window.innerHeight||document.documentElement.clientHeight;' +
    'var k=Math.min(iw/' + lw + ',ih/' + lh + ');if(!(k>0)||!isFinite(k))k=1;' +
    'var tx=(iw-' + lw + '*k)/2,ty=(ih-' + lh + '*k)/2;' +
    "cv.style.transformOrigin='0 0';cv.style.transform='translate('+tx+'px,'+ty+'px) scale('+k+')';};" +
    'fit();window.addEventListener("resize",fit);window.__mdzScaleFit=fit;' +
    'if(window.__mdzScaleFitT){clearTimeout(window.__mdzScaleFitT);}window.__mdzScaleFitT=setTimeout(fit,900);' +
    '}catch(e){}})()';
}

/** 撤销 scaleFitScript：移除样式、解绑 resize、清掉 canvas transform */
const SCALE_RESET_SCRIPT = '(function(){try{var s=document.getElementById(\'mdz-scale-css\');if(s)s.remove();' +
  'if(window.__mdzScaleFit){window.removeEventListener("resize",window.__mdzScaleFit);window.__mdzScaleFit=null;}' +
  "var cv=document.getElementById('c2canvas');if(cv)cv.style.transform='';}catch(e){}})()";

module.exports = {
  MAPPER_LOADER,
  DBKEY_PATCH,
  scaleFitScript,
  SCALE_RESET_SCRIPT
};
