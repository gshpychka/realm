"""Add configured HDMI targets to Vetro's remapper, without assigning buttons.

Applies to Vetro source revision 42bceac690aed4c3ac42cfd2c85f20054fc8c81b.
Unknown source layouts fail before any file is written. Keep original files
for rollback; Vetro updates may require rebasing these small integration edits.
"""

import shutil
import sys
from pathlib import Path


def replace(text, before, after):
    if text.count(before) != 1:
        raise ValueError(
            f"Expected exactly one Vetro integration anchor: {before[:90]}"
        )
    return text.replace(before, after)


def patched(files):
    result = dict(files)
    result["remap.js"] = replace(
        result["remap.js"],
        "    if (a.type === 'key') {",
        "    if (a.type === 'source') return require('./source-shortcuts.js').validate(a);\n"
        "    if (a.type === 'key') {",
    )
    result["main.js"] = replace(
        result["main.js"],
        "        if(a.type==='launch')command='/usr/bin/app_launcher -s '+a.appId;",
        "        if(a.type==='source')command=require('./source-shortcuts.js').command(a);\n"
        "        else if(a.type==='launch')command='/usr/bin/app_launcher -s '+a.appId;",
    )
    dashboard = result["dashboard.js"]
    dashboard = replace(
        dashboard,
        "var NOT_LAUNCHABLE=${JSON.stringify(require('./remap.js').NOT_LAUNCHABLE_PREFIX)};",
        "var SOURCE_TARGETS=${JSON.stringify(require('./source-shortcuts.js').targets)};\n"
        "var NOT_LAUNCHABLE=${JSON.stringify(require('./remap.js').NOT_LAUNCHABLE_PREFIX)};",
    )
    dashboard = replace(
        dashboard, "<span>App to open</span>", "<span>App or HDMI device</span>"
    )
    dashboard = replace(
        dashboard,
        "$('targetApp').innerHTML='<option value=\"\">Select an app…</option>'+pickable.map",
        "var appOptions='<option value=\"\">Select an app…</option>'+pickable.map",
    )
    dashboard = replace(
        dashboard,
        ".join('');var previous=$('mqttTarget').value;$('mqttTarget').innerHTML=$('targetApp').innerHTML;",
        ".join('');$('targetApp').innerHTML=appOptions+'<optgroup label=\"HDMI devices\">'+"
        "Object.keys(SOURCE_TARGETS).map(function(id){return '<option value=\"source:'+esc(id)+'\">'+"
        "esc(SOURCE_TARGETS[id].label)+'</option>'}).join('')+'</optgroup>';"
        "var previous=$('mqttTarget').value;$('mqttTarget').innerHTML=appOptions;",
    )
    dashboard = replace(
        dashboard,
        "name=a.type==='launch'?appLabel",
        "name=a.type==='source'?(SOURCE_TARGETS[a.target]||{label:a.target}).label:a.type==='launch'?appLabel",
    )
    dashboard = replace(
        dashboard,
        "actions:[{type:'launch',appId:id}]",
        "actions:[id.indexOf('source:')===0?{type:'source',target:id.slice(7)}:{type:'launch',appId:id}]",
    )
    dashboard = replace(
        dashboard,
        "a.type==='mqtt'?'MQTT '+a.topic:a.type==='launch'?a.appId:a.key",
        "a.type==='mqtt'?'MQTT '+a.topic:a.type==='source'?(SOURCE_TARGETS[a.target]||{label:a.target}).label:a.type==='launch'?a.appId:a.key",
    )
    dashboard = replace(
        dashboard,
        "Enter a key code from 0 to 767 and select an app.",
        "Enter a key code from 0 to 767 and select an app or HDMI device.",
    )
    result["dashboard.js"] = dashboard
    return result


if __name__ == "__main__":
    service = Path(sys.argv[1]) / "service"
    files = {
        name: (service / name).read_text()
        for name in ("remap.js", "main.js", "dashboard.js")
    }
    result = patched(files)
    for name, content in result.items():
        (service / name).write_text(content)
    shutil.copy2(
        Path(__file__).with_name("source-shortcuts.js"), service / "source-shortcuts.js"
    )
