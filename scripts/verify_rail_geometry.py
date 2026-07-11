#!/usr/bin/env python3
"""Regression check for backlog #3 (rail_lines.json TRA re-cut): confirm
the SET of all system=="tra" coordinate points in rail_lines.json is
unchanged between two snapshots -- i.e. scripts/fix_rail_cuts.py only
regrouped/re-segmented existing points, never invented or dropped any.

Usage:
  python3 scripts/verify_rail_geometry.py <before.json> <after.json>

Exits non-zero (and prints the diff size) if the point sets differ. Also
reports the per-file part count and total point count for context, and does
the same union check for system=="thsr" as a sanity control (that set MUST
be identical AND file-byte-identical -- thsr is explicitly out of scope for
this backlog item).
"""
import hashlib
import json
import sys


def point_set(lines, system):
    return {tuple(p) for l in lines if l.get("system") == system for p in l["points"]}


def report(label, before_lines, after_lines, system):
    before = point_set(before_lines, system)
    after = point_set(after_lines, system)
    before_parts = sum(1 for l in before_lines if l.get("system") == system)
    after_parts = sum(1 for l in after_lines if l.get("system") == system)
    ok = before == after
    print(f"[{label}] parts: {before_parts} -> {after_parts}   distinct points: {len(before)} -> {len(after)}   union unchanged: {ok}")
    if not ok:
        missing = before - after
        added = after - before
        print(f"  !! {len(missing)} points lost, {len(added)} points added")
        for p in list(missing)[:5]:
            print(f"     lost: {p}")
        for p in list(added)[:5]:
            print(f"     added: {p}")
    return ok


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    before_path, after_path = sys.argv[1], sys.argv[2]
    before = json.loads(open(before_path, encoding="utf-8").read())
    after = json.loads(open(after_path, encoding="utf-8").read())

    ok_tra = report("tra", before["lines"], after["lines"], "tra")
    ok_thsr = report("thsr", before["lines"], after["lines"], "thsr")

    before_thsr_bytes = json.dumps(
        [l for l in before["lines"] if l.get("system") == "thsr"], sort_keys=True, ensure_ascii=False
    ).encode()
    after_thsr_bytes = json.dumps(
        [l for l in after["lines"] if l.get("system") == "thsr"], sort_keys=True, ensure_ascii=False
    ).encode()
    thsr_hash_before = hashlib.md5(before_thsr_bytes).hexdigest()
    thsr_hash_after = hashlib.md5(after_thsr_bytes).hexdigest()
    ok_thsr_bytes = thsr_hash_before == thsr_hash_after
    print(f"[thsr] entry-content md5: {thsr_hash_before} -> {thsr_hash_after}   identical: {ok_thsr_bytes}")

    if ok_tra and ok_thsr and ok_thsr_bytes:
        print("\nPASS: tra geometry union unchanged, thsr untouched.")
        sys.exit(0)
    else:
        print("\nFAIL")
        sys.exit(1)


if __name__ == "__main__":
    main()
