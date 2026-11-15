"use strict";

// apps/cli/src/register.ts
var import_node_fs = require("node:fs");
var import_node_util = require("node:util");

// apps/cli/src/errors.ts
var UsageError = class extends Error {
};
var ApiError = class extends Error {
};
var TIMEOUT_MS = 3e4;
function isTimeout(e) {
  return e instanceof Error && e.name === "TimeoutError";
}
async function call(fetchFn, label, url, init) {
  let res;
  try {
    res = await fetchFn(url, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (e) {
    throw new ApiError(
      isTimeout(e) ? `${label}: timed out after ${TIMEOUT_MS / 1e3}s` : `${label}: network error`
    );
  }
  let body = {};
  try {
    body = await res.json();
  } catch (e) {
    if (isTimeout(e)) {
      throw new ApiError(`${label}: timed out after ${TIMEOUT_MS / 1e3}s`);
    }
  }
  const parsed = body && typeof body === "object" ? body : {};
  return { status: res.status, body: parsed };
}
function errorCode(body) {
  const e = body["error"];
  return typeof e === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(e) ? e : void 0;
}
var HINTS = {
  project_required: "this repository is linked to projects in the organization; name one with --project or the action input project"
};
function refusal(label, status, body) {
  const code = errorCode(body);
  const hint = code ? HINTS[code] : void 0;
  return new ApiError(
    `${label}: ${status}${code ? ` ${code}` : ""}${hint ? ` (${hint})` : ""}`
  );
}

// apps/cli/src/auth.ts
var AUDIENCE = "https://api.pc.evanion.com";
async function tokenFor(env, scope, apiBase, fetchFn = fetch) {
  const direct = env["PORTCULLIS_TOKEN"];
  if (direct) return direct;
  const requestUrl = env["ACTIONS_ID_TOKEN_REQUEST_URL"];
  const requestToken = env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  if (!requestUrl || !requestToken) {
    throw new UsageError(
      "no credentials: set PORTCULLIS_TOKEN, or run in GitHub Actions with `permissions: id-token: write`"
    );
  }
  const sep = requestUrl.includes("?") ? "&" : "?";
  const issued = await call(
    fetchFn,
    "oidc token request",
    `${requestUrl}${sep}audience=${encodeURIComponent(AUDIENCE)}`,
    { headers: { authorization: `Bearer ${requestToken}` } }
  );
  const jwt = issued.body["value"];
  if (issued.status !== 200 || typeof jwt !== "string" || !jwt) {
    throw refusal("oidc token request", issued.status, {});
  }
  const exchanged = await call(
    fetchFn,
    "oidc exchange",
    `${apiBase.replace(/\/+$/, "")}/v1/oidc/github`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json"
      },
      // An empty env with a project asks for a project-only exchange (a
      // branch close without a base); with neither, an org-wide one.
      body: JSON.stringify(
        scope.env ? { org: scope.org, project: scope.project, env: scope.env } : scope.project ? { org: scope.org, project: scope.project } : { org: scope.org }
      )
    }
  );
  const token = exchanged.body["token"];
  if (exchanged.status !== 201 || typeof token !== "string" || !token) {
    throw refusal("oidc exchange", exchanged.status, exchanged.body);
  }
  return token;
}

