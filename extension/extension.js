const vscode = require("vscode");
const http = require("http");

/**
 * VSCode Debug Bridge
 *
 * Exposes the *active* VSCode debug session over a tiny localhost HTTP API.
 * An MCP server (see ../mcp/server.js) translates agent tool calls into
 * requests against this API, giving the agent control over step debugging for
 * ANY DAP-based debugger (Unity vstuc, Python debugpy, Node, C++ cppdbg, ...).
 *
 * Everything goes through vscode.debug, so we reuse whatever debug adapter the
 * relevant language extension already provides — no protocol reimplementation.
 */

let server = null;
let output = null;

// Live debugger state, kept up to date by a DebugAdapterTracker.
const state = {
  stopped: false,
  threadId: null,
  reason: null,
  sessionName: null,
};

function log(msg) {
  if (output) output.appendLine(`[${nowLabel()}] ${msg}`);
}

// Date.now is fine inside a normal extension host (not a workflow sandbox).
function nowLabel() {
  return new Date().toISOString().slice(11, 19);
}

function activeSession() {
  return vscode.debug.activeDebugSession || null;
}

/** Resolve the workspace folder that owns launch.json. */
function primaryFolder() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders[0] : undefined;
}

// ---------------------------------------------------------------------------
// Debug operations
// ---------------------------------------------------------------------------

async function startDebugging(configName) {
  const folder = primaryFolder();
  const name = configName || "Attach to Unity";
  const ok = await vscode.debug.startDebugging(folder, name);
  if (!ok) throw new Error(`startDebugging("${name}") returned false`);
  // Give the adapter a moment to register.
  await delay(300);
  const s = activeSession();
  return { started: true, session: s ? s.name : null };
}

async function stopDebugging() {
  const s = activeSession();
  await vscode.debug.stopDebugging(s || undefined);
  return { stopped: true };
}

function listBreakpoints() {
  return vscode.debug.breakpoints
    .filter((b) => b instanceof vscode.SourceBreakpoint)
    .map((b) => ({
      file: b.location.uri.fsPath,
      line: b.location.range.start.line + 1,
      enabled: b.enabled,
      condition: b.condition || null,
    }));
}

function addBreakpoint(file, line, condition) {
  const uri = vscode.Uri.file(file);
  const pos = new vscode.Position(Math.max(0, line - 1), 0);
  const bp = new vscode.SourceBreakpoint(
    new vscode.Location(uri, pos),
    true,
    condition || undefined
  );
  vscode.debug.addBreakpoints([bp]);
  return { added: { file, line, condition: condition || null } };
}

function clearBreakpoints(file) {
  const all = vscode.debug.breakpoints.filter(
    (b) => b instanceof vscode.SourceBreakpoint
  );
  const toRemove = file
    ? all.filter((b) => b.location.uri.fsPath === vscode.Uri.file(file).fsPath)
    : all;
  vscode.debug.removeBreakpoints(toRemove);
  return { removed: toRemove.length };
}

async function control(command) {
  const s = activeSession();
  if (!s) throw new Error("no active debug session");
  const map = {
    continue: "continue",
    stepOver: "next",
    stepIn: "stepIn",
    stepOut: "stepOut",
    pause: "pause",
  };
  const dapCommand = map[command];
  if (!dapCommand) throw new Error(`unknown control command: ${command}`);
  const args =
    dapCommand === "pause" || state.threadId == null
      ? { threadId: state.threadId || 1 }
      : { threadId: state.threadId };
  await s.customRequest(dapCommand, args);
  // Optimistically mark the program as running once the adapter accepts the
  // resume/step request. Some adapters (e.g. Unity vstuc) do not emit a
  // standard `continued` DAP event, which would otherwise leave `stopped`
  // stuck true. For steps the adapter sends a fresh `stopped` event shortly
  // after, which flips it back; for continue it stays running until the next
  // breakpoint hit.
  if (dapCommand !== "pause") {
    state.stopped = false;
    state.reason = null;
  }
  return { command, sent: dapCommand };
}

async function getStack() {
  const s = activeSession();
  if (!s) throw new Error("no active debug session");
  if (!state.stopped) return { stopped: false, frames: [] };
  const res = await s.customRequest("stackTrace", {
    threadId: state.threadId,
    startFrame: 0,
    levels: 20,
  });
  const frames = (res.stackFrames || []).map((f) => ({
    id: f.id,
    name: f.name,
    file: f.source ? f.source.path : null,
    line: f.line,
    column: f.column,
  }));
  return { stopped: true, threadId: state.threadId, frames };
}

async function getVariables(frameId) {
  const s = activeSession();
  if (!s) throw new Error("no active debug session");
  if (!state.stopped) return { stopped: false, scopes: [] };

  let fid = frameId;
  if (fid == null) {
    const st = await s.customRequest("stackTrace", {
      threadId: state.threadId,
      startFrame: 0,
      levels: 1,
    });
    fid = st.stackFrames && st.stackFrames[0] ? st.stackFrames[0].id : null;
  }
  if (fid == null) return { stopped: true, scopes: [] };

  const scopesRes = await s.customRequest("scopes", { frameId: fid });
  const scopes = [];
  for (const scope of scopesRes.scopes || []) {
    const vars = await s.customRequest("variables", {
      variablesReference: scope.variablesReference,
    });
    scopes.push({
      name: scope.name,
      variables: (vars.variables || []).map((v) => ({
        name: v.name,
        value: v.value,
        type: v.type || null,
        variablesReference: v.variablesReference || 0,
      })),
    });
  }
  return { stopped: true, frameId: fid, scopes };
}

