import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectFiles, publish } from "./artifacts-publish.mjs";

const ARTIFACTS = "runs/2026-11/1_sunday/artifacts";
const CONFIG = {
  origin: "https://artifacts.example/",
  password: "pw",
  accountId: "acct",
  accessKeyId: "key",
  secretAccessKey: "secret",
};
const R2 = "https://acct.r2.cloudflarestorage.com/caddie-artifacts/";

let workspace: string;

async function put(path: string, body = "x") {
  const full = join(workspace, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, body);
}

/** Stands in for R2 and the Worker at the network boundary, recording uploads. */
function fakeNetwork(over: { auth?: number; head?: number; put?: number } = {}) {
  const uploads: { key: string; type: string | null; body: string; signed: boolean }[] = [];
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url.startsWith(R2)) {
      uploads.push({
        key: decodeURIComponent(req.url.slice(R2.length)),
        type: req.headers.get("content-type"),
        body: await req.text(),
        signed: (req.headers.get("authorization") ?? "").startsWith("AWS4-HMAC-SHA256"),
      });
      return new Response(null, { status: over.put ?? 200 });
    }
    if (req.url.endsWith("/_auth")) {
      const status = over.auth ?? 303;
      const headers: Record<string, string> = status === 303 ? { "set-cookie": "__a=1; HttpOnly" } : {};
      return new Response(null, { status, headers });
    }
    expect(req.headers.get("cookie")).toBe("__a=1");
    return new Response(null, { status: over.head ?? 200 });
  });
  return uploads;
}

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), "artifacts-publish-")));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(workspace, { recursive: true, force: true });
});

describe("publish", () => {
  it("links straight to a single file, with its Content-Type stored", async () => {
    await put(`${ARTIFACTS}/report.pdf`, "%PDF");
    const uploads = fakeNetwork();

    const { files, links } = await publish(workspace, [`${ARTIFACTS}/report.pdf`], CONFIG);

    expect(files).toEqual(["report.pdf"]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ type: "application/pdf", body: "%PDF", signed: true });
    expect(uploads[0]!.key).toMatch(/^shared\/[0-9a-f]{32}\/report\.pdf$/);
    expect(links).toEqual([`https://artifacts.example/${uploads[0]!.key}`]);
  });

  it("gives a page one folder link and keeps its structure", async () => {
    await put(`${ARTIFACTS}/site/index.html`);
    await put(`${ARTIFACTS}/site/img/chart.png`);
    await put(`${ARTIFACTS}/site/.DS_Store`);
    const uploads = fakeNetwork();

    const { files, links } = await publish(workspace, [`${ARTIFACTS}/site`], CONFIG);

    expect(files).toEqual(["img/chart.png", "index.html"]);
    const id = uploads[0]!.key.split("/")[1];
    expect(uploads.map((u) => u.key)).toEqual([`shared/${id}/img/chart.png`, `shared/${id}/index.html`]);
    expect(links).toEqual([`https://artifacts.example/shared/${id}/`]);
  });

  it("gives a set of files with no index one link each, encoded", async () => {
    await put(`${ARTIFACTS}/plans/floor plan.pdf`);
    await put(`${ARTIFACTS}/menu.pdf`);
    fakeNetwork();

    const { files, links } = await publish(workspace, [`${ARTIFACTS}/plans/floor plan.pdf`, `${ARTIFACTS}/menu.pdf`], CONFIG);

    expect(files).toEqual(["menu.pdf", "plans/floor plan.pdf"]);
    expect(links).toHaveLength(2);
    expect(links[1]).toMatch(/\/plans\/floor%20plan\.pdf$/);
  });

  it("uses a fresh id for every publish", async () => {
    await put(`${ARTIFACTS}/a.pdf`);
    const uploads = fakeNetwork();

    await publish(workspace, [`${ARTIFACTS}/a.pdf`], CONFIG);
    await publish(workspace, [`${ARTIFACTS}/a.pdf`], CONFIG);

    expect(uploads[0]!.key).not.toBe(uploads[1]!.key);
  });

  it("returns no link when the upload fails", async () => {
    await put(`${ARTIFACTS}/a.pdf`);
    fakeNetwork({ put: 403 });

    await expect(publish(workspace, [`${ARTIFACTS}/a.pdf`], CONFIG)).rejects.toThrow(/failed \(403\)/);
  });

  it("returns no link when the password doesn't open it", async () => {
    await put(`${ARTIFACTS}/a.pdf`);
    fakeNetwork({ auth: 401 });

    await expect(publish(workspace, [`${ARTIFACTS}/a.pdf`], CONFIG)).rejects.toThrow(/don't send it/);
  });

  it("returns no link when the object doesn't serve after login", async () => {
    await put(`${ARTIFACTS}/a.pdf`);
    fakeNetwork({ head: 404 });

    await expect(publish(workspace, [`${ARTIFACTS}/a.pdf`], CONFIG)).rejects.toThrow(/returned 404/);
  });
});

