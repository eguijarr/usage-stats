#!/usr/bin/env bash
# Draws the Claude logo with the Kitty graphics protocol three ways and with
# Sixel once, to find out which image protocol the terminal really draws
# (answering the capability query is not the same as drawing). Kitty is
# what kitty, WezTerm and Ghostty draw; Sixel is what Windows Terminal
# 1.22+, WezTerm, foot and iTerm2 draw.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
img="$(base64 < "$ROOT/assets/icons/claude.png" | tr -d '\n')"

clear
echo "1) Kitty, normal layer (z=0):"
printf '\e_Ga=T,f=100,t=d,c=6,r=3,q=2;%s\e\\' "$img"
printf '\n\n\n\n'

echo "2) Kitty, beneath cell backgrounds, the way OpenTUI places images:"
printf '\e_Ga=T,f=100,t=d,c=6,r=3,z=-1499999999,q=2;%s\e\\' "$img"
printf '\n\n\n\n'

echo "3) Kitty, transmit then place separately with C=1, as OpenTUI does:"
printf '\e_Ga=t,f=100,i=4242,q=2;%s\e\\' "$img"
printf '\e_Ga=p,i=4242,c=6,r=3,C=1,q=2\e\\'
printf '\n\n\n\n'

echo "4) Sixel:"
python3 - "$ROOT/assets/icons/claude.png" <<'PY'
import struct, sys, zlib

# minimal decoder for the 8-bit RGBA, non-interlaced PNGs in assets/icons
data = open(sys.argv[1], 'rb').read()
pos, idat = 8, b''
while pos < len(data):
    length, kind = struct.unpack('>I4s', data[pos:pos + 8])
    body = data[pos + 8:pos + 8 + length]
    if kind == b'IHDR':
        width, height = struct.unpack('>II', body[:8])
    elif kind == b'IDAT':
        idat += body
    pos += 12 + length
raw, stride, rows, prev = zlib.decompress(idat), width * 4, [], bytearray(width * 4)
for y in range(height):
    kind, line = raw[y * (stride + 1)], bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
    for i in range(stride):
        a = line[i - 4] if i >= 4 else 0
        b = prev[i]
        c = prev[i - 4] if i >= 4 else 0
        if kind == 1: line[i] = (line[i] + a) & 255
        elif kind == 2: line[i] = (line[i] + b) & 255
        elif kind == 3: line[i] = (line[i] + (a + b) // 2) & 255
        elif kind == 4:
            p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
            line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
    rows.append(line); prev = line

# one-colour sixel, transparent background (P2=1)
r, g, b = next((row[i], row[i + 1], row[i + 2]) for row in rows for i in range(0, stride, 4) if row[i + 3] > 128)
out = '\x1bP0;1;0q"1;1;%d;%d#1;2;%d;%d;%d#1' % (width, height, r * 100 // 255, g * 100 // 255, b * 100 // 255)
for band in range(0, height, 6):
    out += ''.join(chr(63 + sum(1 << k for k in range(6) if band + k < height and rows[band + k][x * 4 + 3] > 128)) for x in range(width)) + '-'
sys.stdout.write(out + '\x1b\\')
PY
printf '\n\n\n\n'

echo "Which of 1, 2, 3 and 4 show an orange starburst?"
