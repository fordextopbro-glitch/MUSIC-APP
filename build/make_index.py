#!/usr/bin/env python3
"""
make_index.py — one-shot bootstrap: build index.html (the maintained
project entry) from the current single-file bundle.

Pulls the <head> meta/title/fonts, the theme pre-paint script, and the
<body> markup out of "MUSIC INDEX.html", then writes index.html with
external <link>/<script src> references to styles/ + src/ in module
order.

After the first run you maintain index.html by hand; bundle.py is the
ongoing build (index.html + src/ + styles/  ->  "MUSIC INDEX.html").
"""
import os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUNDLE = os.path.join(ROOT, "MUSIC INDEX.html")
INDEX = os.path.join(ROOT, "index.html")

# module load order == part registration order; main.js boots last
MODULES = [
    "kernel", "core-math", "ambient2d", "gl-core", "geometry",
    "playback", "library-lab", "input", "demo", "main",
]

def main():
    lines = open(BUNDLE, encoding="utf-8").read().split("\n")

    def find(rx, start=0, end=None):
        end = len(lines) if end is None else end
        p = re.compile(rx)
        for i in range(start, end):
            if p.search(lines[i]):
                return i
        return -1

    # head meta/title/fonts: from doctype to just before the first <script>
    first_script = find(r'^<script>')
    head = lines[0:first_script]

    # theme pre-paint script block (the first <script> ... </script>)
    ts_open = first_script
    ts_close = find(r'^</script>', ts_open + 1)
    theme = lines[ts_open:ts_close + 1]

    # body markup: from <body> to just before the MAIN <script> (kernel)
    kernel_hint = find(r'NEONCORE KERNEL')
    main_script = -1
    for i in range(kernel_hint, 0, -1):
        if lines[i].strip() == '<script>':
            main_script = i
            break
    body_open = find(r'^<body>')
    body = lines[body_open:main_script]

    out = []
    out += head
    out.append('<link rel="stylesheet" href="styles/main.css">')
    out += theme
    out.append('</head>')
    out += body
    for m in MODULES:
        out.append('<script src="src/%s.js"></script>' % m)
    out.append('</body>')
    out.append('</html>')

    with open(INDEX, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    print("wrote index.html  (%d lines) — head %d + theme %d + body %d + %d scripts"
          % (len(out), len(head), len(theme), len(body), len(MODULES)))

if __name__ == "__main__":
    main()
