// Preflight for the official Qase reporter in testops mode. The reporter only logs a missing token and drops results
// for unknown case ids at the end of the run; here they are one line before anything runs.
// shortcut: reads env only (QASE_*), not qase.config.json, and ignores project-mapping tags; extend when used.

import { existsSync } from "node:fs";

/** Whether to load the reporter at all: in mode "off" it still prints a line per test. */
export const qaseOn = (env = process.env) => (env.QASE_MODE ?? "off") !== "off" || existsSync("qase.config.json");

/** Case ids from the official tags `@QaseID=1,2` and legacy `@Q-1` (same patterns as the reporter's TagParser). */
export const qaseIds = (tags: string[]) => tags.flatMap(t =>
  (/^@[Qq]ase[Ii][Dd]=(\d+(?:,\d+)*)$/.exec(t)?.[1] ?? /^@[Qq]-?(\d+)$/.exec(t)?.[1] ?? "").split(",").filter(Boolean).map(Number));

export async function qasePreflight(scenarios: { name: string; tags: string[] }[], env: Record<string, string | undefined> = process.env): Promise<string | undefined> {
  if (env.QASE_MODE !== "testops") return;
  const { QASE_TESTOPS_API_TOKEN: token, QASE_TESTOPS_PROJECT: project, QASE_TESTOPS_API_HOST: host = "qase.io" } = env;
  if (!token) return "QASE_TESTOPS_API_TOKEN is not set (QASE_MODE=testops).";
  if (!project) return "QASE_TESTOPS_PROJECT is not set (QASE_MODE=testops).";
  // Same host rules as qase-javascript-commons: a full URL as is, "qase.io" -> api.qase.io, other hosts -> api-<host>.
  const base = /^https?:\/\//.test(host) ? host.replace(/\/+$/, "") : host === "qase.io" ? "https://api.qase.io" : `https://api-${host}`;
  const cases = [...new Map(scenarios.flatMap(s => qaseIds(s.tags).map(id => [id, s.name] as const))).entries()];
  const check = async (id: number) => {
    try {
      return (await fetch(`${base}/v1/case/${project}/${id}`, { headers: { Token: token } })).status;
    } catch (err) {
      return `Cannot reach Qase at ${base}: ${(err as Error).message}`;
    }
  };
  const statuses = await Promise.all(cases.map(([id]) => check(id)));
  for (const [i, status] of statuses.entries()) {
    const [id, name] = cases[i];
    if (typeof status === "string") return status;
    if (status === 401 || status === 403) return `Qase rejected QASE_TESTOPS_API_TOKEN (${status}) for project ${project}.`;
    if (status === 404) return `Qase case ${project}-${id} not found (scenario "${name}", @QaseID=${id}).`;
    if (status !== 200) return `Qase API error ${status} checking case ${project}-${id}.`;
  }
}
