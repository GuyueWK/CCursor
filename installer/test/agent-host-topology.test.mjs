import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as acorn from 'acorn';
import { guardAgentHostTopology, isAgentHostTopologyGuarded } from '../src/agent-host-topology.js';
import { GLASS_FORCE_REFRESH_MARKER } from '../src/patch-glass-refresh.js';
import { buildHookPayload } from '../src/patch-inject.js';

const TOPOLOGY_FIXTURE = 'class Enablement{constructor(gate,token,logger){'
  + 'this._agentHostEnabled=gate||token,logger.info(this._agentHostEnabled)}}';

function createIsolatedHook({ label = 'desktop', remoteAuthority = '', byokMode = '1', storage = new Map() } = {}) {
  storage.set('__byokModeLastKnown', byokMode);
  const listeners = new Map();
  const warnings = [];
  const timers = [];
  const sandbox = {
    console: {
      log() {},
      warn(...values) { warnings.push(values.join(' ')); },
    },
    document: {
      body: null,
      addEventListener() {},
      querySelector() { return null; },
    },
    fetch() { throw new Error('Network access is forbidden in isolated payload tests'); },
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, value); },
    },
    vscode: { context: { configuration: () => ({ remoteAuthority }) } },
    setTimeout(callback, delay) { timers.push({ callback, delay }); },
    EventSource: class {
      addEventListener(eventName, listener) { listeners.set(eventName, listener); }
    },
  };
  const routes = {
    server: { host: '127.0.0.1', port: 39831 },
    collector: { host: '127.0.0.1', port: 14800 },
    redirect: ['agent.v1.AgentService'],
  };

  runInNewContext(buildHookPayload(true, label, routes), sandbox);
  return { sandbox, listeners, warnings, timers, storage };
}

test('topology guard preserves the following logger call and remains idempotent', () => {
  const guarded = guardAgentHostTopology(TOPOLOGY_FIXTURE, 'fixture');
  assert.equal(guarded.changed, true);
  assert.equal(isAgentHostTopologyGuarded(guarded.source), true);
  assert.doesNotThrow(() => acorn.parse(guarded.source, { ecmaVersion: 'latest' }));

  const loggedValues = [];
  const enabled = runInNewContext(`${guarded.source};new Enablement(true,false,logger)._agentHostEnabled`, {
    __byokAgentHostTopology: () => false,
    logger: { info(value) { loggedValues.push(value); } },
  });
  assert.equal(enabled, false);
  assert.deepEqual(loggedValues, [false]);
  assert.deepEqual(guardAgentHostTopology(guarded.source, 'fixture'), { source: guarded.source, changed: false });

  const enabledWithoutHook = runInNewContext(`${guarded.source};new Enablement(true,false,logger)._agentHostEnabled`, {
    logger: { info() {} },
  });
  assert.equal(enabledWithoutHook, true);
});

test('topology guard skips older bundles and rejects ambiguous assignments', () => {
  const olderBundle = 'const legacyAgent = true;';
  assert.deepEqual(guardAgentHostTopology(olderBundle, 'fixture'), { source: olderBundle, changed: false });
  assert.throws(
    () => guardAgentHostTopology(`${TOPOLOGY_FIXTURE};this._agentHostEnabled=true`, 'fixture'),
    /multiple agent host topology assignments/,
  );
});

for (const label of ['desktop', 'glass']) {
  test(`${label} payload switches only remote BYOK windows to legacy`, () => {
    const local = createIsolatedHook({ label });
    assert.equal(local.sandbox.__byokAgentHostTopology(true), true);

    for (const remoteAuthority of ['ssh-remote+example', 'wsl+Ubuntu', 'dev-container+example']) {
      const remoteOn = createIsolatedHook({ label, remoteAuthority });
      assert.equal(remoteOn.sandbox.__byokAgentHostTopology(true), false);
      assert.equal(remoteOn.sandbox.__byokAgentHostTopology(false), false);

      const remoteOff = createIsolatedHook({ label, remoteAuthority, byokMode: '0' });
      assert.equal(remoteOff.sandbox.__byokAgentHostTopology(true), true);
    }
  });

  test(`${label} payload persists route changes and requests a reload after enabling BYOK`, () => {
    const remoteAuthority = 'ssh-remote+example';
    const hook = createIsolatedHook({ label, remoteAuthority, byokMode: '0' });
    assert.equal(hook.sandbox.__byokAgentHostTopology(true), true);

    hook.listeners.get('rpc-routes')({ data: JSON.stringify(['agent.v1.AgentService']) });
    assert.equal(hook.storage.get('__byokModeLastKnown'), '1');
    assert.ok(hook.warnings.some(message => message.includes('Reload Window')));

    const reloaded = createIsolatedHook({ label, remoteAuthority, byokMode: hook.storage.get('__byokModeLastKnown') });
    assert.equal(reloaded.sandbox.__byokAgentHostTopology(true), false);

    hook.listeners.get('rpc-routes')({ data: '[]' });
    assert.equal(hook.storage.get('__byokModeLastKnown'), '0');
  });
}

test('merged refresh logic preserves the local glass authentication bypass', () => {
  const hook = createIsolatedHook({ label: 'glass' });
  let refreshCount = 0;
  hook.sandbox.__byokAiSvc = {
    refreshDefaultModels() {
      assert.equal(hook.sandbox[GLASS_FORCE_REFRESH_MARKER], true);
      refreshCount++;
    },
  };

  hook.listeners.get('refresh')();
  assert.equal(refreshCount, 1);
  const resetTimer = hook.timers.find(timer => timer.delay === 8000);
  assert.ok(resetTimer);
  resetTimer.callback();
  assert.equal(hook.sandbox[GLASS_FORCE_REFRESH_MARKER], false);
});
