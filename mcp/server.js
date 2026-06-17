#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * MCP stdio server. Each tool is a thin proxy to the Debug Bridge extension's
 * local HTTP API (default http://127.0.0.1:39517).
 *
 * Works with any MCP client (Claude Code, Codex, Cline, ...). The extension
 * must be running inside VSCode, and a debug session attached via the
 * `debug_attach` tool (which triggers a launch config). Debugger-agnostic:
 * drives Unity vstuc, Python debugpy, Node, C++ cppdbg, etc.
 */

const PORT = process.env.DEBUG_BRIDGE_PORT || "39517";
const BASE = `http://127.0.0.1:${PORT}`;

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(
      `Cannot reach Debug Bridge at ${BASE} — is VSCode open with the ` +
        `extension installed and active? (${e.message})`
    );
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(json.error || `HTTP ${res.status}`);
  }
  return json;
}

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({
  name: "vscode-debug-bridge",
  version: "0.1.0",
});

server.tool(
  "debug_status",
  "Get the current debug session status: whether a session is attached, " +
    "whether it is stopped at a breakpoint, the current thread, and breakpoint count.",
  {},
  async () => ok(await call("GET", "/status"))
);

server.tool(
  "debug_attach",
  "Start a debug session by launching a VSCode launch configuration by name " +
    "(e.g. 'Attach to Unity', 'Python: Current File'). Run once before stepping.",
  { config: z.string().optional().describe("Launch config name (default 'Attach to Unity')") },
  async ({ config }) => ok(await call("POST", "/attach", { config }))
);

server.tool(
  "debug_detach",
  "Stop / detach the active debug session.",
  {},
  async () => ok(await call("POST", "/detach"))
);

server.tool(
  "debug_set_breakpoint",
  "Set a source breakpoint at an absolute file path and 1-based line number. " +
    "Optionally a conditional expression.",
  {
    file: z.string().describe("Absolute path to the source file"),
    line: z.number().int().positive().describe("1-based line number"),
    condition: z.string().optional().describe("Optional breakpoint condition"),
  },
  async ({ file, line, condition }) =>
    ok(await call("POST", "/breakpoints/add", { file, line, condition }))
);

server.tool(
  "debug_list_breakpoints",
  "List all currently set source breakpoints.",
  {},
  async () => ok(await call("GET", "/breakpoints"))
);

server.tool(
  "debug_clear_breakpoints",
  "Remove breakpoints. Pass a file path to clear only that file, or omit to clear all.",
  { file: z.string().optional().describe("Absolute file path; omit to clear all") },
  async ({ file }) => ok(await call("POST", "/breakpoints/clear", { file }))
);

server.tool(
  "debug_continue",
  "Resume execution (continue) from the current breakpoint.",
  {},
  async () => ok(await call("POST", "/control", { command: "continue" }))
);

server.tool(
  "debug_step_over",
  "Step over the current line (DAP 'next').",
  {},
  async () => ok(await call("POST", "/control", { command: "stepOver" }))
);

server.tool(
  "debug_step_in",
  "Step into the call on the current line.",
  {},
  async () => ok(await call("POST", "/control", { command: "stepIn" }))
);

server.tool(
  "debug_step_out",
  "Step out of the current function.",
  {},
  async () => ok(await call("POST", "/control", { command: "stepOut" }))
);

server.tool(
  "debug_pause",
  "Pause the running program.",
  {},
  async () => ok(await call("POST", "/control", { command: "pause" }))
);

server.tool(
  "debug_stack",
  "Get the current call stack (only meaningful when stopped at a breakpoint). " +
    "Frame ids returned here can be passed to variables / evaluate.",
  {},
  async () => ok(await call("GET", "/stack"))
);

server.tool(
  "debug_variables",
  "Get local variables and scopes for a stack frame (defaults to the top frame). " +
    "Variables with a non-zero variablesReference can be expanded with debug_expand.",
  { frameId: z.number().int().optional().describe("Frame id from debug_stack") },
  async ({ frameId }) => ok(await call("POST", "/variables", { frameId }))
);

server.tool(
  "debug_expand",
  "Expand a structured variable (object/array) by its variablesReference.",
  { variablesReference: z.number().int().positive() },
  async ({ variablesReference }) =>
    ok(await call("POST", "/variables/expand", { variablesReference }))
);

server.tool(
  "debug_evaluate",
  "Evaluate an expression in the context of a stack frame (defaults to top frame).",
  {
    expression: z.string(),
    frameId: z.number().int().optional().describe("Frame id from debug_stack"),
  },
  async ({ expression, frameId }) =>
    ok(await call("POST", "/evaluate", { expression, frameId }))
);

const transport = new StdioServerTransport();
await server.connect(transport);
