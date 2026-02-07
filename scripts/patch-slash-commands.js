/**
 * 构建后补丁脚本：在 Electron 桌面端启用 Slash Commands（输入 / 弹出指令菜单）
 *
 * 背景：
 * Codex 上游通过 Statsig gate `codex-extension-slash-commands` 控制 slash commands。
 * 在本跨平台 Electron 版中，该 gate 往往为 false，导致输入框输入 “/” 无法触发指令菜单。
 *
 * 策略：
 * 将 `const <gateEnabled> = useGateValue("codex-extension-slash-commands")` 的 init 替换为：
 *   (useGateValue("codex-extension-slash-commands") || window.codexWindowType==="electron")
 *
 * 这样：
 * - 当 gate 为 true（例如某些环境/账户）→ 保持原行为
 * - 当 gate 为 false 但运行在 Electron → 强制启用
 *
 * 用法：
 *   node scripts/patch-slash-commands.js          # 执行 patch
 *   node scripts/patch-slash-commands.js --check  # 仅检查匹配情况，不修改
 */

const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");

// ──────────────────────────────────────────────
//  第 1 层：AST 引擎 — 解析 + 递归遍历
// ──────────────────────────────────────────────

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item.type === "string") {
          walk(item, visitor);
        }
      }
    } else if (child && typeof child.type === "string") {
      walk(child, visitor);
    }
  }
}

function getPropertyName(memberExpr) {
  if (!memberExpr || !memberExpr.property) return null;
  if (!memberExpr.computed && memberExpr.property.type === "Identifier") {
    return memberExpr.property.name;
  }
  if (memberExpr.computed && memberExpr.property.type === "Literal") {
    return memberExpr.property.value;
  }
  return null;
}

// ──────────────────────────────────────────────
//  第 2 层：声明式 Patch 规则
// ──────────────────────────────────────────────

const GATE_NAME = "codex-extension-slash-commands";
const ELECTRON_FORCE_EXPR = 'window.codexWindowType==="electron"';

const RULES = [
  {
    id: "enable_slash_commands_in_electron",
    description: `useGateValue("${GATE_NAME}") → (call || ${ELECTRON_FORCE_EXPR})`,
    /**
     * 匹配条件：
     * - VariableDeclarator.init 是 CallExpression
     * - callee 是 MemberExpression，property.name === "useGateValue"
     * - arguments[0] 是 Literal "${GATE_NAME}"
     *
     * 替换范围：
     * - 只替换 init（而非整个声明），保证幂等：
     *   首次 patch 后 init 会变为 LogicalExpression，不再命中本规则
     */
    match(node, source) {
      if (node.type !== "VariableDeclarator") return null;
      const init = node.init;
      if (!init || init.type !== "CallExpression") return null;

      const callee = init.callee;
      if (!callee || callee.type !== "MemberExpression") return null;
      if (getPropertyName(callee) !== "useGateValue") return null;

      const args = init.arguments;
      if (!args || args.length < 1) return null;
      if (args[0].type !== "Literal" || args[0].value !== GATE_NAME) return null;

      const original = source.slice(init.start, init.end);
      if (original.includes("window.codexWindowType")) return null;

      return {
        start: init.start,
        end: init.end,
        replacement: `(${original}||${ELECTRON_FORCE_EXPR})`,
        original,
      };
    },
  },
];

// ──────────────────────────────────────────────
//  第 3 层：文件定位 + 外科替换
// ──────────────────────────────────────────────

function locateBundle() {
  const assetsDir = path.join(__dirname, "..", "src", "webview", "assets");
  if (!fs.existsSync(assetsDir)) {
    console.error("❌ 资源目录不存在:", assetsDir);
    process.exit(1);
  }

  const files = fs.readdirSync(assetsDir).filter((f) => /^index-.*\.js$/.test(f));

  if (files.length === 0) {
    console.error("❌ 未找到 index-*.js bundle 文件");
    process.exit(1);
  }
  if (files.length > 1) {
    console.error("❌ 发现多个 index-*.js 文件:", files.join(", "));
    process.exit(1);
  }

  return path.join(assetsDir, files[0]);
}

