#!/usr/bin/env python3
"""
bundle.py — the build step.

Takes index.html (the maintained entry) and inlines every referenced
asset:
    <link rel="stylesheet" href="styles/x.css">  ->  <style>…x.css…</style>
    <script src="src/x.js"></script>             ->  <script>…x.js…</script>

and writes the result to "MUSIC INDEX.html" — the single-file bundle that
can be opened directly or hosted anywhere.  index.html + src/ + styles/
stay the source of truth; the bundle is a build artifact.

Usage:  python3 build/bundle.py
"""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, "index.html")
BUNDLE = os.path.join(ROOT, "MUSIC INDEX.html")


def read(rel):
    p = os.path.join(ROOT, rel)
    if not os.path.exists(p):
        raise SystemExit("bundle.py: missing referenced file: " + rel)
    with open(p, encoding="utf-8") as f:
        return f.read()


def inline_styles(html):
    def repl(m):
        href = m.group(1)
        css = read(href)
        return "<style>\n" + css + "\n</style>"
    return re.sub(r'<link\s+rel="stylesheet"\s+href="([^"]+)"\s*/?>',
                  repl, html)


def inline_scripts(html):
    def repl(m):
        src = m.group(1)
        js = read(src)
        return "<script>\n" + js + "\n</script>"
    # match only the simple src= form we emit (src="...js"></script>)
    return re.sub(r'<script\s+src="([^"]+)"\s*></script>', repl, html)


def main():
    html = read("index.html")
    html = inline_styles(html)
    html = inline_scripts(html)

    # sanity: no un-inlined external refs to local assets should remain
    leftover = re.findall(r'<script\s+src="src/[^"]+"', html)
    leftover += re.findall(r'<link\s+rel="stylesheet"\s+href="styles/[^"]+"', html)
    if leftover:
        print("bundle.py WARNING: un-inlined refs remain: %s" % leftover)

    with open(BUNDLE, "w", encoding="utf-8") as f:
        f.write(html)

    n = html.count("\n") + 1
    print("assembled MUSIC INDEX.html: %d lines, %d parts, %s bytes"
          % (n, html.count("Aqua.addPart("), "{:,}".format(os.path.getsize(BUNDLE))))


if __name__ == "__main__":
    main()
