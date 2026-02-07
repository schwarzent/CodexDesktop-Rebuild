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

function findBindingGypPath() {
  return path.join(__dirname, "..", "node_modules", "node-pty", "binding.gyp");
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

  const bindingGypPath = findBindingGypPath();
  if (!fs.existsSync(bindingGypPath)) {
    console.warn("⚠️  未找到 node-pty/binding.gyp，跳过:", bindingGypPath);
    return;
  }

  const source = fs.readFileSync(bindingGypPath, "utf-8");
  const hasSpectre = source.includes("SpectreMitigation") && source.includes("'Spectre'");

  if (isCheck) {
    console.log(`📄 检查文件: ${path.relative(path.join(__dirname, ".."), bindingGypPath)}`);
    console.log(hasSpectre ? "🔧 发现 SpectreMitigation 配置（将被移除）" : "✅ 未发现 SpectreMitigation 配置");
    return;
  }

  if (!hasSpectre) {
    console.log("ℹ️  node-pty 已无 SpectreMitigation 配置，无需修改");
    return;
  }

  const { changed, code } = removeSpectreBlock(source);
  if (!changed) {
    console.warn("⚠️  检测到 SpectreMitigation，但未匹配到可移除的配置块（node-pty 结构可能变化）");
    process.exit(1);
  }

  fs.writeFileSync(bindingGypPath, code);
  console.log("✅ 已移除 node-pty Windows SpectreMitigation 配置:", bindingGypPath);
}

main();

