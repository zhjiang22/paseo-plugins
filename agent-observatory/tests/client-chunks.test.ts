import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

test("the committed client chunk and manifest match a reproducible build", async () => {
  const { stdout } = await execute(process.execPath, ["scripts/build-client-chunks.mjs", "--check"], { cwd: root });
  assert.match(stdout, /Verified ui:/);
});

test("the evaluated client chunk compiles on the mobile Hermes runtime", async t => {
  const platform = process.platform === "linux" ? "linux64-bin" : process.platform === "darwin" ? "osx-bin" : null;
  if (!platform) { t.skip("No bundled Hermes compiler for this platform"); return; }
  const compiler = join(root, "node_modules/react-native/sdks/hermesc", platform, "hermesc");
  try { await access(compiler); } catch { t.skip("React Native's Hermes compiler is not installed"); return; }
  const directory = await mkdtemp(join(tmpdir(), "observatory-hermes-"));
  try {
    await execute(compiler, ["-emit-binary", "-out", join(directory, "ui.hbc"), "server/generated/ui-chunk.txt"],
      { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    await access(join(directory, "ui.hbc"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
