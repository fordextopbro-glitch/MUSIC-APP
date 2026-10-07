#!/usr/bin/env python3
"""
extract.py — bootstrap the modular source tree from the single-file bundle.

Reads "MUSIC INDEX.html" (the verified bundle) and splits it into:
    styles/main.css            the full UI stylesheet
    src/kernel.js              the Aqua kernel (window.Aqua, bus, runParts)
    src/<part>.js              one file per registered Aqua part
    src/main.js                the boot (Aqua.runParts)

It is safe to re-run: it overwrites the generated src/ + styles/ files.
This is the inverse of build/bundle.py, which reassembles them.
"""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUNDLE = os.path.join(ROOT, "MUSIC INDEX.html")
SRC = os.path.join(ROOT, "src")
STY = os.path.join(ROOT, "styles")

def main():
    text = open(BUNDLE, encoding="utf-8").read()
    lines = text.split("\n")          # 0-indexed

    def find(rx, start=0, end=None):
        end = len(lines) if end is None else end
        p = re.compile(rx)
        for i in range(start, end):
            if p.search(lines[i]):
                return i
        return -1

    # ── CSS: between <style> and </style> ─────────────────────────
    s_open = find(r'^<style>')
    s_close = find(r'^</style>', s_open + 1)
    assert s_open >= 0 and s_close > s_open, "style block not found"
    css = lines[s_open + 1 : s_close]
    while css and not css[-1].strip():
        css.pop()
    os.makedirs(STY, exist_ok=True)
    with open(os.path.join(STY, "main.css"), "w", encoding="utf-8") as f:
        f.write("\n".join(css) + "\n")
    print("styles/main.css        %4d lines" % len(css))

    # ── main <script> block (the one that contains the kernel) ─────
    # there are two <script> openers: the theme pre-paint (head) and
    # the main kernel+parts block. Pick the one followed by the kernel.
    kernel_hint = find(r'NEONCORE KERNEL')
    script_open = -1
    for i in range(kernel_hint, 0, -1):
        if lines[i].strip() == '<script>':
            script_open = i
            break
    script_close = find(r'^</script>', script_open + 1)
    assert script_open >= 0 and script_close > script_open, "main script not found"
    js = lines[script_open + 1 : script_close]   # kernel + parts + boot
    # drop the leading 'use strict' line — each part carries its own
    while js and js[0].strip() == "'use strict';":
        js.pop(0)

    # locate the boot (Aqua.runParts) and its comment marker
    boot_call = -1
    for i in range(len(js) - 1, -1, -1):
        if 'Aqua.runParts()' in js[i]:
            boot_call = i
            break
    assert boot_call >= 0, "runParts not found"
    # back up to the "/* ── boot" comment if present
    boot_start = boot_call
    for i in range(boot_call, max(0, boot_call - 6), -1):
        if js[i].lstrip().startswith('/*'):
            boot_start = i
            break

    # locate every Aqua.addPart('<name>'
    parts = []   # (name, header_line_index_in_js, call_line_index_in_js)
    for i, ln in enumerate(js[:boot_start]):
        m = re.match(r"Aqua\.addPart\('([^']+)'", ln.strip())
        if m:
            name = m.group(1)
            # header = nearest preceding divider comment "/* ═"
            h = i
            for j in range(i, max(0, i - 40), -1):
                if js[j].lstrip().startswith('/* ═') or js[j].lstrip().startswith('/* ═'):
                    h = j
                    break
            parts.append((name, h, i))

    os.makedirs(SRC, exist_ok=True)

    def write(name, block):
        b = list(block)
        while b and not b[0].strip():
            b.pop(0)
        while b and not b[-1].strip():
            b.pop()
        with open(os.path.join(SRC, name), "w", encoding="utf-8") as f:
            f.write("\n".join(b) + "\n")
        print("src/%-16s %4d lines" % (name, len(b)))

    # kernel: from start of js to first part header
    if parts:
        write("kernel.js", js[0 : parts[0][1]])
    else:
        write("kernel.js", js[0 : boot_start])

    # each part
    for k, (name, h, call) in enumerate(parts):
        end = parts[k + 1][1] if k + 1 < len(parts) else boot_start
        fname = name.replace('/', '_') + ".js"
        write(fname, js[h : end])

    # boot → main.js
    write("main.js", js[boot_start : boot_call + 1])

    print("\nExtracted %d part files + kernel + main" % len(parts))

if __name__ == "__main__":
    main()
