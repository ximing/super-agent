#!/usr/bin/env python3
"""Render the versioned SVG identity with librsvg; no app/runtime dependencies.

Requires rsvg-convert (librsvg). Run from any directory. Keep the paths in
assets/branding/mark.svg as the single source of geometry.
"""
from pathlib import Path
import shutil
import subprocess
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets/branding"
NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", NS)
PALETTES = {
    "light": ("#FFFFFF", "#E8E7EE", "#6257C6", "#8B7BE6"),
    "dark": ("#202027", "#393842", "#B4A6FF", "#8274E0"),
}


def mark(appearance="light", monochrome=False):
    source = ET.parse(ASSETS / "mark.svg").getroot()
    group = source.find(f"{{{NS}}}g")
    for path in group:
        index = 2 if path.attrib["id"] == "upper" else 3
        path.set("stroke", "#FFFFFF" if monochrome else PALETTES[appearance][index])
    return ET.tostring(group, encoding="unicode")


def svg(content, size=1024):
    return f'<svg xmlns="{NS}" width="{size}" height="{size}" viewBox="0 0 1024 1024">{content}</svg>'


def tile(appearance, inset=80, shadow=False):
    background, border, *_ = PALETTES[appearance]
    defs = ('<defs><filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">'
            '<feDropShadow dx="0" dy="12" stdDeviation="12" flood-color="#11111B" flood-opacity=".16"/>'
            '</filter></defs>') if shadow else ""
    side = 1024 - 2 * inset
    filter_attr = ' filter="url(#shadow)"' if shadow else ""
    return (defs + f'<rect x="{inset}" y="{inset}" width="{side}" height="{side}" '
            f'rx="{side * .225}" fill="{background}" stroke="{border}" stroke-width="2"{filter_attr}/>'
            + mark(appearance))


def render(relative, source, size, height=None):
    path = ASSETS / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.with_suffix(".svg").write_text(source + "\n")
    subprocess.run(["rsvg-convert", "--width", str(size), "--height", str(height or size),
                    "--output", str(path), str(path.with_suffix(".svg"))], check=True)


def main():
    if not shutil.which("rsvg-convert"):
        raise SystemExit("Install librsvg (rsvg-convert) to regenerate app icons.")
    for appearance in PALETTES:
        render(f"macos/icon-{appearance}.png", svg(tile(appearance, shadow=True)), 1024)
        render(f"android/icon-{appearance}.png", svg(tile(appearance, inset=16)), 1024)
        # The entire mark lies inside Android's central 66dp-diameter circle
        # on its 108dp adaptive canvas (scale .9 provides optical breathing room).
        foreground = '<g transform="translate(512 512) scale(.9) translate(-512 -512)">' + mark(appearance) + '</g>'
        render(f"android/foreground-{appearance}.png", svg(foreground), 432)
    render("android/monochrome.png", svg('<g transform="translate(512 512) scale(.9) translate(-512 -512)">' + mark(monochrome=True) + '</g>'), 432)
    render("android/icon-store.png", svg('<rect width="1024" height="1024" fill="#FFFFFF"/>' + mark()), 1024)
    preview()
    print("Rendered SVG + PNG icon assets and preview under assets/branding/.")


def preview():
    # The contact sheet is an artifact, never a runtime input.
    sections = []
    for index, appearance in enumerate(PALETTES):
        x = index * 800
        panel = "#F1F0F4" if appearance == "light" else "#111116"
        ink = "#29292E" if appearance == "light" else "#EEEEF5"
        muted = "#77757F" if appearance == "light" else "#9B98AA"
        sections.append(f'<rect x="{x}" width="800" height="1000" fill="{panel}"/>')
        sections.append(f'<text x="{x+72}" y="85" fill="{ink}" font-family="Helvetica, sans-serif" font-size="21" letter-spacing="4">SUPER AGENT</text>')
        sections.append(f'<text x="{x+72}" y="122" fill="{muted}" font-family="Helvetica, sans-serif" font-size="15">RELAY / {appearance.upper()} APPEARANCE</text>')
        sections.append(f'<svg x="{x+144}" y="158" width="512" height="512" viewBox="0 0 1024 1024">{tile(appearance, shadow=True)}</svg>')
        sections.append(f'<text x="{x+72}" y="740" fill="{muted}" font-family="Helvetica, sans-serif" font-size="16">macOS</text>')
        for i, size in enumerate([96, 64, 32, 16]):
            xx = x + 190 + i * 126
            sections.append(f'<svg x="{xx}" y="{728-size/2}" width="{size}" height="{size}" viewBox="0 0 1024 1024">{tile(appearance)}</svg>')
        sections.append(f'<text x="{x+72}" y="878" fill="{muted}" font-family="Helvetica, sans-serif" font-size="16">Android</text>')
        bg, *_ = PALETTES[appearance]
        for i, radius in enumerate([56, 24, 40]):
            xx = x + 180 + i * 160
            maskid = f"mask-{appearance}-{i}"
            # Adaptive launchers expose the center 72dp of the 108dp layers.
            sections.append(f'<defs><clipPath id="{maskid}"><rect width="112" height="112" rx="{radius}"/></clipPath></defs>')
            sections.append(f'<g transform="translate({xx} 812)" clip-path="url(#{maskid})"><rect width="112" height="112" fill="{bg}"/><svg x="-28" y="-28" width="168" height="168" viewBox="0 0 1024 1024"><g transform="translate(512 512) scale(.9) translate(-512 -512)">{mark(appearance)}</g></svg></g>')
    document = f'<svg xmlns="{NS}" width="1600" height="1000" viewBox="0 0 1600 1000">' + "".join(sections) + '</svg>'
    render("preview.png", document, 1600, 1000)


if __name__ == "__main__":
    main()
