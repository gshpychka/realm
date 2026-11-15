// Run: node test.cjs PATH_TO_PATCHED_VETRO
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = process.argv[2];
const configuration = fs.readFileSync(path.join(__dirname, 'targets.json'), 'utf8');
const sourceModule = {exports: {}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'source-shortcuts.js'), 'utf8'), {
    module: sourceModule,
    require: name => name === 'path' ? path : name === 'fs' ? {readFileSync: () => configuration} : null
});
const sources = sourceModule.exports;
assert.equal(Object.keys(sources.targets).length, 4);
assert.match(sources.command({type: 'source', target: 'kodi'}), /SourceShortcut\.dll' 15 1$/);
assert.match(sources.command({type: 'source', target: 'xbox'}), /SourceShortcut\.dll' 14 0$/);
assert.throws(() => sources.validate({type: 'source', target: 'kodi; reboot'}));
assert.throws(() => sources.validate({type: 'source', target: '__proto__'}));
assert.throws(() => sources.parseTargets('{"bad":{"label":"Bad","sourceType":17,"depthPort":0}}'));
assert.throws(() => sources.parseTargets('{"bad":{"label":"Bad","sourceType":15,"depthPort":5}}'));

const service = path.join(root, 'service');
for (const name of ['main.js', 'remap.js', 'dashboard.js', 'source-shortcuts.js']) {
    new vm.Script(fs.readFileSync(path.join(service, name), 'utf8'), {filename: name});
}
const remapModule = {exports: {}};
vm.runInNewContext(fs.readFileSync(path.join(service, 'remap.js'), 'utf8'), {
    module: remapModule,
    require: name => name === './source-shortcuts.js' ? sources : {}
});
const rules = remapModule.exports.validateRules([
    {id: 'test', trigger: {type: 'http', value: 'test-kodi'}, actions: [{type: 'source', target: 'kodi'}]}
]);
assert.equal(rules[0].actions[0].target, 'kodi');
assert.throws(() => remapModule.exports.validateRules([
    {id: 'test', trigger: {type: 'http', value: 'test-kodi'}, actions: [{type: 'source', target: 'unknown'}]}
]));

const calls = [];
const main = fs.readFileSync(path.join(service, 'main.js'), 'utf8');
const dispatch = main.slice(main.indexOf('function runActions('), main.indexOf('var actionQueue='));
const context = {
    require: () => sources,
    remap: {launchable: () => true, ruleRisk: () => null},
    packageOf: () => null,
    agentExecute: async command => { calls.push(command); return {exit_code: 0}; },
    bridge: {publish: () => assert.fail('HDMI action must not publish MQTT')},
    control: {}
};
vm.runInNewContext(dispatch, context);

const dashboardModule = {exports: {}};
vm.runInNewContext(fs.readFileSync(path.join(service, 'dashboard.js'), 'utf8'), {
    module: dashboardModule,
    require: name => {
        if (name === './source-shortcuts.js') return sources;
        if (name === './remap.js') return remapModule.exports;
        if (name === './app-groups.js') return function () {};
        if (name === './component-actions.js') return {availability: function () {}};
        if (name === './quick-settings.js') return {GROUPS: [], state: function () {}, ALLOWED_IDS: []};
        if (name === './debloat.js') return {VERIFIED_GLOBAL_IDS: []};
        if (name === './blocklist.js') return {publicGroups: () => []};
        if (name === './dock.js') return {customCandidate: function customCandidate() {}};
        return {};
    }
});
const html = dashboardModule.exports();
assert.match(html, /App or HDMI device/);
for (const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);

(async () => {
    await context.runActions(rules[0].actions);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], sources.command({type: 'source', target: 'kodi'}));
    await assert.rejects(context.runActions([{type: 'source', target: 'unknown'}]));
    assert.equal(calls.length, 1, 'Rejected targets must never execute');
    console.log('HDMI configuration, action validation, dispatch and dashboard syntax passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
