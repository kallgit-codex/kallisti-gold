// GitHub Sync - Persist ledger across Railway redeploys
// Reads/writes data/ledger.json to GitHub repo
// v3.1: Added 409 conflict retry (re-fetch SHA on conflict)

import { readFile, writeFile, mkdir } from "fs/promises";
import { log, error } from "./logger";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const REPO = process.env.GITHUB_REPO || "kallgit-codex/kallisti-scalper";
const BRANCH = process.env.GITHUB_BRANCH || "data";
const LEDGER_PATH = "data/ledger.json";
const LOCAL_LEDGER = "./data/ledger.json";

export class GitHubSync {
  private sha: string = "";

  constructor() {
    log(`📡 GitHub Sync: repo=${REPO} branch=${BRANCH} token=${GITHUB_TOKEN ? "SET (" + GITHUB_TOKEN.slice(0, 6) + "...)" : "MISSING"}`);
  }

  private get headers() {
    return {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    };
  }

  /** Fetch current SHA from GitHub */
  private async fetchRemoteSha(): Promise<string> {
    try {
      const resp = await fetch(
        `https://api.github.com/repos/${REPO}/contents/${LEDGER_PATH}?ref=${BRANCH}`,
        { headers: this.headers }
      );
      if (resp.ok) {
        const data: any = await resp.json();
        return data.sha;
      }
    } catch {}
    return "";
  }

  async pullLedger(): Promise<boolean> {
    if (!GITHUB_TOKEN) {
      log("⚠️  No GITHUB_TOKEN, skipping sync");
      return false;
    }

    try {
      const resp = await fetch(
        `https://api.github.com/repos/${REPO}/contents/${LEDGER_PATH}?ref=${BRANCH}`,
        { headers: this.headers }
      );

      if (!resp.ok) {
        log(`📥 No remote ledger found (${resp.status}), starting fresh`);
        return false;
      }

      const data: any = await resp.json();
      this.sha = data.sha;

      // Decode base64 content
      const content = atob(data.content.replace(/\n/g, ""));

      // Ensure directory exists
      await mkdir("./data", { recursive: true });
      await writeFile(LOCAL_LEDGER, content);

      log(`📥 Pulled ledger from GitHub (sha: ${this.sha.slice(0, 7)})`);
      return true;
    } catch (err) {
      error(`GitHub pull failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async pushLedger(): Promise<boolean> {
    if (!GITHUB_TOKEN) {
      log("⚠️  No GITHUB_TOKEN, cannot push ledger");
      return false;
    }

    // Try up to 2 times (retry once on SHA conflict)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const content = await readFile(LOCAL_LEDGER, "utf-8");
        const encoded = btoa(content);

        // Get current SHA if we don't have it
        if (!this.sha) {
          this.sha = await this.fetchRemoteSha();
        }

        const body: any = {
          message: `📊 ledger sync ${new Date().toISOString().slice(0, 19)}`,
          content: encoded,
          branch: BRANCH,
        };

        if (this.sha) {
          body.sha = this.sha;
        }

        const resp = await fetch(
          `https://api.github.com/repos/${REPO}/contents/${LEDGER_PATH}`,
          {
            method: "PUT",
            headers: this.headers,
            body: JSON.stringify(body),
          }
        );

        if (resp.status === 409 && attempt === 0) {
          // SHA conflict — re-fetch and retry
          log("⚠️  SHA conflict on push, re-fetching SHA and retrying...");
          this.sha = await this.fetchRemoteSha();
          continue;
        }

        if (!resp.ok) {
          const errText = await resp.text();
          error(`GitHub push failed (${resp.status}): ${errText}`);
          return false;
        }

        const result: any = await resp.json();
        this.sha = result.content.sha;
        log(`📤 Ledger synced to GitHub (sha: ${this.sha.slice(0, 7)})`);
        return true;
      } catch (err) {
        error(`GitHub push error: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    }

    return false;
  }
}
