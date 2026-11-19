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
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.superagent.control</string>
<key>CFBundleName</key><string>助理工作台</string>
<key>CFBundleDisplayName</key><string>助理工作台</string>
<key>CFBundleExecutable</key><string>SuperAgent</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.1</string>
<key>CFBundleVersion</key><string>3</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>superagent</string></array></dict></array>
</dict></plist>
PLIST
codesign --force --sign - "$app"
printf '%s\n' "$app"
