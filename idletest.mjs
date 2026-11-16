// Run the isolated runtime lifetime coverage without stopping OpenCode.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tests = fileURLToPath(new URL("./runtime.test.mjs", import.meta.url));
const result = spawnSync(process.execPath, ["--test", tests], { stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