// apps/cli/src/register.ts
var DEFAULT_API = "https://api.pc.evanion.com";
var SOURCE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
var FLAG_TYPES = ["release", "experiment", "ops", "permission"];
var TAG = /^[a-z0-9][a-z0-9-]{0,31}$/;
var FIELD_TYPE = /^(string|number|boolean|instant)(\[\])?\??$/;
var FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
function isAllowedApi(api) {
  let u;
  try {
    u = new URL(api);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
}
function parseArgs(argv) {
  let parsed;
  try {
    parsed = (0, import_node_util.parseArgs)({
      args: argv,
      allowPositionals: true,
      options: {
        org: { type: "string" },
        project: { type: "string" },
        env: { type: "string" },
        source: { type: "string" },
        api: { type: "string" }
      }
    });
  } catch (e) {
    throw new UsageError(e.message);
  }
  const positionals = [...parsed.positionals];
  if (positionals[0] === "register") positionals.shift();
  if (positionals.length > 1) {
    throw new UsageError(`unexpected argument "${positionals[1]}"`);
  }
  const v = parsed.values;
  for (const name of ["org", "project", "env", "source"]) {
    if (!v[name]) throw new UsageError(`missing --${name}`);
  }
  if (!SOURCE.test(v.source)) {
    throw new UsageError(
      `--source must match ${SOURCE.source} (got "${v.source}")`
    );
  }
  const api = v.api ?? DEFAULT_API;
  if (!isAllowedApi(api)) {
    throw new UsageError(
      "--api must be an https URL (http only for localhost or 127.0.0.1)"
    );
  }
  return {
    file: positionals[0] ?? "portcullis.json",
    api,
    org: v.org,
    project: v.project,
    env: v.env,
    source: v.source
  };
}
function readFlagFile(path) {
  let text;
  try {
    text = (0, import_node_fs.readFileSync)(path, "utf8");
  } catch {
    throw new UsageError(`cannot read ${path}`);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new UsageError(`${path}: not valid JSON`);
  }
  const bad = (where, what) => new UsageError(`${path}: ${where}: ${what}`);
  const flags = doc?.flags;
  if (!Array.isArray(flags)) throw bad("flags", "must be an array");
  const seen = /* @__PURE__ */ new Set();
  const declared = flags.map((raw, i) => {
    const at = `flags[${i}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw bad(at, "must be an object");
    }
    const f = raw;
    if (typeof f["key"] !== "string" || f["key"] === "") {
      throw bad(`${at}.key`, "must be a non-empty string");
    }
    if (seen.has(f["key"])) throw bad(`${at}.key`, `duplicate "${f["key"]}"`);
    seen.add(f["key"]);
    const out2 = { key: f["key"] };
    if (f["description"] !== void 0) {
      if (typeof f["description"] !== "string") {
        throw bad(`${at}.description`, "must be a string");
      }
      out2.description = f["description"];
    }
    if (f["type"] !== void 0) {
      if (typeof f["type"] !== "string" || !FLAG_TYPES.includes(f["type"])) {
        throw bad(`${at}.type`, `must be one of ${FLAG_TYPES.join(", ")}`);
      }
      out2.type = f["type"];
    }
    if (f["tags"] !== void 0) {
      if (!Array.isArray(f["tags"]))
        throw bad(`${at}.tags`, "must be an array");
      f["tags"].forEach((tag, n) => {
        if (typeof tag !== "string") {
          throw bad(`${at}.tags[${n}]`, "must be a string");
        }
        if (!TAG.test(tag))
          throw bad(`${at}.tags[${n}]`, `must match ${TAG.source}`);
      });
      out2.tags = f["tags"];
    }
    if (f["enabled"] !== void 0) {
      if (typeof f["enabled"] !== "boolean") {
        throw bad(`${at}.enabled`, "must be a boolean");
      }
      out2.enabled = f["enabled"];
    }
    return out2;
  });
  const out = { flags: declared };
  const context = doc.context;
  if (context !== void 0) {
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      throw bad("context", "must be an object");
    }
    for (const [name, type] of Object.entries(context)) {
      if (!FIELD_NAME.test(name) || name === "now") {
        throw bad(`context.${name}`, "not a valid field name");
      }
      if (typeof type !== "string" || !FIELD_TYPE.test(type)) {
        throw bad(
          `context.${name}`,
          "must be one of string, number, boolean or instant, optionally followed by [] and ?"
        );
      }
    }
    out.context = context;
  }
  const acl = doc.acl;
  if (acl !== void 0) out.acl = readAcl(acl, bad);
  const entitlements = doc.entitlements;
  if (entitlements !== void 0)
    out.entitlements = readEntitlements(entitlements, bad);
  return out;
}
var FEATURE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
var FEATURE_KINDS = ["boolean", "limit", "metered"];
var RESETS = ["period", "month", "never"];
function readEntitlements(value, bad) {
  if (!isObject(value)) throw bad("entitlements", "must be an object");
  for (const key of Object.keys(value))
    if (key !== "features")
      throw bad(
        `entitlements.${key}`,
        key === "plans" ? "plans are never declared in code; edit them in the console, where they are reviewed" : "unknown member"
      );
  const features = value["features"];
  if (!Array.isArray(features))
    throw bad("entitlements.features", "must be an array");
  const seen = /* @__PURE__ */ new Set();
  return {
    features: features.map((raw, i) => {
      const at = `entitlements.features[${i}]`;
      if (!isObject(raw)) throw bad(at, "must be an object");
      for (const member of Object.keys(raw))
        if (!["key", "kind", "unit", "gauge", "reset", "description"].includes(
          member
        ))
          throw bad(`${at}.${member}`, "unknown member");
      const { key, kind, unit, gauge, reset, description } = raw;
      if (typeof key !== "string" || !FEATURE_KEY.test(key))
        throw bad(`${at}.key`, "must be a flag key");
      if (seen.has(key)) throw bad(`${at}.key`, `duplicate "${key}"`);
      seen.add(key);
      if (typeof kind !== "string" || !FEATURE_KINDS.includes(kind))
        throw bad(`${at}.kind`, `must be one of ${FEATURE_KINDS.join(", ")}`);
      const out = {
        key,
        kind
      };
      if (kind !== "boolean") {
        if (typeof unit !== "string" || unit === "")
          throw bad(`${at}.unit`, "must be a non-empty string");
        out.unit = unit;
      } else if (unit !== void 0)
        throw bad(`${at}.unit`, "only for limit and metered");
      if (gauge !== void 0) {
        if (kind !== "limit" || typeof gauge !== "boolean")
          throw bad(`${at}.gauge`, "a boolean, only for limit");
        out.gauge = gauge;
      }
      if (kind === "metered") {
        if (typeof reset !== "string" || !RESETS.includes(reset))
          throw bad(`${at}.reset`, `must be one of ${RESETS.join(", ")}`);
        out.reset = reset;
      } else if (reset !== void 0)
        throw bad(`${at}.reset`, "only for metered");
      if (description !== void 0) {
        if (typeof description !== "string")
          throw bad(`${at}.description`, "must be a string");
        out.description = description;
      }
      return out;
    })
  };
}
var isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
function readShape(value, at, bad) {
  if (!isObject(value)) throw bad(at, "must be an object");
  for (const key of Object.keys(value)) {
    if (key !== "fields" && key !== "relations") {
      throw bad(`${at}.${key}`, "unknown member");
    }
  }
  const shape = {};
  for (const member of ["fields", "relations"]) {
    const given = value[member];
    if (given === void 0) continue;
    if (!isObject(given)) throw bad(`${at}.${member}`, "must be an object");
    for (const [name, v] of Object.entries(given)) {
      const where = `${at}.${member}.${name}`;
      if (!FIELD_NAME.test(name)) throw bad(where, "not a valid field name");
      if (member === "fields") {
        if (typeof v !== "string" || !FIELD_TYPE.test(v)) {
          throw bad(
            where,
            "must be one of string, number, boolean or instant, optionally followed by [] and ?"
          );
        }
      } else if (typeof v !== "string" || !FIELD_NAME.test(v)) {
        throw bad(where, "must be an object kind");
      }
    }
    shape[member] = given;
  }
  return shape;
}
function readAcl(acl, bad) {
  if (!isObject(acl)) throw bad("acl", "must be an object");
  for (const key of Object.keys(acl)) {
    if (key !== "subject" && key !== "objects") {
      throw bad(`acl.${key}`, "unknown member");
    }
  }
  const out = {};
  if (acl["subject"] !== void 0) {
    out.subject = readShape(acl["subject"], "acl.subject", bad);
  }
  const objects = acl["objects"];
  if (objects !== void 0) {
    if (!isObject(objects)) throw bad("acl.objects", "must be an object");
    out.objects = {};
    for (const [kind, shape] of Object.entries(objects)) {
      if (!FIELD_NAME.test(kind)) {
        throw bad(`acl.objects.${kind}`, "not a valid object kind");
      }
      out.objects[kind] = readShape(shape, `acl.objects.${kind}`, bad);
    }
  }
  return out;
}
async function register(apiBase, scope, source, declared, token, fetchFn = fetch) {
  const { org, project, env } = scope;
  const url = `${apiBase.replace(/\/+$/, "")}/v1/orgs/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(env)}/documents/feature/register`;
  const res = await call(fetchFn, "register", url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ source, ...declared })
  });
  if (res.status !== 200 && res.status !== 201) {
    throw refusal("register", res.status, res.body);
  }
  if (typeof res.body["changed"] !== "boolean") {
    throw new ApiError("register: unexpected response");
  }
  return res.body;
}
function summary(scope, r) {
  const where = `${scope.project}/${scope.env}`;
  const kept = r.kept?.length ? `, kept ${r.kept.length}` : "";
  const flags = r.changed ? `registered ${r.added?.length ?? 0}, archived ${r.archived?.length ?? 0}, restored ${r.restored?.length ?? 0}${kept} in ${where} (release ${r.releaseId})` : `no changes in ${where}${kept}`;
  const skipped = r.context?.skipped.length ? `, skipped ${r.context.skipped.map((s) => `${s.env} (${s.reason})`).join(", ")}` : "";
  const context = r.context?.changed ? `; context released to ${r.context.released.length} environments${skipped}` : skipped ? `; context${skipped.slice(1)}` : "";
  const aclSkipped = r.acl?.skipped.length ? `, skipped ${r.acl.skipped.map((s) => `${s.env} (${s.reason})`).join(", ")}` : "";
  const acl = r.acl?.changed ? `; access schema released to ${r.acl.released.length} environments${aclSkipped}` : aclSkipped ? `; access schema${aclSkipped.slice(1)}` : "";
  const entitlements = r.entitlements?.added.length ? `; ${r.entitlements.added.length} entitlement features added to the catalog` : "";
  const warnings = (r.warnings ?? []).map((w) => `
warning: ${w.message}`);
  return flags + context + acl + entitlements + warnings.join("");
}
async function run(argv, env, fetchFn = fetch) {
  try {
    const args = parseArgs(argv);
    const declared = readFlagFile(args.file);
    const token = await tokenFor(env, args, args.api, fetchFn);
    const result = await register(
      args.api,
      args,
      args.source,
      declared,
      token,
      fetchFn
    );
    return { code: 0, out: summary(args, result) };
  } catch (e) {
    if (e instanceof UsageError)
      return { code: 1, out: `portcullis: ${e.message}` };
    if (e instanceof ApiError)
      return { code: 2, out: `portcullis: ${e.message}` };
    return { code: 2, out: "portcullis: unexpected error" };
  }
}

// apps/cli/src/action.ts
function runAction(env, fetchFn = fetch) {
  const input = (name) => (env[`INPUT_${name}`] ?? "").trim();
  const argv = [
    input("FILE") || "portcullis.json",
    "--api",
    input("API") || DEFAULT_API
  ];
  for (const name of ["org", "project", "env", "source"]) {
    const value = input(name.toUpperCase());
    if (value) argv.push(`--${name}`, value);
  }
  return run(argv, env, fetchFn);
}

// apps/cli/src/action-main.ts
void runAction(process.env).then(({ code, out }) => {
  if (code === 0) {
    console.log(out);
  } else {
    console.log(`::error::${out.replace(/[\r\n]+/g, " ")}`);
  }
  process.exitCode = code;
});
