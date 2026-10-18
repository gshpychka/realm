import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {test} from 'node:test';
import plugin from './index.mjs';

test('only the owner, unsandboxed, gets the tool, which runs the fixed helper with an argument array', async () => {
  let factory;
  plugin.register({registerTool(f) { factory = f; }});
  for (const context of [{}, {senderIsOwner: false, assertInvocationCurrent() {}}, {senderIsOwner: true},
    {senderIsOwner: true, sandboxed: true, assertInvocationCurrent() {}}]) {
    assert.equal(factory.create(context), null);
  }

  let current = true;
  const calls = [];
  const tool = factory.create({senderIsOwner: true, assertInvocationCurrent() { if (!current) throw Error('revoked'); }});
  const original = childProcess.execFile;
  childProcess.execFile = (...args) => { calls.push(args); args[3](null, '', ''); };
  syncBuiltinESMExports();
  try {
    const revision = 'a'.repeat(40);
    await tool.execute('call', {operation: 'build', revision});
    const [command, args, options] = calls[0];
    assert.equal(command, '/run/wrappers/bin/sudo');
    assert.deepEqual([...args.slice(0, 2), ...args.slice(3)], ['-n', '--', 'build', revision]);
    assert.equal(options.shell, undefined);
    current = false;
    await assert.rejects(tool.execute('call', {operation: 'switch', revision}), /revoked/);
    assert.equal(calls.length, 1);
  } finally {
    childProcess.execFile = original;
    syncBuiltinESMExports();
  }
});
