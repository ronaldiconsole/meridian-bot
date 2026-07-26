import json
import urllib.request
import sys

with open("/root/meridian/.env") as f:
    env_data = f.read()

tok = None
for line in env_data.splitlines():
    if line.startswith("TELEGRAM_BOT_TOKEN="):
        tok = line.split("=", 1)[1].strip()
        if tok.startswith("\"") and tok.endswith("\""):
            tok = tok[1:-1]
        elif tok.startswith("'") and tok.endswith("'"):
            tok = tok[1:-1]
        break

if not tok:
    print("Token not found")
    sys.exit(1)

chat_id = "1148890399"

with open("/root/meridian/decision-log.json") as f:
    d = json.load(f)
decs = d.get("decisions", [])

if not decs:
    text = "VoxyNoxi\n\nBelum ada keputusan baru — bot tetap running normal."
else:
    decs.sort(key=lambda x: x.get("ts", ""))
    lines = []
    for x in decs[-10:]:
        ts = x.get("ts", "")[:16].replace("T", " ")
        t = x.get("type", "?")
        pool = x.get("pool_name") or "-"
        reason = x.get("reason", "")[:80]
        reason_clean = reason.replace("*", "").replace("_", "").replace("`", "")
        pool_clean = pool.replace("*", "").replace("_", "").replace("`", "")
        line_str = f"• `[{ts}]` *{t}* | {pool_clean} | {reason_clean}"
        lines.append(line_str)
    
    text = "VoxyNoxi\n\n🤖 *Meridian Decision Log Summary*\n\n"
    text += f"📊 *Total Keputusan:* {len(decs)}\n\n"
    text += "*10 Keputusan Terakhir (kronologis):*\n" + "\n".join(lines)
    text += "\n\nBot tetap running normal."

payload = {
    "chat_id": chat_id,
    "text": text,
    "parse_mode": "Markdown"
}

req = urllib.request.Request(
    f"https://api.telegram.org/bot{tok}/sendMessage",
    data=json.dumps(payload).encode("utf-8"),
    headers={"Content-Type": "application/json"}
)
try:
    with urllib.request.urlopen(req) as r:
        print("Success:", r.read().decode())
exception Exception as e:
    print("Error:", e)
    sys.exit(1)