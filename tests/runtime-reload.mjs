// Isolated real-SDK lifecycle test. No inference, network or parent-session reload.
// Private hooks are deliberately used ONLY to drive a run boundary without an LLM.
// v0.2: the single /agency command is the dispatch target ("/agency reload"), and
// session-local config (via /agency disable) must persist across the real reload.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Resolve the SDK through package resolution (devDependency installed via npm ci)
// instead of a hardcoded /opt path. The package's
// exports map only exposes ".", so walk from the resolved entry to the package
// root and import dist/core directly.
let entry;
try {
  entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
} catch {
  console.error('FAIL test:sdk — @earendil-works/pi-coding-agent not installed (run: npm ci)');
  process.exit(1);
}
let root = dirname(entry);
while (!existsSync(join(root, 'package.json'))) {
  if (dirname(root) === root) throw new Error('SDK package root not found');
  root = dirname(root);
}
const core = pathToFileURL(join(root, 'dist', 'core') + '/');
const { createAgentSession } = await import(core + 'sdk.js');
const { DefaultResourceLoader } = await import(core + 'resource-loader.js');
const { SessionManager } = await import(core + 'session-manager.js');
const { SettingsManager } = await import(core + 'settings-manager.js');
const scratch = await mkdtemp(join(tmpdir(), 'agency-reload-sdk-'));
let session;
try {
  const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [] });
  const loader = new DefaultResourceLoader({ cwd: scratch, agentDir: scratch,
    settingsManager, additionalExtensionPaths: [resolve(import.meta.dirname, '../extension.ts')],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  assert.equal(loader.getExtensions().errors.length, 0, JSON.stringify(loader.getExtensions().errors));
  const manager = SessionManager.inMemory(scratch);
  manager.appendMessage({ role: 'user', content: 'Preserve this conversation marker', timestamp: Date.now() });
  ({ session } = await createAgentSession({ cwd: scratch, agentDir: scratch,
    settingsManager, sessionManager: manager, resourceLoader: loader, noTools: 'builtin' }));
  const errors = [];
  await session.bindExtensions({ mode: 'print', onError: e => errors.push(e),
    commandContextActions: { reload: () => session.reload() } });
  const invoke = (name, args) => session._toolDefinitions.get(name).definition.execute(
    'sdk-test', args, new AbortController().signal, undefined, session._extensionRunner.createContext());
  // Session-local config through the REAL command path: session.prompt() dispatches
  // extension commands immediately (before any model/preflight), so this exercises
  // the actual /agency handler + pi.appendEntry + the session file, no LLM turn.
  await session.prompt('/agency disable models');
  const cfgEntries = manager.getEntries().filter((e) => e.type === 'custom' && e.customType === 'agency-config');
  assert.equal(cfgEntries.length, 1, 'agency-config entry appended exactly once');
  assert.deepEqual(cfgEntries[0].data, { version: 1, disabled: ['models'], readOnly: false });
  let modelsErr = '';
  try { await invoke('agency_models', {}); } catch (e) { modelsErr = e.message; }
  assert.match(modelsErr, /disabled for this session/, 'session-local disable effective on the live instance');
  const id = manager.getSessionId();
  const entries = JSON.stringify(manager.getEntries());
  const oldRunner = session._extensionRunner;
  const scheduled = await invoke('agency_control', { action: 'reload' });
  assert.match(scheduled.content[0].text, /scheduled/);
  assert.equal(session._extensionRunner, oldRunner, 'must not reload within tool execution');
  await session._emitAgentSettled();
  let status = '';
  for (let i = 0; i < 200; i++) {
    await new Promise(r => setTimeout(r, 25));
    if (session._extensionRunner === oldRunner) continue;
    status = (await invoke('agency_status', {})).content[0].text;
    if (status.includes('runtime-confirmed reload')) break;
  }
  assert.notEqual(session._extensionRunner, oldRunner, 'new extension runtime installed');
  assert.match(status, /reload: completed.*runtime-confirmed reload/);
  // config restored from the session BRANCH on the fresh instance's session_start:
  // the session-local disable survived the real runtime reload
  modelsErr = '';
  try { await invoke('agency_models', {}); } catch (e) { modelsErr = e.message; }
  assert.match(modelsErr, /disabled for this session/, 'session-local config persists across the real reload');
  assert.match(status, /session config: disabled \[models\]/, 'status reports the restored config');
  assert.equal(manager.getSessionId(), id);
  assert.equal(JSON.stringify(manager.getEntries()), entries, 'conversation unchanged; command not sent to LLM');
  assert.deepEqual(errors, []);
  console.log('PASS real SDK reload: deferred /agency reload dispatch, new runtime, completion event, config persisted from branch, same session/conversation, no errors');
} finally {
  if (session) await session.dispose();
  await rm(scratch, { recursive: true, force: true });
}
