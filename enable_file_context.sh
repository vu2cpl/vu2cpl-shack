#!/bin/bash
# enable_file_context.sh — Enable Node-RED file context store
# Run on Pi as vu2cpl. Safe to re-run (idempotent).

SETTINGS=~/.node-red/settings.js

echo "=== Node-RED File Context Store Setup ==="

# Already enabled?
# Match only an uncommented `contextStorage:` line — the boilerplate
# settings.js ships with a commented template block that mentions
# "localfilesystem", so we can't just grep for that substring.
if grep -qE '^[[:space:]]+contextStorage[[:space:]]*:' "$SETTINGS" 2>/dev/null; then
    echo "✅ Already enabled — nothing to do."
    exit 0
fi

# Backup
cp "$SETTINGS" "$SETTINGS.bak.$(date +%Y%m%d_%H%M%S)"
echo "📋 Backed up settings.js"

# Use Python to do a safe in-place edit.
# Two named stores: `default` (alias of `memory`) keeps existing no-scope
# flow.set/get behaviour unchanged; `file` (localfilesystem) backs every
# explicit `flow.set(..., 'file')` call. Without the explicit `memory`
# entry, declaring `default` would silently route ALL no-scope traffic
# to disk and balloon I/O.
python3 << 'PYEOF'
import re, os
path = os.path.expanduser('~/.node-red/settings.js')
with open(path) as f:
    txt = f.read()
block = """    contextStorage: {
        default: "memory",
        memory: { module: "memory" },
        file:   { module: "localfilesystem" }
    },"""
txt2 = re.sub(
    r'[ \t]*\/\/\s*contextStorage\s*:\s*\{[^}]*\}[^}]*\},?',
    block, txt, flags=re.DOTALL
)
if txt2 == txt:
    txt2 = txt.replace(
        '    //functionGlobalContext',
        block + '\n\n    //functionGlobalContext', 1
    )
with open(path, 'w') as f:
    f.write(txt2)
print("✅ settings.js updated")
PYEOF

mkdir -p ~/.node-red/context
echo "📁 ~/.node-red/context/ created"

if grep -q 'localfilesystem' "$SETTINGS"; then
    echo "✅ Verified — localfilesystem store enabled"
else
    echo "❌ Verification failed — check settings.js manually"
    exit 1
fi

echo ""
echo "⚡ Restart Node-RED to apply:"
echo "   node-red-stop && node-red-start"
echo ""
echo "✅ After restart, flow.set(..., 'file') persists across reboots."
