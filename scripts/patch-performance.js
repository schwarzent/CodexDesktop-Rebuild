/**
 * 构建后补丁脚本：启动性能埋点 + Windows 启动关键路径优化（可开关）
 *
 * 设计目标：
 * - 不改功能：默认行为保持不变（除非显式开启 CODEX_DEFER_INIT 等开关）
 * - 可观测：用 jsonl 记录关键时间点，便于对比优化前后
 * - 幂等：重复执行不会重复注入
 *
 * 用法：
 *   node scripts/patch-performance.js          # 执行 patch
 *   node scripts/patch-performance.js --check  # 仅检查状态，不修改
 */

const fs = require("fs");
const path = require("path");

const PERF_MARKER = "/* codex-perf-patch:v1 */";
const WINDOW_MARKER = "codex-perf-window-hooks:v1";
const STARTUP_MARKER = "codex-perf-startup-defer:v1";
const DIAG_MARKER = "codex-perf-diagnostics:v1";
const PROCESS_MARKER = "codex-perf-process-errors:v1";

function locateMainBundle() {
  const repoRoot = path.join(__dirname, "..");
  const buildDir = path.join(repoRoot, "src", ".vite", "build");
  const entryFile = path.join(buildDir, "main.js");

  if (!fs.existsSync(entryFile)) {
    console.error("❌ 找不到主进程入口文件:", entryFile);
    process.exit(1);
  }

  const entry = fs.readFileSync(entryFile, "utf8");
  const match = entry.match(/require\(\s*["']\.\/(main-[^"']+\.js)["']\s*\)/);
  if (!match) {
    console.error("❌ 无法从 main.js 解析实际 bundle 文件名");
    console.error("   期望匹配: require(\"./main-<hash>.js\")");
    process.exit(1);
  }

  const bundleBasename = match[1];
  const bundleFile = path.join(buildDir, bundleBasename);
  if (!fs.existsSync(bundleFile)) {
    console.error("❌ 找不到主进程 bundle 文件:", bundleFile);
    process.exit(1);
  }

  return { repoRoot, buildDir, entryFile, bundleFile, bundleBasename };
}

