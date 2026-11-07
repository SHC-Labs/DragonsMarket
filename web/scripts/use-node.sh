# Source from web/ to select the project-local runtime when installed.
# Other developers can use a version manager with .node-version instead.
dragons_node_version="$(cat .node-version)"
dragons_node_bin="${XDG_DATA_HOME:-$HOME/.local/share}/dragons-market/node-v${dragons_node_version}/bin"
if [ -x "$dragons_node_bin/node" ]; then
  export PATH="$dragons_node_bin:$PATH"
fi
node -e '
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  if (major !== 24 || minor < 21) {
    console.error("Dragons Market requires Node.js 24.21.0 or a newer 24.x release. Select the version in .node-version with your Node version manager.");
    process.exit(1);
  }
' || return 1
unset dragons_node_version dragons_node_bin
