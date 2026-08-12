const [major, minor] = process.versions.node.split(".").map(Number);

if (major < 22 || major >= 27 || (major === 22 && minor < 12)) {
  console.error(
    `Verge Studio requires Node 22.12 or later and earlier than Node 27; found ${process.versions.node}. ` +
      "Use the repository .nvmrc, then run npm ci again.",
  );
  process.exit(1);
}
