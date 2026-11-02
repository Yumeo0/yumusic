# Tauri MCP development bridge

Clone with `--recurse-submodules`, or initialize the pinned upstream source:

```sh
git submodule update --init vendor/mcp-server-tauri
bun install --frozen-lockfile
bun run tauri dev
```

Bun's postinstall step applies `patches/tauri-mcp-bridge-tauri3.patch` to an
ignored copy of the Rust plugin under `src-tauri/.cache`. The upstream submodule
stays clean. `bun run setup:mcp` also prepares this copy without installing
dependencies; it uses Git to apply the patch and never downloads source.
Run it before invoking Cargo directly from a fresh checkout.

The patch adapts upstream 0.13.2 to YuMusic's Tauri 3 alpha dependencies and
type-erased native webview handles. Upstream's MIT license remains with the
source. To update, change the pinned submodule revision, refresh the patch,
and run `bun run setup:mcp` before testing.

The Bun Tauri wrapper enables the optional `mcp-bridge` Cargo feature only for
desktop `dev`. The bridge and its main-window capability are registered only
in debug builds, on `127.0.0.1:9223` (or the next available port). Production
and mobile builds do not enable it. The global Tauri API is enabled only for
debug builds with the bridge feature.

Configure an MCP-compatible client with the Tauri MCP server using the
[upstream setup instructions](https://github.com/hypothesi/mcp-server-tauri).
Connect its driver session and use its webview tools against the running
development app. Restart the client session if it does not discover the server.
