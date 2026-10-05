#!/bin/sh
# Install voix: downloads the platform executable from the latest GitHub release into ~/.local/bin.
# Usage: curl -fsSL https://github.com/osmelmora/voix-mcp/releases/latest/download/install.sh | sh
set -eu

REPO="${VOIX_REPO:-osmelmora/voix-mcp}"
VERSION="${VOIX_VERSION:-latest}"
INSTALL_DIR="${VOIX_INSTALL_DIR:-$HOME/.local/bin}"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$os-$arch" in
  darwin-arm64) asset="voix-darwin-arm64" ;;
  linux-x86_64)
    case "$(getconf GNU_LIBC_VERSION 2>/dev/null || true)" in
      "glibc "*) asset="voix-linux-x64" ;;
      *) echo "voix: Linux x64 requires glibc; musl hosts such as Alpine are unsupported" >&2; exit 1 ;;
    esac
    ;;
  *) echo "voix: no prebuilt binary for $os-$arch (supports macOS Apple Silicon and Linux x64 with glibc)" >&2; exit 1 ;;
esac

if [ "$VERSION" = "latest" ]; then
  url="https://github.com/$REPO/releases/latest/download/$asset"
else
  url="https://github.com/$REPO/releases/download/$VERSION/$asset"
fi

mkdir -p "$INSTALL_DIR"
tmp=$(mktemp)
echo "Downloading $url"
curl -fsSL "$url" -o "$tmp"
chmod +x "$tmp"
mv "$tmp" "$INSTALL_DIR/voix"
echo "Installed $INSTALL_DIR/voix"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "Add $INSTALL_DIR to your PATH, then run: voix say \"Hello\"" ;;
esac