async function expandVariable(variablesReference) {
  const s = activeSession();
  if (!s) throw new Error("no active debug session");
  const vars = await s.customRequest("variables", { variablesReference });
  return {
    variables: (vars.variables || []).map((v) => ({
      name: v.name,
      value: v.value,
      type: v.type || null,
      variablesReference: v.variablesReference || 0,
    })),
  };
}

async function evaluate(expression, frameId) {
  const s = activeSession();
  if (!s) throw new Error("no active debug session");
  let fid = frameId;
  if (fid == null && state.stopped) {
    const st = await s.customRequest("stackTrace", {
      threadId: state.threadId,
      startFrame: 0,
      levels: 1,
    });
    fid = st.stackFrames && st.stackFrames[0] ? st.stackFrames[0].id : null;
  }
  const res = await s.customRequest("evaluate", {
    expression,
    frameId: fid != null ? fid : undefined,
    context: "repl",
  });
  return {
    result: res.result,
    type: res.type || null,
    variablesReference: res.variablesReference || 0,
  };
}

function getStatus() {
  const s = activeSession();
  return {
    hasSession: !!s,
    sessionName: s ? s.name : null,
    sessionType: s ? s.type : null,
    stopped: state.stopped,
    threadId: state.threadId,
    reason: state.reason,
    breakpoints: listBreakpoints().length,
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const routes = {
  "GET /status": async () => getStatus(),
  "POST /attach": async (body) => startDebugging(body.config),
  "POST /detach": async () => stopDebugging(),
  "GET /breakpoints": async () => ({ breakpoints: listBreakpoints() }),
  "POST /breakpoints/add": async (body) =>
    addBreakpoint(body.file, body.line, body.condition),
  "POST /breakpoints/clear": async (body) => clearBreakpoints(body.file),
  "POST /control": async (body) => control(body.command),
  "GET /stack": async () => getStack(),
  "POST /variables": async (body) => getVariables(body.frameId),
  "POST /variables/expand": async (body) =>
    expandVariable(body.variablesReference),
  "POST /evaluate": async (body) => evaluate(body.expression, body.frameId),
};

function startServer(port) {
  stopServer();
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const url = req.url.split("?")[0];
      const key = `${req.method} ${url}`;
      const handler = routes[key];
      res.setHeader("Content-Type", "application/json");
      if (!handler) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: `no route: ${key}` }));
        return;
      }
      let body = {};
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch (e) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }
      }
      try {
        const result = await handler(body);
        res.statusCode = 200;
        res.end(JSON.stringify(result));
      } catch (e) {
        log(`error on ${key}: ${e && e.message}`);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String((e && e.message) || e) }));
      }
    });
  });
  server.on("error", (e) => log(`server error: ${e.message}`));
  server.listen(port, "127.0.0.1", () =>
    log(`listening on http://127.0.0.1:${port}`)
  );
}

function stopServer() {
  if (server) {
    try {
      server.close();
    } catch (e) {
      /* ignore */
    }
    server = null;
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Debug adapter tracker — keeps `state` in sync with stopped/continued events
// ---------------------------------------------------------------------------

function makeTracker(session) {
  return {
    onDidSendMessage(m) {
      if (!m || m.type !== "event") return;
      if (m.event === "stopped") {
        state.stopped = true;
        state.threadId = m.body ? m.body.threadId : state.threadId;
        state.reason = m.body ? m.body.reason : null;
        state.sessionName = session.name;
        log(`stopped (${state.reason}) thread=${state.threadId}`);
      } else if (m.event === "continued") {
        state.stopped = false;
        state.reason = null;
      } else if (m.event === "terminated" || m.event === "exited") {
        state.stopped = false;
        state.threadId = null;
        state.reason = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function activate(context) {
  output = vscode.window.createOutputChannel("Debug Bridge");
  const port = vscode.workspace
    .getConfiguration("debugBridge")
    .get("port", 39517);

  startServer(port);

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory("*", {
      createDebugAdapterTracker: (session) => makeTracker(session),
    }),
    vscode.debug.onDidTerminateDebugSession(() => {
      state.stopped = false;
      state.threadId = null;
      state.reason = null;
    }),
    vscode.commands.registerCommand("debugBridge.showStatus", () => {
      vscode.window.showInformationMessage(
        `Debug Bridge: ${JSON.stringify(getStatus())}`
      );
      output.show();
    }),
    vscode.commands.registerCommand("debugBridge.restart", () => {
      const p = vscode.workspace
        .getConfiguration("debugBridge")
        .get("port", 39517);
      startServer(p);
      vscode.window.showInformationMessage(
        `Debug Bridge restarted on :${p}`
      );
    }),
    { dispose: stopServer }
  );

  log("activated");
}

function deactivate() {
  stopServer();
}

module.exports = { activate, deactivate };
