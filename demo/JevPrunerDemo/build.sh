#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
app=build/JevPrunerDemo.app
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp Info.plist "$app/Contents/"
cp npm-install.json "$app/Contents/Resources/"
swiftc -O -parse-as-library \
  -target "$(uname -m)-apple-macos14.0" \
  -framework AppKit -framework SwiftUI -framework AVFoundation \
  main.swift -o "$app/Contents/MacOS/JevPrunerDemo"
codesign --force --sign - "$app" >/dev/null 2>&1

case "${1:-}" in
  --no-launch) ;;
  "") open "$app" ;;
  *) "$app/Contents/MacOS/JevPrunerDemo" "$@" ;;
esac
