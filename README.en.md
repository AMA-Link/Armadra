<div align="center">

<img src="./apps/web/public/icon.png" alt="Armadra" width="112" />

# Armadra

**Armadra is a local-first workspace for collaborative AI coding. Bring multiple coding agents onto one canvas to divide tasks, share context, and hand off work.**

[Download](https://github.com/AMA-Link/Armadra/releases/latest) · [Site and docs](https://armadra.com) · [中文](README.md)

</div>

---

Armadra puts real CLI agents (Claude Code, Codex, OpenCode, Pi, Oh My Pi, GitHub Copilot) on an infinite canvas as terminal nodes, each keeping its own account, model and permission policy. Links between nodes decide what context an agent may read; messages and handoffs organise the work. Notes, editors, Git diffs, files, browsers and whiteboard objects sit on the same canvas. Everything stays on your machine; a headless server shell serves the same core when you need multiple devices or shared workspaces.

This is a condensed version of the Chinese README; the full feature list, design notes and roadmap are there.

## Supported agents

Each CLI can be driven in two ways: **terminal mode** (the real CLI runs in a terminal node and reports state through a hook, extension or plugin) and the **ACP session view** (a chat view over the CLI's ACP adapter). "Tested" means an end-to-end scenario has been run against the real CLI and recorded; "untested" means the code was exercised only with a fake agent.

| CLI            | Terminal mode                                     | ACP session view                                                                   |
| -------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Claude Code    | tested                                            | tested (claude-agent-acp ≥ 0.85.1)                                                 |
| Codex          | tested                                            | untested (codex-acp)                                                               |
| OpenCode       | injection and status tested; e2e scenario not run | untested                                                                           |
| Pi             | tested                                            | session open and mode switch tested (ama's Pi bridge, Pi 1.5.0); full turn not run |
| Oh My Pi       | injection and status tested; e2e scenario not run | untested                                                                           |
| GitHub Copilot | injection and status tested; e2e scenario not run | untested; cannot resume a session                                                  |
| ama            | bundled with the desktop shell                    | untested                                                                           |

The ACP column follows [tools/release/compatibility.json](tools/release/compatibility.json) (`verified: null` means untested; probes record real runs there). The terminal column follows the [feature roadmap §4](docs/status/feature-roadmap.md). Custom agents can reuse the shape of any built-in CLI; see [agent collaboration](docs/guides/agent-collaboration.md).

## Install

Download the package for your platform from [GitHub Releases](https://github.com/AMA-Link/Armadra/releases/latest). macOS requires 13.3 or newer. Installation steps and system requirements are on [armadra.com/docs](https://armadra.com/docs/).

### First launch on macOS

Official macOS packages are ad-hoc signed and not notarized, so macOS blocks the first launch. On macOS 15 and later, open the app once, then go to System Settings → Privacy & Security and click "Open Anyway" (the old right-click → Open bypass no longer works); or run `xattr -dr com.apple.quarantine /Applications/Armadra.app`. A Homebrew install needs the same step. In-app updates keep working (run the app from Applications); Homebrew users can also run `brew upgrade --cask armadra`. See [macOS first launch](docs/guides/macos-first-launch.md) (Chinese).

## Run from source

Requires Node.js ≥ 24 and the pnpm version pinned by the project. tmux is recommended (falls back to a direct PTY when missing); macOS needs the Xcode Command Line Tools.

```sh
pnpm install
./armadra.sh doctor        # check the toolchain
./armadra.sh run desktop   # desktop shell with the core (hot reload)
./armadra.sh run web       # or: core + browser front end
```

Ports, environment variables, data locations and the server shell are covered in the [development guide](docs/guides/development.md); contribution rules are in [CONTRIBUTING.md](.github/CONTRIBUTING.md).

## License

[MIT License](LICENSE)
