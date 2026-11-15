'use strict';
var path = require('path');
var fs = require('fs');
var DIRECTORY = '/home/owner/share/vetro-source-shortcuts';

// One shared feature; input names and wiring live in persistent configuration.
// Remap rules reference an ID and cannot supply shell text or arbitrary ports.
function parseTargets(text) {
    var values = JSON.parse(text);
    if (!values || Array.isArray(values) || typeof values !== 'object') throw new Error('Expected HDMI targets');
    Object.keys(values).forEach(function (id) {
        var value = values[id];
        if (!/^[a-z][a-z0-9_-]{0,39}$/.test(id) || !value || typeof value.label !== 'string' ||
            !value.label.trim() || value.label.length > 100 || /[\x00-\x1f]/.test(value.label) ||
            !Number.isInteger(value.sourceType) || value.sourceType < 13 || value.sourceType > 16 ||
            !Number.isInteger(value.depthPort) || value.depthPort < 0 || value.depthPort > 4) {
            throw new Error('Invalid HDMI target: ' + id);
        }
    });
    return values;
}
var targets = parseTargets(fs.readFileSync(path.join(DIRECTORY, 'targets.json'), 'utf8'));

function validate(action) {
    if (!action || action.type !== 'source' || typeof action.target !== 'string' ||
        !Object.prototype.hasOwnProperty.call(targets, action.target)) {
        throw new Error('Unknown HDMI shortcut target');
    }
    return {type: 'source', target: action.target};
}

function command(action) {
    var target = targets[validate(action).target];
    var helper = path.join(DIRECTORY, 'SourceShortcut.dll');
    return "/usr/bin/dotnet '" + helper.replace(/'/g, "'\\''") + "' " + target.sourceType + ' ' + target.depthPort;
}

module.exports = {targets: targets, validate: validate, command: command, parseTargets: parseTargets};
