#!/bin/bash
set -euo pipefail
package_dir="$(cd "$(dirname "$0")/.." && pwd)"
output_dir="${1:-$package_dir/build}"
case "$output_dir" in /*) ;; *) output_dir="$PWD/$output_dir" ;; esac
cd "$package_dir"
swift build -c release
app="$output_dir/Super Agent.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp .build/release/SuperAgent "$app/Contents/MacOS/SuperAgent"
branding_dir="$package_dir/../../assets/branding/macos"
iconset_dir="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$iconset_dir"
trap 'rm -rf "$(dirname "$iconset_dir")"' EXIT
for variant in light dark; do
    cp "$branding_dir/icon-$variant.png" "$app/Contents/Resources/AppIcon-$variant.png"
done
for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$branding_dir/icon-light.png" --out "$iconset_dir/icon_${size}x${size}.png" >/dev/null
    retina_size=$((size * 2))
    sips -z "$retina_size" "$retina_size" "$branding_dir/icon-light.png" --out "$iconset_dir/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset_dir" -o "$app/Contents/Resources/AppIcon.icns"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.superagent.control</string>
<key>CFBundleName</key><string>助理工作台</string>
<key>CFBundleDisplayName</key><string>助理工作台</string>
<key>CFBundleExecutable</key><string>SuperAgent</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundleShortVersionString</key><string>0.2.1</string>
<key>CFBundleVersion</key><string>5</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>superagent</string></array></dict></array>
</dict></plist>
PLIST
codesign --force --sign - "$app"
printf '%s\n' "$app"
