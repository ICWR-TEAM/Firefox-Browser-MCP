// Configuration for Mozilla's `web-ext` tool.
// Files listed here are excluded from the packaged .zip / .xpi.
module.exports = {
  ignoreFiles: [
    "package.json",
    "package-lock.json",
    "web-ext-config.cjs",
    "README.md",
    "web-ext-artifacts",
    "node_modules",
  ],
  build: {
    overwriteDest: true,
  },
};
