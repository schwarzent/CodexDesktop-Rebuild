/**
 * 构建/打包前补丁：禁用 node-pty 在 Windows 下强制 SpectreMitigation
 *
 * 背景：
 * node-pty 的 binding.gyp 在 Windows 上声明了：
 *   msvs_configuration_attributes: { SpectreMitigation: 'Spectre' }
 * 这会导致 MSBuild 依赖 “Spectre-mitigated libs”，未安装该 VS 组件时打包会失败（MSB8040）。
 *
 * 策略：
 * - 在 Windows（win32）环境下，删除上述 msvs_configuration_attributes 块。
 * - 该改动只影响本地 node_modules（不提交到 git），并且幂等。
 *
 * 用法：
 *   node scripts/patch-node-pty-spectre.js          # 执行 patch
 *   node scripts/patch-node-pty-spectre.js --check  # 仅检查，不修改
 */

const fs = require("fs");
const path = require("path");

function findNodePtyBindingGypPath() {
  return path.join(__dirname, "..", "node_modules", "node-pty", "binding.gyp");
}

function findWinptyGypPath() {
  return path.join(
    __dirname,
    "..",
    "node_modules",
    "node-pty",
    "deps",
    "winpty",
    "src",
    "winpty.gyp",
  );
}

function removeSpectreBlock(source) {
  const lines = source.split(/\r?\n/);
  const out = [];

  let isSkipping = false;
  let removed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!isSkipping && line.includes("'msvs_configuration_attributes'")) {
      // 开始跳过直到遇到关闭的 "},"
      isSkipping = true;
      removed = true;
      continue;
    }

    if (isSkipping) {
      if (/^\s*},\s*$/.test(line)) {
        isSkipping = false;
      }
      continue;
    }

    out.push(line);
  }

  return { changed: removed, code: out.join("\n") };
}

function main() {
  const isCheck = process.argv.includes("--check");

  if (process.platform !== "win32") {
    console.log("ℹ️  非 Windows 环境，跳过 node-pty Spectre 补丁");
    return;
  }

  const repoRoot = path.join(__dirname, "..");
  const targets = [
    { name: "node-pty/binding.gyp", path: findNodePtyBindingGypPath() },
    { name: "node-pty/deps/winpty/src/winpty.gyp", path: findWinptyGypPath() },
  ];

  let foundAny = false;
  let patchedAny = false;

  for (const target of targets) {
    if (!fs.existsSync(target.path)) {
      console.warn("⚠️  未找到文件，跳过:", target.name);
      continue;
    }

    const source = fs.readFileSync(target.path, "utf-8");
    const hasSpectre = source.includes("SpectreMitigation") && source.includes("'Spectre'");
    if (hasSpectre) foundAny = true;

    if (isCheck) {
      console.log(`📄 检查文件: ${path.relative(repoRoot, target.path)}`);
      console.log(hasSpectre ? "🔧 发现 SpectreMitigation 配置（将被移除）" : "✅ 未发现 SpectreMitigation 配置");
      continue;
    }

    if (!hasSpectre) continue;

    const { changed, code } = removeSpectreBlock(source);
    if (!changed) {
      console.warn(`⚠️  检测到 SpectreMitigation，但未匹配到可移除的配置块: ${target.name}`);
      process.exit(1);
    }

    fs.writeFileSync(target.path, code);
    patchedAny = true;
    console.log("✅ 已移除 Windows SpectreMitigation 配置:", target.name);
  }

  if (isCheck) return;

  if (!foundAny) {
    console.log("ℹ️  未发现 SpectreMitigation 配置，无需修改");
    return;
  }

  if (!patchedAny) {
    console.log("ℹ️  SpectreMitigation 已被移除，无需修改");
  }
}

main();
