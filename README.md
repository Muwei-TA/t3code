<p align="center">
  <img src="./apps/web/public/icon-192x192.png" width="80" height="80" alt="Lightning Code logo" />
</p>

<h1 align="center">Lightning Code</h1>

<p align="center">Run coding agents on your machine and control them from desktop, web, or mobile.</p>

Lightning Code is an MIT-licensed fork of [T3 Code](https://github.com/pingdotgg/t3code). It adds the Lightning workspace and a portable Harness for sharing MCP servers across providers. It uses the coding agents you already have installed and signed in to, including Codex, Claude Code, Cursor, and [ACP-compatible agents](./docs/user/providers-acp.md).

Lightning uses the `lightning` command, port `3775`, and `~/.lightning-code` by default. It can run alongside T3 Code. Hosted cloud features, telemetry, and automatic updates are disabled by default.

## Install

When a release is available for your platform, get the desktop app or standalone CLI from [Lightning Code Releases](https://github.com/Muwei-TA/t3code/releases).

For the CLI on macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Muwei-TA/t3code/main/scripts/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/Muwei-TA/t3code/main/scripts/install.ps1 | iex
```

Run `lightning` to start the server and open the web app. Run `lightning up --lan` to enable connections from your local network, then `lightning pair` to generate a pairing link. Keep pairing links private.

## Build from source

Install [Vite+](https://viteplus.dev/guide/), then run:

```sh
git clone https://github.com/Muwei-TA/t3code.git
cd t3code
vp i
vp run dev
```

Open the URL printed by the dev server. Use `vp run dev:desktop` to work on the Electron app. See the [development runbook](./docs/operations/00_development.md) for prerequisites and build commands.

## Mobile

Build the Lightning client for iOS or Android using the [mobile development guide](./apps/mobile/README.md#development). Open the link from `lightning pair`, or scan its QR code from the client's connection screen. Review the server address in the pairing form before connecting.

To enable verified HTTPS thread links for a signed mobile build, configure your [link domain and signing identities](./apps/mobile/README.md#verified-thread-links).
Without a hosted link domain, copied thread links open in an installed Lightning app. In the web client, paste one into the composer to turn it into a thread reference.

## Contributing and license

See [CONTRIBUTING.md](./CONTRIBUTING.md) and the [architecture overview](./docs/internals/01_architecture.md).

[MIT](./LICENSE)
