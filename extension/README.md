# VSCode Debug Bridge (extension)

Exposes the active VSCode debug session over a localhost HTTP API
(`127.0.0.1:39517` by default) so an AI agent can drive step debugging via MCP.

See the full setup and usage guide in the `tools/debug-bridge/README.md` of the
repository.

Commands:

- **Debug Bridge: Show Status**
- **Debug Bridge: Restart HTTP Server**

Setting: `debugBridge.port` (default `39517`).
