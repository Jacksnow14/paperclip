#!/usr/bin/env python3
"""AUR-4056: rejoin records the sampler split across two lines.

A split record is a 9-column line (ts..agent_procs, where agent_procs is the
FIRST "0" of the "0\\n0" value) immediately followed by a 10-column line whose
first field is the SECOND "0". Dropping that duplicated field and concatenating
yields exactly the 18 columns the sampler meant to write. Lossless: no value is
invented, one duplicate is removed.
"""
import sys, shutil, os
src = sys.argv[1]; dst = sys.argv[2]
lines = open(src).read().split("\n")
if lines and lines[-1] == "": lines.pop()

out, repaired, untouched, refused = [], 0, 0, []
i = 0
while i < len(lines):
    ln = lines[i]; f = ln.split(",")
    is_data = ln[:2] == "20" and len(ln) > 4 and ln[4] == "-"
    if is_data and len(f) == 9 and i + 1 < len(lines):
        nxt = lines[i+1].split(",")
        # only join when the shape is exactly the known defect
        if len(nxt) == 10 and f[8] == "0" and nxt[0] == "0":
            out.append(",".join(f + nxt[1:])); repaired += 1; i += 2; continue
        refused.append((i+1, ln[:50]))
    if is_data and len(f) != 18 and len(f) != 9:
        refused.append((i+1, ln[:50]))
    out.append(ln); untouched += 1 if is_data and len(f) == 18 else 0
    i += 1

data = [l for l in out if l[:2] == "20" and len(l) > 4 and l[4] == "-"]
bad  = [l for l in data if len(l.split(",")) != 18]
orph = [l for l in out if l[:2] != "20" and not l.startswith("ts,")]

print(f"repaired_pairs   : {repaired}")
print(f"already_wellformed: {untouched}")
print(f"total_data_rows  : {len(data)}")
print(f"rows_not_18_cols : {len(bad)}")
print(f"orphan_lines_left: {len(orph)}")
if refused: print("REFUSED to join (left as-is):", refused[:5])
if bad or orph:
    print("ABORT: repair did not fully normalise the file"); sys.exit(1)

# timestamps must be preserved exactly: none invented, none lost
src_ts = [l.split(",")[0] for l in lines if l[:2] == "20" and len(l) > 4 and l[4] == "-"]
out_ts = [l.split(",")[0] for l in data]
if src_ts != out_ts:
    print(f"ABORT: timestamp set changed ({len(src_ts)} -> {len(out_ts)})"); sys.exit(1)
print(f"timestamps_preserved: {len(out_ts)}/{len(src_ts)} identical, in order")

open(dst, "w").write("\n".join(out) + "\n")
