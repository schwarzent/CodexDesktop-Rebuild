# Codex Desktop Rebuild

Cross-platform Electron build for OpenAI Codex Desktop App.

## Supported Platforms

| Platform | Architecture | Status |
|----------|--------------|--------|
| macOS    | x64, arm64   | ✅     |
| Windows  | x64          | ✅     |
| Linux    | x64, arm64   | ✅     |

## Build

```bash
# Install dependencies
npm install

# Build for current platform
npm run build

# Build for specific platform
npm run build:mac-x64
npm run build:mac-arm64
npm run build:win-x64
npm run build:linux-x64
npm run build:linux-arm64

# Build all platforms
npm run build:all
```

## Development

```bash
npm run dev
```

## Performance / Stability

This repo includes a post-build patch script (`scripts/patch-performance.js`) that:
- Adds lightweight startup timing marks (JSONL) when `CODEX_PERF_LOG=1`
- Defers non-critical startup work to improve first window availability (enabled by default for packaged builds)
- Adds additional diagnostics marks for renderer crashes/unresponsiveness (only when perf log is enabled)

Environment variables:
- `CODEX_PERF_LOG=1`: enable perf JSONL logs
- `CODEX_PERF_LOG_DIR=<dir>`: override log directory (default: `<userData>/perf` when available)
- `CODEX_PERF_LOG_FILE_NAME=<name>`: override log file name (default: `perf-<pid>.jsonl`)
- `CODEX_PERF_LOG_STDERR=1`: also print JSONL to stderr
- `CODEX_DEFER_INIT=0|1`: override startup deferral (`0` disables, `1` enables). If unset, packaged builds defer init by default.
- `CODEX_DISABLE_DEVTOOLS_INSTALL=1`: skip devtools extension install (mainly for dev builds)

## Project Structure

```
├── src/
│   ├── .vite/build/     # Main process (Electron)
│   └── webview/         # Renderer (Frontend)
├── resources/
│   ├── electron.icns    # App icon
│   └── notification.wav # Sound
├── scripts/
│   └── patch-copyright.js
├── forge.config.js      # Electron Forge config
└── package.json
```

## CI/CD

GitHub Actions automatically builds on:
- Push to `master`
- Tag `v*` → Creates draft release

## Credits

**© OpenAI · Cometix Space**

- [OpenAI Codex](https://github.com/openai/codex) - Original Codex CLI (Apache-2.0)
- [Cometix Space](https://github.com/Haleclipse) - Cross-platform rebuild & [@cometix/codex](https://www.npmjs.com/package/@cometix/codex) binaries
- [Electron Forge](https://www.electronforge.io/) - Build toolchain

## License

This project rebuilds the Codex Desktop app for cross-platform distribution.
Original Codex CLI by OpenAI is licensed under Apache-2.0.
