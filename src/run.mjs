// The action's deploy step: runs `jojapi deploy --json` from @jojapi/cli and
// reports the result as step outputs, the job summary, annotations and a pull
// request comment. Node built-ins only, so the action needs no build step.
//
// Environment (set by action.yml): JOJAPI_TOKEN (only this reaches the CLI,
// never printed), INPUT_PRODUCTION, INPUT_MESSAGE, INPUT_COMMENT,
// INPUT_GITHUB_TOKEN, INPUT_CLI_VERSION, plus the runner's GITHUB_* variables.

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function readEvent(env) {
  try {
    return env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : {};
  } catch {
    return {};
  }
}

// auto: production for runs on the default branch that are not pull requests
export function wantsProduction(input, env, event) {
  const value = String(input ?? "").trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value !== "auto" && value !== "") throw new Error(`production must be auto, true or false, not "${input}"`);
  if (event.pull_request) return false;
  const branch = event.repository?.default_branch;
  return Boolean(branch) && env.GITHUB_REF === `refs/heads/${branch}`;
}

// Runs that GitHub starts without the repository's secrets: pull requests
// from forks and Dependabot's. Anywhere else an empty token is a mistake.
export function withoutSecrets(env, event) {
  const pr = event.pull_request;
  if (!pr) return false;
  const head = pr.head?.repo?.full_name;
  if (head && env.GITHUB_REPOSITORY && head !== env.GITHUB_REPOSITORY) return true;
  return env.GITHUB_ACTOR === "dependabot[bot]" || pr.user?.login === "dependabot[bot]";
}

export function cliArgs({ version, production, message }) {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) throw new Error(`cli-version must be an npm version or tag, not "${version}"`);
  const args = ["--yes", `@jojapi/cli@${version}`, "deploy", "--json"];
  if (production) args.push("--prod");
  // One argument, so a message starting with "--" stays a message
  if (message) args.push(`--message=${message}`);
  return args;
}

// The CLI prints one JSON line on stdout; its errors go to stderr
export function parseResult(code, stdout, stderr) {
  const line = stdout.trim().split("\n").filter(Boolean).pop();
  let result = null;
  try {
    result = line ? JSON.parse(line) : null;
  } catch {
    result = null;
  }
  if (result && typeof result.status === "string") {
    if (result.status === "deployed" || result.status === "unchanged") return result;
    // A failed build, or a refusal of the Management API ({status, message, errors})
    const errors = Array.isArray(result.errors) ? result.errors.filter((e) => typeof e === "string") : [];
    const message = [result.message || errorText(stderr) || result.status, ...errors.slice(1)].join("\n");
    return { ...result, status: "failed", message };
  }
  return { status: "failed", message: errorText(stderr) ?? `@jojapi/cli exited with code ${code}` };
}

function errorText(stderr) {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const own = lines.filter((l) => l.startsWith("jojapi: ")).pop();
  if (own) return own.slice("jojapi: ".length);
  return lines.length > 0 ? lines.slice(-5).join("\n") : null;
}

export function outputs(result) {
  const deployment = result.deployment ?? null;
  return {
    status: result.status,
    url: deployment?.url ?? "",
    "deployment-id": deployment?.id ?? "",
    "deployment-number": deployment?.number != null ? String(deployment.number) : "",
    "preview-url": result.preview_url ?? "",
    promoted: result.promoted === true ? "true" : "false",
  };
}

export function headline(result) {
  switch (result.status) {
    case "deployed":
      return result.promoted ? "Deployed to production" : "Preview deployment ready";
    case "unchanged":
      return "Nothing to deploy: the files match the platform";
    case "skipped":
      return "Skipped: no JoJ API token";
    default:
      return "Deployment failed";
  }
}

// Markdown for the job summary and the pull request comment
export function report(result, context) {
  const lines = [`**JoJ API** · \`${context.slug}\` · ${headline(result)}`, ""];
  const deployment = result.deployment ?? null;
  if (result.status === "deployed" && deployment?.url) {
    lines.push("| Deployment | URL |", "| --- | --- |", `| #${deployment.number} \`${deployment.id}\` | ${deployment.url} |`, "");
  }
  if (result.status === "failed") {
    lines.push("```", String(result.message ?? "").replaceAll("```", "``​`"), "```", "");
  } else if (result.message) {
    lines.push(`> ${result.message}`, "");
  }
  if (result.switched_to_code) {
    lines.push("The API switched from its template to code mode; **Back to template** in the Studio restores it.", "");
  }
  const facts = [];
  if (result.status === "deployed" && result.preview_url && !result.promoted) facts.push(`Latest preview: ${result.preview_url}`);
  if (context.commit) facts.push(`Commit ${context.commit.slice(0, 7)}`);
  if (context.runUrl) facts.push(`[Workflow run](${context.runUrl})`);
  if (facts.length > 0) lines.push(facts.join(" · "), "");
  if (result.status === "deployed" && !result.promoted) {
    lines.push(`Callable with the API keys of the account that owns the API. Merging into \`${context.defaultBranch}\` deploys to production.`);
  } else if (result.status === "failed") {
    lines.push("Production is unchanged.");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export function commentMarker(slug) {
  return `<!-- jojapi-deploy-action: ${slug} -->`;
}

// One comment per API and pull request, edited on every run
export async function upsertComment({ apiUrl, repository, pr, token, marker, body }) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": "jojapi-deploy-action",
    "x-github-api-version": "2022-11-28",
  };
  const call = async (method, path, payload) => {
    const res = await fetch(`${apiUrl}${path}`, { method, headers, body: payload ? JSON.stringify(payload) : undefined });
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 200);
      try {
        message = JSON.parse(text).message ?? message;
      } catch {}
      const error = new Error(`${method} ${path}: HTTP ${res.status} ${message}`);
      error.status = res.status;
      throw error;
    }
    return text ? JSON.parse(text) : null;
  };
  let existing = null;
  for (let page = 1; existing === null; page++) {
    const list = await call("GET", `/repos/${repository}/issues/${pr}/comments?per_page=100&page=${page}`);
    existing = list.find((c) => typeof c.body === "string" && c.body.includes(marker)) ?? null;
    if (list.length < 100) break;
  }
  const full = `${marker}\n${body}`;
  if (existing) {
    await call("PATCH", `/repos/${repository}/issues/comments/${existing.id}`, { body: full });
    return "updated";
  }
  await call("POST", `/repos/${repository}/issues/${pr}/comments`, { body: full });
  return "created";
}

