const { Arch } = require("builder-util");
module.exports = async function checkDesktopTarget(context) {
  if (
    context.electronPlatformName !== process.platform ||
    Arch[context.arch] !== process.arch
  )
    throw new Error(
      "Build IDO Agent on the target OS and CPU so its bundled Codex matches the installer.",
    );
};
