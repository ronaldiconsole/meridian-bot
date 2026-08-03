import sys

p = 'tools/dlmm.js'
s = open(p).read()

old = '''export async function closePosition({ position_address, reason }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_close: position_address, message: "DRY RUN — no transaction sent" };
  }'''
new = '''export async function closePosition({ position_address, reason }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    // Mark the virtual position closed in local state so the fast poller and
    // management cycle stop acting on it (it never exists on-chain).
    const tracked = getTrackedPosition(position_address);
    if (tracked) {
      recordClose(position_address, reason || "agent decision");
      return {
        dry_run: true,
        position: position_address,
        would_close: position_address,
        success: true,
        message: "DRY RUN — virtual position closed (no transaction sent)",
      };
    }
    return { dry_run: true, would_close: position_address, message: "DRY RUN — no transaction sent" };
  }'''
assert s.count(old) == 1, 'closePosition dry-run branch not found'
s = s.replace(old, new)

open(p, 'w').write(s)
print('dlmm.js closePosition dry-run OK')