function readFileUtf8(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function writeFileUtf8(filePath, contents) {
  fs.writeFileSync(filePath, contents, "utf8");
}

function hasMarker(contents, marker) {
  return contents.includes(marker);
}

function injectPerfHelpers(mainBundle) {
  if (hasMarker(mainBundle, PERF_MARKER)) return { changed: false, contents: mainBundle };

  const needle = "\"use strict\";";
  const idx = mainBundle.indexOf(needle);
  if (idx !== 0) {
    console.error("❌ 未找到预期的 bundle 头部 \"use strict\";");
    process.exit(1);
  }

  const injection = `${PERF_MARKER}
const __codexPerfConfig=(()=>{const enabled=!!process.env.CODEX_PERF_LOG&&process.env.CODEX_PERF_LOG!==\"0\";const deferInit=!!process.env.CODEX_DEFER_INIT&&process.env.CODEX_DEFER_INIT!==\"0\";const disableDevtoolsInstall=!!process.env.CODEX_DISABLE_DEVTOOLS_INSTALL&&process.env.CODEX_DISABLE_DEVTOOLS_INSTALL!==\"0\";const verbose=!!process.env.CODEX_PERF_LOG_STDERR&&process.env.CODEX_PERF_LOG_STDERR!==\"0\";const t0=typeof process.hrtime===\"function\"&&typeof process.hrtime.bigint===\"function\"?process.hrtime.bigint():null;let logFilePath=null;let pending=[];let flushTimer=null;function nowNs(){if(t0)return String(process.hrtime.bigint()-t0);return String(Date.now()*1e6)}function resolveLogFile(){if(logFilePath)return logFilePath;const p=require(\"path\"),os=require(\"os\"),fs=require(\"fs\");let dir=process.env.CODEX_PERF_LOG_DIR; if(!dir){try{const e=require(\"electron\");const a=e&&e.app;if(a&&typeof a.getPath===\"function\")dir=p.join(a.getPath(\"userData\"),\"perf\");}catch{}} if(!dir)dir=p.join(os.tmpdir(),\"codex-perf\");try{fs.mkdirSync(dir,{recursive:!0})}catch{}const name=process.env.CODEX_PERF_LOG_FILE_NAME||(\"perf-\"+process.pid+\".jsonl\");logFilePath=p.join(dir,name);return logFilePath}function flush(){flushTimer=null;if(pending.length===0)return;const fs=require(\"fs\");const out=pending.join(\"\\n\")+\"\\n\";pending=[];try{fs.appendFile(resolveLogFile(),out,()=>{})}catch{}}function mark(name,data){if(!enabled)return;const rec={t_ns:nowNs(),name, data:data??null, pid:process.pid};const line=JSON.stringify(rec);pending.push(line);if(verbose)try{process.stderr.write(line+\"\\n\")}catch{};if(!flushTimer)flushTimer=setTimeout(flush,50)}return{enabled,deferInit,disableDevtoolsInstall,mark}})();function __codexPerfMark(name,data){try{__codexPerfConfig.mark(name,data)}catch{}}
`;

  const out = needle + "\n" + injection + mainBundle.slice(needle.length);
  return { changed: true, contents: out };
}

function injectWindowHooks(mainBundle) {
  if (hasMarker(mainBundle, WINDOW_MARKER)) return { changed: false, contents: mainBundle };

  const needle =
    "devTools:this.options.allowDevtools}});(a===\"primary\"||a===\"hud\")&&y.on(\"page-title-updated\"";
  const idx = mainBundle.indexOf(needle);
  if (idx === -1) {
    console.error("❌ 未找到 BrowserWindow 创建后的注入点（版本可能变更）");
    process.exit(1);
  }

  const insertion = `devTools:this.options.allowDevtools}});/* ${WINDOW_MARKER} */__codexPerfMark(\"window.created\",{id:y.id,appearance:a,show:o});y.once(\"ready-to-show\",()=>__codexPerfMark(\"window.ready_to_show\",{id:y.id}));y.on(\"show\",()=>__codexPerfMark(\"window.show\",{id:y.id}));y.webContents.once(\"dom-ready\",()=>__codexPerfMark(\"webcontents.dom_ready\",{id:y.id}));y.webContents.once(\"did-finish-load\",()=>__codexPerfMark(\"webcontents.did_finish_load\",{id:y.id}));(a===\"primary\"||a===\"hud\")&&y.on(\"page-title-updated\"`;

  const out = mainBundle.slice(0, idx) + insertion + mainBundle.slice(idx + needle.length);
  return { changed: true, contents: out };
}

function injectWhenReadyOptimization(mainBundle) {
  if (hasMarker(mainBundle, STARTUP_MARKER)) return { changed: false, contents: mainBundle };

  const whenReadyStartNeedle = "U.app.whenReady().then(async()=>{";
  const whenReadyStartIdx = mainBundle.indexOf(whenReadyStartNeedle);
  if (whenReadyStartIdx === -1) {
    console.error("❌ 未找到 whenReady 代码块起点（版本可能变更）");
    process.exit(1);
  }

  const afterWhenReadyNeedle = "});U.app.on(\"activate\"";
  const afterWhenReadyIdx = mainBundle.indexOf(afterWhenReadyNeedle, whenReadyStartIdx);
  if (afterWhenReadyIdx === -1) {
    console.error("❌ 未找到 whenReady 代码块终点（版本可能变更）");
    process.exit(1);
  }

  const whenReadyBlockEnd = afterWhenReadyIdx + 3; // 包含 `});`，保留后续 `U.app.on(...)`

  const replacement = `U.app.whenReady().then(async()=>{/* ${STARTUP_MARKER} */__codexPerfMark(\"app.whenReady.begin\");if(ck.registerProtocolClient(),Cse(lB(Ip)),Xe.isInternal(dn))try{const{startAppliedDevboxCacheRefresher:t}=await Promise.resolve().then(()=>require(\"./applied-devbox-cache-CkiLfgk8.js\"));ar.add(t({codexHome:OB}))}catch(t){Zt().warning(\"Failed to start applied devbox cache refresher\",{message:xe(t)}),__codexPerfMark(\"appliedDevboxCacheRefresher.error\",{message:xe(t)})}const __codexDeferEnv=process.env.CODEX_DEFER_INIT;const __codexDefer=__codexDeferEnv==null?U.app.isPackaged:!(__codexDeferEnv===\"0\"||__codexDeferEnv===\"false\");if(__codexDefer){__codexPerfMark(\"startup.defer_init.enabled\",{packaged:U.app.isPackaged});try{__codexPerfMark(\"startup.primary_window.create.begin\",{hostId:Ot}),await Dc(Ot),__codexPerfMark(\"startup.primary_window.create.end\",{hostId:Ot})}catch(t){__codexPerfMark(\"startup.primary_window.create.error\",{message:xe(t)});throw t}setImmediate(async()=>{try{__codexPerfMark(\"startup.post_show_init.begin\");try{__codexPerfMark(\"sparkle.initialize.begin\"),await SS.initialize(),__codexPerfMark(\"sparkle.initialize.end\")}catch(t){Zt().warning(\"Sparkle initialize failed\",{message:xe(t)}),__codexPerfMark(\"sparkle.initialize.error\",{message:xe(t)})}try{__codexPerfMark(\"globalState.prune.begin\"),await Qle(eo),__codexPerfMark(\"globalState.prune.end\")}catch(t){Zt().warning(\"Global state prune failed\",{message:xe(t)}),__codexPerfMark(\"globalState.prune.error\",{message:xe(t)})}if(Dp&&!__codexPerfConfig.disableDevtoolsInstall)try{__codexPerfMark(\"devtools.install.begin\"),await _w.installExtension(_w.REACT_DEVELOPER_TOOLS,{loadExtensionOptions:{allowFileAccess:!0}}),__codexPerfMark(\"devtools.install.end\")}catch(t){Zt().warning(\"Failed to install React DevTools (\"+xe(t)+\")\"),__codexPerfMark(\"devtools.install.error\",{message:xe(t)})}try{__codexPerfMark(\"hosts.refresh.begin\"),await Np.refresh(),__codexPerfMark(\"hosts.refresh.end\")}catch(t){Zt().warning(\"Hosts refresh failed\",{message:xe(t)}),__codexPerfMark(\"hosts.refresh.error\",{message:xe(t)})}try{__codexPerfMark(\"deeplinks.flush.begin\"),await ck.flushPendingDeepLinks(),__codexPerfMark(\"deeplinks.flush.end\")}catch(t){Zt().warning(\"Deep links flush failed\",{message:xe(t)}),__codexPerfMark(\"deeplinks.flush.error\",{message:xe(t)})}__codexPerfMark(\"startup.post_show_init.end\")}catch(t){__codexPerfMark(\"startup.post_show_init.fatal\",{message:xe(t)})}});__codexPerfMark(\"app.whenReady.end\");return}await SS.initialize(),await Qle(eo),Dp&&!__codexPerfConfig.disableDevtoolsInstall&&_w.installExtension(_w.REACT_DEVELOPER_TOOLS,{loadExtensionOptions:{allowFileAccess:!0}}).catch(t=>{Zt().warning(\"Failed to install React DevTools (\"+xe(t)+\")\"),__codexPerfMark(\"devtools.install.error\",{message:xe(t)})}),await Np.refresh(),await Dc(Ot),await ck.flushPendingDeepLinks(),__codexPerfMark(\"app.whenReady.end\")});`;

  const out =
    mainBundle.slice(0, whenReadyStartIdx) +
    replacement +
    mainBundle.slice(whenReadyBlockEnd);
  return { changed: true, contents: out };
}

function injectDiagnosticsMarks(mainBundle) {
  if (hasMarker(mainBundle, DIAG_MARKER)) return { changed: false, contents: mainBundle };

  const installNeedle =
    "installWebContentsDiagnostics(e){const n=e.webContents,r=e.id,i=n.id,a=this.options.errorReporter;";
  if (!mainBundle.includes(installNeedle)) {
    console.error("❌ 未找到 installWebContentsDiagnostics 注入点（版本可能变更）");
    process.exit(1);
  }

  let out = mainBundle.replace(
    installNeedle,
    `${installNeedle}/* ${DIAG_MARKER} */__codexPerfMark(\"webcontents.diagnostics.install\",{windowId:r,webContentsId:i});`,
  );

  // 1) render-process-gone：记录原因与退出码
  out = out.replace(
    'n.on("render-process-gone",(o,s)=>{',
    'n.on("render-process-gone",(o,s)=>{__codexPerfMark("webcontents.render_process_gone",{windowId:r,webContentsId:i,reason:s.reason,exitCode:s.exitCode});',
  );

  // 2) did-finish-load：每次加载完成都记录（也用于 crash reload 后确认恢复）
  out = out.replace(
    'n.on("did-finish-load",()=>{this.rendererRecoveryAttempts.delete(i)}),',
    'n.on("did-finish-load",()=>{__codexPerfMark("webcontents.did_finish_load",{windowId:r,webContentsId:i});this.rendererRecoveryAttempts.delete(i)}),',
  );

  // 3) unresponsive：记录当前 URL
  out = out.replace(
    'n.on("unresponsive",()=>{',
    'n.on("unresponsive",()=>{__codexPerfMark("webcontents.unresponsive",{windowId:r,webContentsId:i,url:Wv(n.getURL())});',
  );

  // 4) did-fail-load：记录错误码与 URL（与 fatal report 对齐）
  out = out.replace(
    'n.on("did-fail-load",(o,s,c,u,l,p,d)=>{',
    'n.on("did-fail-load",(o,s,c,u,l,p,d)=>{__codexPerfMark("webcontents.did_fail_load",{windowId:r,webContentsId:i,errorCode:s,errorDescription:c,validatedURL:Wv(u)});',
  );

  // 5) crash recovery：记录触发 reload 的一次性恢复尝试
  out = out.replace(
    "setTimeout(()=>{if(!e.isDestroyed()&&!e.webContents.isDestroyed())try{e.webContents.reload()}",
    "setTimeout(()=>{__codexPerfMark(\"webcontents.crash_recover.reload\",{windowId:e.id,webContentsId:r.id,reason:n});if(!e.isDestroyed()&&!e.webContents.isDestroyed())try{e.webContents.reload()}",
  );

  const requiredSignals = [
    DIAG_MARKER,
    "webcontents.render_process_gone",
    "webcontents.did_finish_load",
    "webcontents.unresponsive",
    "webcontents.did_fail_load",
    "webcontents.crash_recover.reload",
  ];
  for (const signal of requiredSignals) {
    if (!out.includes(signal)) {
      console.error("❌ diagnostics patch 未完整注入，缺失标记:", signal);
      process.exit(1);
    }
  }

  return { changed: true, contents: out };
}

function injectProcessErrorMarks(mainBundle) {
  if (hasMarker(mainBundle, PROCESS_MARKER)) return { changed: false, contents: mainBundle };

  const needle =
    "function __codexPerfMark(name,data){try{__codexPerfConfig.mark(name,data)}catch{}}";
  const idx = mainBundle.indexOf(needle);
  if (idx === -1) {
    console.error("❌ 未找到 __codexPerfMark 注入点（perf helpers 可能缺失）");
    process.exit(1);
  }

  const injection = `${needle}/* ${PROCESS_MARKER} */process.on(\"uncaughtException\",t=>{__codexPerfMark(\"process.uncaught_exception\",{message:String(t&&t.stack||t)})});process.on(\"unhandledRejection\",t=>{__codexPerfMark(\"process.unhandled_rejection\",{message:String(t&&t.stack||t)})});`;

  const out = mainBundle.slice(0, idx) + injection + mainBundle.slice(idx + needle.length);
  return { changed: true, contents: out };
}

function main() {
  const isCheck = process.argv.includes("--check");
  const { repoRoot, bundleFile, bundleBasename } = locateMainBundle();
  const relBundle = path.relative(repoRoot, bundleFile);

  const original = readFileUtf8(bundleFile);
  const status = {
    hasPerfHelpers: hasMarker(original, PERF_MARKER),
    hasWindowHooks: hasMarker(original, WINDOW_MARKER),
    hasStartupOptimization: hasMarker(original, STARTUP_MARKER),
    hasDiagnosticsMarks: hasMarker(original, DIAG_MARKER),
    hasProcessErrorMarks: hasMarker(original, PROCESS_MARKER),
  };

  if (isCheck) {
    console.log("\n── performance patch 检查 (只读) ──\n");
    console.log(`  📄 ${relBundle}`);
    console.log(
      `     - perf helpers: ${status.hasPerfHelpers ? "✅ 已注入" : "🔧 未注入"}`,
    );
    console.log(
      `     - window hooks: ${status.hasWindowHooks ? "✅ 已注入" : "🔧 未注入"}`,
    );
    console.log(
      `     - startup defer: ${status.hasStartupOptimization ? "✅ 已注入" : "🔧 未注入"}`,
    );
    console.log(
      `     - diagnostics: ${status.hasDiagnosticsMarks ? "✅ 已注入" : "🔧 未注入"}`,
    );
    console.log(
      `     - process errors: ${
        status.hasProcessErrorMarks ? "✅ 已注入" : "🔧 未注入"
      }`,
    );
    return;
  }

  let changed = false;
  let contents = original;

  const perfResult = injectPerfHelpers(contents);
  changed = changed || perfResult.changed;
  contents = perfResult.contents;

  const windowResult = injectWindowHooks(contents);
  changed = changed || windowResult.changed;
  contents = windowResult.contents;

  const whenReadyResult = injectWhenReadyOptimization(contents);
  changed = changed || whenReadyResult.changed;
  contents = whenReadyResult.contents;

  const diagResult = injectDiagnosticsMarks(contents);
  changed = changed || diagResult.changed;
  contents = diagResult.contents;

  const processResult = injectProcessErrorMarks(contents);
  changed = changed || processResult.changed;
  contents = processResult.contents;

  if (!changed) {
    console.log(`ℹ️  ${bundleBasename} 已包含 performance patch, 无需修改`);
    return;
  }

  writeFileUtf8(bundleFile, contents);
  console.log(`✅ 已注入 performance patch: ${relBundle}`);
}

main();
