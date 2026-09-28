import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliArgs, parseResult, report, wantsProduction } from "../src/run.mjs";

const RUN = fileURLToPath(new URL("../src/run.mjs", import.meta.url));

const PREVIEW = {
  status: "deployed",
  promoted: false,
  deployment: { id: "abcd1234", number: 7, url: "https://test-api--abcd1234.jojapi.dev" },
  preview_url: "https://test-api--preview.jojapi.dev",
  message: null,
  uploaded: 2,
  deleted: 0,
};

test("production: auto means pushes to the default branch; true and false force it", () => {
  const repo = { repository: { default_branch: "main" } };
  assert.equal(wantsProduction("auto", { GITHUB_REF: "refs/heads/main" }, repo), true);
  assert.equal(wantsProduction("auto", { GITHUB_REF: "refs/heads/feature" }, repo), false);
  assert.equal(wantsProduction("auto", { GITHUB_REF: "refs/pull/3/merge" }, { ...repo, pull_request: { number: 3 } }), false);
  assert.equal(wantsProduction("", { GITHUB_REF: "refs/heads/main" }, {}), false);
  assert.equal(wantsProduction("true", {}, { pull_request: { number: 3 } }), true);
  assert.equal(wantsProduction(" FALSE ", { GITHUB_REF: "refs/heads/main" }, repo), false);
  assert.throws(() => wantsProduction("yes", {}, {}), /auto, true or false/);
});

test("CLI arguments: pinned version, --prod, the message as one argument", () => {
  assert.deepEqual(cliArgs({ version: "0.1.1", production: true, message: "" }), ["--yes", "@jojapi/cli@0.1.1", "deploy", "--json", "--prod"]);
  assert.deepEqual(cliArgs({ version: "latest", production: false, message: "--TEST message" }), ["--yes", "@jojapi/cli@latest", "deploy", "--json", "--message=--TEST message"]);
  assert.throws(() => cliArgs({ version: "1.0; rm", production: false, message: "" }), /npm version/);
});

test("results: the CLI's JSON line, refusals and crashes become failed with their message", () => {
  assert.deepEqual(parseResult(0, "bundling…\n" + JSON.stringify(PREVIEW) + "\n", ""), PREVIEW);
  assert.equal(parseResult(0, '{"status":"unchanged"}\n', "").status, "unchanged");

  const refused = parseResult(1, JSON.stringify({ status: "invalid_files", message: "index.mjs: no default export", errors: ["index.mjs: no default export", "lib/a.mjs: too large"] }), "");
  assert.equal(refused.status, "failed");
  assert.equal(refused.message, "index.mjs: no default export\nlib/a.mjs: too large");

  const crashed = parseResult(1, "", "jojapi: GET v2/provider-api-edge: TEST token revoked\n");
  assert.deepEqual(crashed, { status: "failed", message: "GET v2/provider-api-edge: TEST token revoked" });

  assert.equal(parseResult(1, "", "npm error 404 Not Found\nnpm error TEST log\n").message, "npm error 404 Not Found\nnpm error TEST log");
  assert.equal(parseResult(1, "", "").message, "@jojapi/cli exited with code 1");
});

