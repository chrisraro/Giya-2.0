"""Subset Material Symbols Rounded to the glyphs listed in a names file.

Invoked by `npm run gen:icons` (scripts/gen-icons.ts). Usage:
    python scripts/subset-icons.py <font.woff2> <names.txt> <out.woff2>

Why this shape:
  * Icons are ligatures: the text "home" is shaped into the `home` glyph by
    GSUB (rlig/rclt). Any `<glyph>.fill` companion is kept too.
  * layout_closure is OFF on purpose. With closure on, keeping the letters
    a-z pulls in every ligature those letters can spell, i.e. the whole
    catalogue back again.
  * GRAD/opsz/wght are pinned to the values globals.css already forces for
    every icon (GRAD 0, opsz 24, wght 400). Only FILL stays variable.
"""
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

src, names_file, out = sys.argv[1:4]
with open(names_file, encoding="utf-8") as fh:
    names = [n.strip() for n in fh if n.strip() and not n.startswith("#")]

font = TTFont(src)
order = set(font.getGlyphOrder())

# name -> glyph, read from the GSUB ligature rules rather than assumed from
# glyph names: aliases exist (the `draft` ligature renders the `note` glyph).
cmap = font.getBestCmap()
char_of = {g: chr(cp) for cp, g in cmap.items()}
ligature_glyph = {}
for lookup in font["GSUB"].table.LookupList.Lookup:
    for st in lookup.SubTable:
        st = getattr(st, "ExtSubTable", st)
        for first, ligs in getattr(st, "ligatures", {}).items():
            for lig in ligs:
                text = "".join(char_of.get(g, "?") for g in [first] + lig.Component)
                ligature_glyph[text] = lig.LigGlyph

glyphs = set()
missing = []
for n in names:
    g = ligature_glyph.get(n)
    if g is None:
        missing.append(n)
        continue
    glyphs.add(g)
    if f"{g}.fill" in order:
        glyphs.add(f"{g}.fill")
if missing:
    sys.exit("icons not in font: " + ", ".join(missing))

# Characters that spell the ligature names (a-z, 0-9, underscore).
unicodes = [ord(c) for c in "abcdefghijklmnopqrstuvwxyz0123456789_"]

opts = subset.Options()
opts.layout_features = ["liga", "rlig", "rclt", "calt", "rvrn"]
opts.layout_closure = False
opts.notdef_outline = True
opts.hinting = False
opts.name_IDs = [1, 2, 3, 4, 6]
opts.flavor = "woff2"

sub = subset.Subsetter(opts)
sub.populate(glyphs=sorted(glyphs), unicodes=unicodes)
sub.subset(font)

instancer.instantiateVariableFont(font, {"GRAD": 0, "opsz": 24, "wght": 400}, inplace=True)

font.flavor = "woff2"
font.save(out)
print("subset " + str(len(names)) + " icons -> " + out)
