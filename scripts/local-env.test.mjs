import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  loadLocalCloudEnv,
  parseLocalCloudEnv,
} from "../app/vite-plugins/local-env.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = new URL("../", import.meta.url).pathname;

describe("repository-local cloud configuration", () => {
  it("parses the tracked example without treating identifiers as credentials", async () => {
    const text = await readFile(join(REPO_ROOT, ".env.local.example"), "utf8");
    expect(parseLocalCloudEnv(text)).toEqual({
      PROJECT_ID: "your-unique-google-project-id",
      REGION: "us-central1",
      VERGE_OUTPUT_BUCKET: "your-unique-verge-runs-bucket",
    });
  });

  it("loads missing values but preserves explicit process overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "verge-local-env-"));
    try {
      const path = join(root, ".env.local");
      await writeFile(
        path,
        "PROJECT_ID=file-project\nREGION=us-east1\nVERGE_OUTPUT_BUCKET=file-bucket\n",
      );
      const env = { PROJECT_ID: "explicit-project" };
      expect(loadLocalCloudEnv({ env, path })).toEqual(["REGION", "VERGE_OUTPUT_BUCKET"]);
      expect(env).toEqual({
        PROJECT_ID: "explicit-project",
        REGION: "us-east1",
        VERGE_OUTPUT_BUCKET: "file-bucket",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("gives shell variables the same precedence in every cloud script", async () => {
    const root = await mkdtemp(join(tmpdir(), "verge-shell-env-"));
    try {
      await mkdir(join(root, "scripts"));
      await copyFile(join(REPO_ROOT, "scripts/cloud-common.sh"), join(root, "scripts/cloud-common.sh"));
      await writeFile(
        join(root, ".env.local"),
        "PROJECT_ID=file-project\nREGION=us-east1\nVERGE_OUTPUT_BUCKET=file-bucket\n",
      );
      const command =
        'source "$1"; printf "%s|%s|%s" "$PROJECT_ID" "$REGION" "$VERGE_OUTPUT_BUCKET"';
      const env = { ...process.env, PROJECT_ID: "explicit-project" };
      delete env.REGION;
      delete env.VERGE_OUTPUT_BUCKET;
      const { stdout } = await execFileAsync("bash", ["-c", command, "bash", join(root, "scripts/cloud-common.sh")], {
        env,
      });
      expect(stdout).toBe("explicit-project|us-east1|file-bucket");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps deploy and teardown on the public bucket variable", async () => {
    for (const name of ["deploy.sh", "teardown.sh"]) {
      const source = await readFile(join(REPO_ROOT, "scripts", name), "utf8");
      expect(source).toContain("${VERGE_OUTPUT_BUCKET}");
      expect(source).not.toContain("${OUTPUT_BUCKET}");
    }
  });
});