describe("what can be published", () => {
  it("refuses everything outside a run's artifacts directory", async () => {
    await put("config/team/someone.md");
    await put("conversations/email/1/0001.md");
    await put(`${ARTIFACTS}/a.pdf`);

    for (const path of ["config/team/someone.md", "conversations", ".", "/etc/hosts", ARTIFACTS]) {
      await expect(collectFiles(workspace, [path])).rejects.toThrow(/can't be published/);
    }
  });

  it("refuses a path that climbs out of the workspace", async () => {
    await put(`${ARTIFACTS}/a.pdf`);
    const outside = join(workspace, "..", "artifacts-outside.pdf");
    await writeFile(outside, "x");

    await expect(collectFiles(workspace, [`${ARTIFACTS}/../../../../../artifacts-outside.pdf`])).rejects.toThrow(/can't be published/);
    await rm(outside);
  });

  it("refuses a symlink pointing out of the artifacts directory", async () => {
    await put("config/preferences.md");
    await mkdir(join(workspace, ARTIFACTS), { recursive: true });
    await symlink(join(workspace, "config/preferences.md"), join(workspace, ARTIFACTS, "notes.md"));

    await expect(collectFiles(workspace, [`${ARTIFACTS}/notes.md`])).rejects.toThrow(/can't be published/);
  });

  it("refuses a symlink inside a published directory", async () => {
    await put("config/preferences.md");
    await put(`${ARTIFACTS}/site/index.html`);
    await symlink(join(workspace, "config"), join(workspace, ARTIFACTS, "site/config"));

    await expect(collectFiles(workspace, [`${ARTIFACTS}/site`])).rejects.toThrow(/symlink/);
  });

  it("refuses a file type with no Content-Type", async () => {
    await put(`${ARTIFACTS}/data.bin`);
    await expect(collectFiles(workspace, [`${ARTIFACTS}/data.bin`])).rejects.toThrow(/isn't a supported file type/);
  });

  it("refuses a name the Worker would 404", async () => {
    await put(`${ARTIFACTS}/report..final.pdf`);
    await expect(collectFiles(workspace, [`${ARTIFACTS}/report..final.pdf`])).rejects.toThrow(/rename it/);
  });

  it("refuses too many files", async () => {
    await Promise.all(Array.from({ length: 201 }, (_, i) => put(`${ARTIFACTS}/many/${i}.txt`)));
    await expect(collectFiles(workspace, [`${ARTIFACTS}/many`])).rejects.toThrow(/too many/);
  });

  it("refuses more than the total size limit", async () => {
    await put(`${ARTIFACTS}/big.txt`, "x".repeat(101 * 1024 * 1024));
    await expect(collectFiles(workspace, [`${ARTIFACTS}/big.txt`])).rejects.toThrow(/the limit is/);
  });

  it("refuses an empty directory and an empty list", async () => {
    await mkdir(join(workspace, ARTIFACTS, "empty"), { recursive: true });
    await expect(collectFiles(workspace, [`${ARTIFACTS}/empty`])).rejects.toThrow(/no files/);
    await expect(collectFiles(workspace, [])).rejects.toThrow(/at least one/);
  });

  it("counts a file once when it's named and inside a named directory", async () => {
    await put(`${ARTIFACTS}/site/index.html`);
    const files = await collectFiles(workspace, [`${ARTIFACTS}/site`, `${ARTIFACTS}/site/index.html`]);
    expect(files).toHaveLength(1);
  });
});
