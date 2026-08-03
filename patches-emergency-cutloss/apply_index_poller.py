import sys

p = 'index.js'
s = open(p).read()

old = '''        // Require N consecutive confirming ticks before acting.
        const { fire } = registerExitSignal(p.position, signal, confirmTicks);
        if (!signal || !fire) continue;'''
new = '''        // Require N consecutive confirming ticks before acting — EXCEPT emergency
        // stop loss (RULE_9), which fires on the FIRST tick to catch fast rug-pulls.
        const isEmergency = signal === "RULE_9" || String(reason || "").includes("EMERGENCY STOP LOSS");
        const { fire } = registerExitSignal(p.position, signal, isEmergency ? 1 : confirmTicks);
        if (!signal || !fire) continue;'''
assert s.count(old) == 1, 'poller confirmTicks block not found'
s = s.replace(old, new)

open(p, 'w').write(s)
print('index.js poller OK')
