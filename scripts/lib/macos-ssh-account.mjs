// The owned SSH fixture needs the account's login shell to be zsh, and a hosted
// macOS runner's account uses bash. This switches the shell of a disposable
// hosted runner account and proves the switch. It refuses to run anywhere else.
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { userInfo as currentUserInfo } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const exec = (file, args) =>
  execFileSync(file, args, { encoding: "utf8", timeout: 10000, maxBuffer: 65536 });
// A fresh process: the lookup in this one may predate the directory change.
const lookUpAgain = () =>
  JSON.parse(
    exec(process.execPath, [
      "--input-type=module",
      "-e",
      "import { userInfo } from 'node:os'; process.stdout.write(JSON.stringify(userInfo()));",
    ]),
  );

export function prepareMacosSshAccount({
  env = process.env,
  platform = process.platform,
  uid = process.getuid(),
  userInfo = currentUserInfo,
  freshUserInfo = lookUpAgain,
  run = exec,
  receipt = {},
} = {}) {
  Object.assign(receipt, { before: null, directoryShell: null, after: null, exportedShell: null });
  receipt.before = userInfo();
  const { username } = receipt.before;
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    platform !== "darwin" ||
    uid === 0 ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(username)
  )
    throw new Error("Requires a disposable hosted macOS non-root account");
  if (receipt.before.shell !== "/bin/zsh")
    run("/usr/bin/sudo", [
      "-n",
      "/usr/bin/dscl",
      ".",
      "-create",
      `/Users/${username}`,
      "UserShell",
      "/bin/zsh",
    ]);
  receipt.directoryShell = run("/usr/bin/dscl", [
    ".",
    "-read",
    `/Users/${username}`,
    "UserShell",
  ]).trim();
  if (receipt.directoryShell !== "UserShell: /bin/zsh")
    throw new Error("Directory account shell verification failed");
  receipt.after = freshUserInfo();
  if (
    receipt.after.uid !== receipt.before.uid ||
    receipt.after.username !== username ||
    receipt.after.shell !== "/bin/zsh"
  )
    throw new Error("SSH account shell verification failed");
  receipt.exportedShell = "/bin/zsh";
  receipt.success = true;
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const receipt = { success: false, failure: null };
  try {
    prepareMacosSshAccount({ receipt });
    // Later steps read SHELL; export only the value verified above.
    appendFileSync(process.env.GITHUB_ENV, "SHELL=/bin/zsh\n");
  } catch (error) {
    receipt.failure = { message: String(error?.message ?? error).slice(0, 2048) };
    process.exitCode = 1;
  } finally {
    if (process.env.RUNNER_TEMP)
      writeFileSync(
        join(process.env.RUNNER_TEMP, "macos-ssh-account.json"),
        JSON.stringify(receipt, null, 2),
      );
    console.log(JSON.stringify(receipt));
  }
}