function collectPatches(ast, source) {
  const patches = [];
  const details = [];
  const seen = new Set();

  walk(ast, (node) => {
    for (const rule of RULES) {
      const result = rule.match(node, source);
      if (result && !seen.has(result.start)) {
        seen.add(result.start);
        patches.push({ ...result, ruleId: rule.id });
        details.push({
          ruleId: rule.id,
          position: result.start,
          change: `${result.original} → ${result.replacement}`,
        });
      }
    }
  });

  return { patches, details };
}

function scanMatches(ast, source) {
  const CONTEXT_CHARS = 60;
  const matches = [];
  const seen = new Set();

  walk(ast, (node) => {
    for (const rule of RULES) {
      const result = rule.match(node, source);
      if (result && !seen.has(result.start)) {
        seen.add(result.start);
        const ctxStart = Math.max(0, result.start - CONTEXT_CHARS);
        const ctxEnd = Math.min(source.length, result.end + CONTEXT_CHARS);
        matches.push({
          ruleId: rule.id,
          position: result.start,
          original: result.original,
          context: source.slice(ctxStart, ctxEnd),
          wouldPatch: true,
        });
      }
    }
  });

  return { matches };
}

function countAllOccurrences(source) {
  let total = 0;
  let idx = -1;
  const needle = `"${GATE_NAME}"`;
  while ((idx = source.indexOf(needle, idx + 1)) !== -1) {
    total++;
  }
  return total;
}

// ──────────────────────────────────────────────
//  主流程
// ──────────────────────────────────────────────

function main() {
  const isCheck = process.argv.includes("--check");
  const bundlePath = locateBundle();
  const relPath = path.relative(path.join(__dirname, ".."), bundlePath);

  console.log(`📄 目标文件: ${relPath}`);

  const source = fs.readFileSync(bundlePath, "utf-8");
  console.log(`📏 文件大小: ${(source.length / 1024 / 1024).toFixed(1)} MB`);

  const t0 = Date.now();
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
  });
  const parseTime = Date.now() - t0;
  console.log(`🔍 AST 解析: ${parseTime}ms`);

  if (isCheck) {
    console.log("\n── 匹配检查 (只读) ──\n");
    const { matches } = scanMatches(ast, source);
    const totalRefs = countAllOccurrences(source);

    if (matches.length === 0) {
      console.log(`📊 共 ${totalRefs} 处 "${GATE_NAME}" 引用, 0 处待 patch`);
      if (totalRefs === 0) {
        console.warn(`⚠️  未找到 "${GATE_NAME}" gate 引用`);
        return;
      }
      if (source.includes(ELECTRON_FORCE_EXPR)) {
        console.log("✅ Slash commands gate 已为 Electron 启用");
      } else {
        console.log("ℹ️  未发现待 patch 位置（可能已启用或代码结构变化）");
      }
      return;
    }

    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      console.log(`  #${i + 1}  [${m.ruleId}]  🔧 待 patch`);
      console.log(`      位置: ${m.position}`);
      console.log(`      原始: ${m.original}`);
      console.log(`      上下文: ...${m.context}...`);
      console.log();
    }
    console.log(`📊 共 ${totalRefs} 处 "${GATE_NAME}" 引用, ${matches.length} 处待 patch`);
    return;
  }

  const { patches, details } = collectPatches(ast, source);

  if (patches.length === 0) {
    const totalRefs = countAllOccurrences(source);
    if (totalRefs === 0) {
      console.warn(`⚠️  未找到 "${GATE_NAME}" gate 引用`);
      return;
    }
    if (source.includes(ELECTRON_FORCE_EXPR)) {
      console.log(`ℹ️  Slash commands 已启用 (${totalRefs} 处引用, 0 处待 patch), 无需修改`);
      return;
    }
    console.warn(
      `⚠️  检测到 ${totalRefs} 处 "${GATE_NAME}" 引用，但未匹配到可 patch 结构（可能上游代码结构变化）`
    );
    process.exit(1);
  }

  patches.sort((a, b) => b.start - a.start);

  let code = source;
  for (const p of patches) {
    code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
  }

  fs.writeFileSync(bundlePath, code);

  for (const d of details) {
    console.log(`  ✏️  位置 ${d.position}: ${d.change}`);
  }
  console.log(`\n✅ Slash commands 已为 Electron 启用: ${patches.length} 处 gate init 已 patch`);
}

main();