test("report: a preview names its URL and how it reaches production; a failure shows the error", () => {
  const context = { slug: "test-api", commit: "a".repeat(40), runUrl: "https://github.com/o/r/actions/runs/1", defaultBranch: "main" };
  const preview = report(PREVIEW, context);
  assert.match(preview, /Preview deployment ready/);
  assert.match(preview, /\| #7 `abcd1234` \| https:\/\/test-api--abcd1234\.jojapi\.dev \|/);
  assert.match(preview, /Latest preview: https:\/\/test-api--preview\.jojapi\.dev · Commit aaaaaaa/);
  assert.match(preview, /Merging into `main` deploys to production/);

  const failed = report({ status: "failed", message: "TEST ```boom```" }, context);
  assert.match(failed, /Deployment failed/);
  assert.doesNotMatch(failed, /\| Deployment \|/);
  assert.equal(failed.split("```").length, 3); // the message cannot close the code block
  assert.match(failed, /Production is unchanged/);

  const production = report({ ...PREVIEW, promoted: true, switched_to_code: true }, context);
  assert.match(production, /Deployed to production/);
  assert.match(production, /switched from its template to code mode/);
  assert.doesNotMatch(production, /Latest preview/);
});

// ---------------------------------------------------------------------------
// The step as the runner executes it: a stand-in `npx` on PATH and a fake GitHub API

function fakeGitHub() {
  const comments = [];
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
      const send = (status, data) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.method === "GET" && /^\/repos\/o\/r\/issues\/5\/comments/.test(req.url)) return send(200, comments);
      if (req.method === "POST" && req.url === "/repos/o/r/issues/5/comments") {
        const comment = { id: 100 + comments.length, body: JSON.parse(body).body };
        comments.push(comment);
        return send(201, comment);
      }
      const edit = /^\/repos\/o\/r\/issues\/comments\/(\d+)$/.exec(req.url);
      if (req.method === "PATCH" && edit) {
        const comment = comments.find((c) => c.id === Number(edit[1]));
        comment.body = JSON.parse(body).body;
        return send(200, comment);
      }
      send(404, { message: "Not Found" });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, comments, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

function workspace(event) {
  const dir = mkdtempSync(join(tmpdir(), "jojapi-action-"));
  const bin = join(dir, "bin");
  const api = join(dir, "api");
  for (const d of [bin, api]) mkdirSync(d);
  writeFileSync(join(api, "jojapi.json"), JSON.stringify({ slug: "test-api" }));
  // npx stand-in: records its arguments and environment, answers what FAKE_* say
  writeFileSync(
    join(bin, "npx"),
    `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ args: process.argv.slice(2), env: Object.keys(process.env), token: process.env.JOJAPI_TOKEN === "jm_TEST_SECRET" }));
process.stderr.write(process.env.FAKE_STDERR || "");
process.stdout.write(process.env.FAKE_STDOUT || "");
process.exit(Number(process.env.FAKE_CODE || 0));
`,
  );
  chmodSync(join(bin, "npx"), 0o755);
  writeFileSync(join(dir, "event.json"), JSON.stringify(event));
  writeFileSync(join(dir, "output"), "");
  writeFileSync(join(dir, "summary"), "");
  return { dir, bin, api };
}

function runStep(ws, github, env) {
  const full = {
    PATH: `${ws.bin}:${process.env.PATH}`,
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_PATH: join(ws.dir, "event.json"),
    GITHUB_OUTPUT: join(ws.dir, "output"),
    GITHUB_STEP_SUMMARY: join(ws.dir, "summary"),
    GITHUB_API_URL: github?.url ?? "http://127.0.0.1:9",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "o/r",
    GITHUB_RUN_ID: "42",
    GITHUB_SHA: "b".repeat(40),
    INPUT_PRODUCTION: "auto",
    INPUT_MESSAGE: "",
    INPUT_COMMENT: "true",
    INPUT_GITHUB_TOKEN: "ghs_TEST_GITHUB",
    INPUT_CLI_VERSION: "0.1.1",
    JOJAPI_TOKEN: "jm_TEST_SECRET",
    FAKE_RECORD: join(ws.dir, "record.json"),
    FAKE_STDOUT: JSON.stringify(PREVIEW) + "\n",
    ...env,
  };
  return new Promise((resolve) => {
    execFile(process.execPath, [RUN], { cwd: ws.api, env: full }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}

function readOutputs(ws) {
  return Object.fromEntries(
    readFileSync(join(ws.dir, "output"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

const PR_EVENT = { pull_request: { number: 5, title: "TEST change", head: { sha: "a".repeat(40) } }, repository: { default_branch: "main" } };

test("a pull request run deploys a preview, sets the outputs and keeps one comment up to date", async () => {
  const github = await fakeGitHub();
  const ws = workspace(PR_EVENT);
  try {
    const first = await runStep(ws, github, {});
    assert.equal(first.code, 0, first.stdout + first.stderr);

    const record = JSON.parse(readFileSync(join(ws.dir, "record.json"), "utf8"));
    assert.deepEqual(record.args, ["--yes", "@jojapi/cli@0.1.1", "deploy", "--json"]);
    assert.equal(record.token, true);
    assert.equal(record.env.some((key) => key.startsWith("INPUT_")), false, "the GitHub token and inputs never reach the CLI");
    assert.doesNotMatch(first.stdout + first.stderr, /jm_TEST_SECRET/);

    assert.deepEqual(readOutputs(ws), {
      status: "deployed",
      url: "https://test-api--abcd1234.jojapi.dev",
      "deployment-id": "abcd1234",
      "deployment-number": "7",
      "preview-url": "https://test-api--preview.jojapi.dev",
      promoted: "false",
    });
    assert.match(readFileSync(join(ws.dir, "summary"), "utf8"), /Preview deployment ready/);
    assert.equal(github.comments.length, 1);
    assert.match(github.comments[0].body, /^<!-- jojapi-deploy-action: test-api -->\n/);
    assert.equal(github.calls[0].authorization, "Bearer ghs_TEST_GITHUB");

    const second = await runStep(ws, github, { FAKE_STDOUT: JSON.stringify({ ...PREVIEW, deployment: { id: "efgh5678", number: 8, url: "https://test-api--efgh5678.jojapi.dev" } }) });
    assert.equal(second.code, 0);
    assert.equal(github.comments.length, 1, "the second run edits the comment");
    assert.match(github.comments[0].body, /efgh5678/);
  } finally {
    github.server.close();
  }
});

test("a push to the default branch deploys to production and comments nothing", async () => {
  const ws = workspace({ repository: { default_branch: "main" }, head_commit: { message: "TEST merge" } });
  const result = await runStep(ws, null, { GITHUB_REF: "refs/heads/main", FAKE_STDOUT: JSON.stringify({ ...PREVIEW, promoted: true }) });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(ws.dir, "record.json"), "utf8")).args.slice(-1), ["--prod"]);
  assert.equal(readOutputs(ws).promoted, "true");
  assert.match(result.stdout, /Deployed to production — #7 abcd1234/);
});

test("a failed deploy fails the step with the CLI's error, in the log and on the pull request", async () => {
  const github = await fakeGitHub();
  const ws = workspace(PR_EVENT);
  try {
    const result = await runStep(ws, github, { FAKE_STDOUT: "", FAKE_STDERR: "jojapi: TEST build failed: No such module \"lib/x.mjs\"\n", FAKE_CODE: "1" });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /::error title=JoJ API deploy failed::TEST build failed: No such module "lib\/x.mjs"/);
    assert.equal(readOutputs(ws).status, "failed");
    assert.match(github.comments[0].body, /Deployment failed[\s\S]*TEST build failed/);
  } finally {
    github.server.close();
  }
});

test("without a token: pull requests from forks and Dependabot are skipped; anything else fails clearly", async () => {
  const fork = workspace({ ...PR_EVENT, pull_request: { ...PR_EVENT.pull_request, head: { sha: "a".repeat(40), repo: { full_name: "someone/r" } } } });
  const skipped = await runStep(fork, null, { JOJAPI_TOKEN: "" });
  assert.equal(skipped.code, 0);
  assert.match(skipped.stdout, /::notice title=JoJ API::Pull requests from forks and Dependabot/);
  assert.equal(readOutputs(fork).status, "skipped");

  const dependabot = workspace({ ...PR_EVENT, pull_request: { ...PR_EVENT.pull_request, head: { sha: "a".repeat(40), repo: { full_name: "o/r" } } } });
  assert.equal((await runStep(dependabot, null, { JOJAPI_TOKEN: "", GITHUB_ACTOR: "dependabot[bot]" })).code, 0);

  // A pull request of the repository itself with an unset or empty secret
  const own = workspace({ ...PR_EVENT, pull_request: { ...PR_EVENT.pull_request, head: { sha: "a".repeat(40), repo: { full_name: "o/r" } } } });
  const misconfigured = await runStep(own, null, { JOJAPI_TOKEN: " ", GITHUB_ACTOR: "someone" });
  assert.equal(misconfigured.code, 1);
  assert.match(misconfigured.stdout, /::error title=JoJ API::The token input is empty: the secret passed as token is not set or empty/);

  const push = workspace({ repository: { default_branch: "main" } });
  const failed = await runStep(push, null, { JOJAPI_TOKEN: "", GITHUB_REF: "refs/heads/main" });
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /::error title=JoJ API::The token input is empty/);
});

test("a comment that cannot be written warns but keeps the deploy green", async () => {
  const ws = workspace({ ...PR_EVENT, pull_request: { ...PR_EVENT.pull_request, number: 6 } });
  const github = await fakeGitHub();
  try {
    const result = await runStep(ws, github, {});
    assert.equal(result.code, 0);
    assert.match(result.stdout, /::warning title=JoJ API::Could not comment on the pull request: GET .*HTTP 404 Not Found/);
  } finally {
    github.server.close();
  }
});
