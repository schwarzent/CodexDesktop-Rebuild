<#
  一键编译 Windows 安装包（Squirrel）+ ZIP 便携包。

  设计目标（面向新手）：
  - 解决 out\Codex-win32-x64 被运行中的 Codex.exe 占用导致 EBUSY 的问题
  - 解决路径包含中文导致 rcedit 修改 Setup.exe 失败的问题（使用 subst 映射到纯盘符路径）
  - 构建结束后自动把 build 过程中产生的 patch 改动 stash 掉，保持工作区干净

  用法：
    1) PowerShell 中运行：
       pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/build-win-oneclick.ps1
    2) 或直接双击运行 scripts\build-win-oneclick.cmd
#>

param(
  # 指定用于 subst 的盘符（例如 "X" 或 "X:"）。不指定则自动选空闲盘符（默认优先 Z/Y/X/...）。
  [string]$SubstDrive = "",
  # 禁用 subst（不推荐；当仓库路径含中文时，可能再次触发 rcedit 失败）。
  [switch]$NoSubst
)

$ErrorActionPreference = "Stop"

function Write-Info([string]$Message) {
  Write-Host $Message
}

function Fail([string]$Message, [int]$ExitCode = 1) {
  Write-Error $Message
  exit $ExitCode
}

function Get-RepoRoot {
  # 当前脚本位于 <repo>\scripts\，仓库根目录即其父目录
  $root = Resolve-Path (Join-Path $PSScriptRoot "..")
  return $root.Path
}

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Fail "❌ 未找到命令：$Name。请先安装/配置后再运行。"
  }
}

function Assert-CleanWorkingTree([string]$RepoRoot) {
  Push-Location $RepoRoot
  try {
    $porcelain = git status --porcelain
    if ($porcelain) {
      Fail "❌ 工作区不干净（存在未提交改动）。请先 commit 或 stash，再运行一键编译脚本。" 2
    }
  } finally {
    Pop-Location
  }
}

function Stop-OutCodexProcesses([string]$RepoRoot) {
  $pattern = "*\out\Codex-win32-x64\Codex.exe"
  $processes = Get-Process Codex -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like $pattern }

  if ($processes) {
    Write-Info "🛑 发现正在运行的 out\\Codex-win32-x64\\Codex.exe，尝试结束进程以解除目录占用..."
    $processes | Stop-Process -Force
    Write-Info "✅ 已结束 $($processes.Count) 个进程"
  }
}

function Remove-OutAppDir([string]$RepoRoot) {
  $dir = Join-Path $RepoRoot "out\Codex-win32-x64"
  if (Test-Path $dir) {
    Write-Info "🧹 删除旧目录：out\\Codex-win32-x64"
    Remove-Item $dir -Recurse -Force
  }
}

function Select-FreeDriveLetter([string]$Preferred = "") {
  $used = (Get-PSDrive -PSProvider FileSystem).Name

  if ($Preferred) {
    $p = $Preferred.Trim().TrimEnd(":").ToUpper()
    if ($p.Length -eq 1 -and ($used -notcontains $p)) {
      return $p
    }
  }

  $candidates = @("Z","Y","X","W","V","U","T","S","R")
  foreach ($c in $candidates) {
    if ($used -notcontains $c) { return $c }
  }

  return ""
}

function Create-SubstDrive([string]$RepoRoot, [string]$DriveLetter) {
  $drive = "$DriveLetter`:"
  Write-Info "🔗 subst $drive -> $RepoRoot"
  subst $drive $RepoRoot | Out-Null
  return "$DriveLetter`:\"
}

function Remove-SubstDrive([string]$DriveLetter) {
  if (-not $DriveLetter) { return }
  $drive = "$DriveLetter`:"
  subst $drive /D | Out-Null
}

function Stash-BuildPatchesIfNeeded([string]$RepoRoot) {
  Push-Location $RepoRoot
  try {
    $porcelain = git status --porcelain
    if ($porcelain) {
      Write-Info "📦 检测到构建过程产生的改动，stash 以保持工作区干净..."
      git stash push -u -m "one-click build temporary patches" | Out-Null
      Write-Info "✅ 已 stash"
    }
  } finally {
    Pop-Location
  }
}

function Print-Artifacts([string]$RepoRoot) {
  $squirrelDir = Join-Path $RepoRoot "out\make\squirrel.windows\x64"
  $zipDir = Join-Path $RepoRoot "out\make\zip\win32\x64"

  $setup = Get-ChildItem $squirrelDir -Filter "*Setup.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  $zip = Get-ChildItem $zipDir -Filter "*.zip" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if ($setup) {
    Write-Info "📌 安装程序：$($setup.FullName)"
  } else {
    Write-Info "⚠️ 未找到安装程序（out\\make\\squirrel.windows\\x64\\*Setup.exe）"
  }

  if ($zip) {
    Write-Info "📌 ZIP 便携包：$($zip.FullName)"
  } else {
    Write-Info "⚠️ 未找到 ZIP 包（out\\make\\zip\\win32\\x64\\*.zip）"
  }
}

$repoRoot = Get-RepoRoot
Set-Location $repoRoot

Assert-Command "git"
Assert-Command "npm"

Assert-CleanWorkingTree $repoRoot
Stop-OutCodexProcesses $repoRoot
Remove-OutAppDir $repoRoot

$driveLetter = ""
$buildCwd = $repoRoot

try {
  if (-not $NoSubst) {
    $driveLetter = Select-FreeDriveLetter $SubstDrive
    if (-not $driveLetter) {
      Fail "❌ 未找到可用盘符用于 subst，请释放一个盘符后重试。"
    }
    $buildCwd = Create-SubstDrive $repoRoot $driveLetter
  }

  Set-Location $buildCwd
  Write-Info "🚀 开始构建：npm run build:win-x64"
  npm run build:win-x64
  Write-Info "✅ 构建完成"
} finally {
  # 始终返回仓库根目录，并清理 subst 映射
  Set-Location $repoRoot
  if ($driveLetter) {
    Remove-SubstDrive $driveLetter
  }
}

Stash-BuildPatchesIfNeeded $repoRoot
Print-Artifacts $repoRoot