// Workflow commands: https://docs.github.com/actions/reference/workflow-commands-for-github-actions
function escapeData(text) {
  return String(text).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}
function annotate(level, message, title = "JoJ API") {
  console.log(`::${level} title=${title}::${escapeData(message)}`);
}

function writeOutputs(env, values) {
  if (!env.GITHUB_OUTPUT) return;
  const text = Object.entries(values).map(([key, value]) => `${key}=${String(value).replace(/[\r\n]+/g, " ")}\n`).join("");
  appendFileSync(env.GITHUB_OUTPUT, text);
}

function readSlug(dir) {
  try {
    const slug = JSON.parse(readFileSync(join(dir, "jojapi.json"), "utf8")).slug;
    return typeof slug === "string" && slug !== "" ? slug : null;
  } catch {
    return null;
  }
}

function runCli(args, env) {
  // Only the jojapi token reaches the CLI; the GitHub token and inputs stay here
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("INPUT_")));
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("npx", args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      stderr = (stderr + chunk).slice(-65536);
    });
    child.on("error", (err) => resolve({ code: 127, stdout, stderr: `${stderr}\njojapi: could not run npx: ${err.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function main(env = process.env) {
  const event = readEvent(env);
  const pr = event.pull_request ?? null;
  const slug = readSlug(process.cwd()) ?? "api";

  let production;
  let args;
  try {
    production = wantsProduction(env.INPUT_PRODUCTION, env, event);
    args = cliArgs({ version: String(env.INPUT_CLI_VERSION ?? "").trim(), production, message: String(env.INPUT_MESSAGE ?? "").trim() });
  } catch (err) {
    annotate("error", err.message);
    return 1;
  }

  if (!String(env.JOJAPI_TOKEN ?? "").trim()) {
    if (withoutSecrets(env, event)) {
      annotate("notice", "Pull requests from forks and Dependabot run without the repository's secrets, so nothing was deployed.");
      writeOutputs(env, outputs({ status: "skipped" }));
      return 0;
    }
    annotate(
      "error",
      "The token input is empty: the secret passed as token is not set or empty in this repository. " +
        "Paste the Management API token under Settings → Secrets and variables → Actions (or run gh secret set and paste it at the prompt: " +
        "piping an unset shell variable into gh secret set stores an empty secret without an error).",
    );
    return 1;
  }

  console.log(`JoJ API: deploying ${slug} as ${production ? "production" : "a preview"} with @jojapi/cli@${env.INPUT_CLI_VERSION}`);
  const { code, stdout, stderr } = await runCli(args, env);
  const result = parseResult(code, stdout, stderr);
  writeOutputs(env, outputs(result));

  const context = {
    slug,
    commit: pr?.head?.sha ?? env.GITHUB_SHA ?? "",
    runUrl: env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : "",
    defaultBranch: event.repository?.default_branch ?? "the default branch",
  };
  const body = report(result, context);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, body + "\n");

  const deployment = result.deployment ?? null;
  if (result.status === "deployed") {
    console.log(`JoJ API: ${headline(result)}${deployment ? ` — #${deployment.number} ${deployment.id} ${deployment.url}` : ""}`);
    if (result.message) annotate("warning", result.message);
  } else if (result.status === "unchanged") {
    annotate("notice", headline(result));
  } else {
    annotate("error", result.message, "JoJ API deploy failed");
  }

  const commentWanted = String(env.INPUT_COMMENT ?? "true").trim().toLowerCase() !== "false";
  if (pr?.number && commentWanted && (result.status === "deployed" || result.status === "failed")) {
    try {
      const done = await upsertComment({
        apiUrl: env.GITHUB_API_URL || "https://api.github.com",
        repository: env.GITHUB_REPOSITORY,
        pr: pr.number,
        token: env.INPUT_GITHUB_TOKEN,
        marker: commentMarker(slug),
        body,
      });
      console.log(`JoJ API: pull request comment ${done}`);
    } catch (err) {
      const hint = err.status === 403 || err.status === 404 ? " Give the job `permissions: pull-requests: write`, or set comment: false." : "";
      annotate("warning", `Could not comment on the pull request: ${err.message}.${hint}`);
    }
  }

  return result.status === "failed" ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      annotate("error", err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
