#!/bin/sh
# Install voix: downloads the darwin-arm64 executable from the latest GitHub release into ~/.local/bin.
# Usage: curl -fsSL https://github.com/OWNER/voix-mcp/releases/latest/download/install.sh | sh
set -eu

REPO="${VOIX_REPO:-OWNER/voix-mcp}"
VERSION="${VOIX_VERSION:-latest}"
INSTALL_DIR="${VOIX_INSTALL_DIR:-$HOME/.local/bin}"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$os-$arch" in
  darwin-arm64) asset="voix-darwin-arm64" ;;
  *) echo "voix: no prebuilt binary for $os-$arch (MVP supports macOS Apple Silicon only)" >&2; exit 1 ;;
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
