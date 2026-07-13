---
name: collect-gift-codes
description: Crawl public game-community posts within a requested publication-date range, identify real gift-code posts, use Codex semantic analysis to extract structured English-alphanumeric or clearly labelled Chinese gift codes, and write an import JSON for this repository's admin console. Use when asked to collect, crawl, parse, or prepare gift codes from TapTap or other public sources by date range.
---

# Collect Gift Codes

Use this as a manual Codex workflow. Do not call the OpenAI API, read or create an `OPENAI_API_KEY`, or upload to the public server. Codex performs semantic extraction in the active session; the operator logs in to the admin console and imports the resulting JSON.

## Required Input

Obtain a public seed URL and an inclusive publication date range in `YYYY-MM-DD` format. Treat all dates as Asia/Shanghai. Ask for the missing value when either is absent. Treat any direct post URLs supplied by the user as mandatory collection targets in addition to the seed URL.

## Collection Workflow

1. Fetch the seed page only to discover public source data. Do not treat rendered forum page numbers as chronological pagination unless consecutive pages have distinct post IDs and demonstrably advance through publication times.
2. For TapTap forum URLs, query the public `/webapiv2/forum-feed-search/v1/by-keyword` endpoint separately with `kw=兑换码` and `kw=礼包码`, `group_id`, and `sort=created`. Reject `sort=default` forum feeds; they are recommendation streams rather than exhaustive keyword matches.
3. Treat the first response `session_id` and its server-provided `next_page` as a fixed search snapshot. Follow `next_page` exactly until it is absent. Require one stable session ID and no repeated post IDs across pages. Search result ordering does not need to be chronological; after enumeration, filter each item's `publish_time` locally by the requested date range.
4. Produce an import artifact only after both keyword searches have exhausted their snapshots without a repeated ID or session change. If a public endpoint fails, pagination repeats, the session changes, or a configured safety ceiling is reached, stop with `coverage: failed` and do not produce an uploadable candidate file.
5. Fetch direct post URLs supplied by the user even when they are absent from the feed. For every candidate post, retain its canonical URL, title, full visible text, and original publication time. Exclude a post when its publication time cannot be determined or lies outside the requested inclusive date range. Do not substitute an update time for a publication time.
6. Keep only posts whose title or visible body contains `兑换码` or `礼包码`. Remove navigation, comments, app metadata, image hashes, link parameters, user IDs, page numbers, and unrelated boilerplate before analysis.
7. Semantically analyze the retained posts. Extract a code only when the post explicitly establishes that it is an actual game gift code. Accept either uppercase English letters and digits, 5 to 24 characters with at least one letter and one digit, or a 2 to 20 character Chinese phrase explicitly labelled as `兑换码` or `礼包码`.
8. Reject team/invitation codes, URL parameter values, account IDs, dates, post IDs, and image hashes. Do not require a fixed phrase immediately before the code. Preserve a short source excerpt proving the association.
9. Produce a concise player-facing title, the stated reward or `奖励待确认`, an `expireAt` date only when explicit, and a confidence value. Do not invent an expiry date.
10. Deduplicate by normalized code, retaining the strongest evidence and most complete reward or expiry information.

## Import Artifact

Write two JSON files under `docs/imports/`. Create the directory when needed.

- `gift-codes-YYYY-MM-DD.json` is the compact, uploadable candidate file. Keep it below the admin import size limit and include only `candidates` plus collection metadata.
- `gift-codes-YYYY-MM-DD-audit.json` is the inspection artifact. Include `coverage`, counts of all date-range posts, and a `relevantPosts` item for every post whose title or body contains `兑换码` or `礼包码`. Each item must include the URL, publication time, title, short text excerpt, extracted codes, and a decision of `candidate` or `excluded` with a concrete reason. Do not omit a keyword-matched post merely because no code was extracted.

Use this shape for the compact candidate file:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-10T08:00:00.000Z",
  "query": {
    "seedUrl": "https://www.taptap.cn/app/...",
    "publishedFrom": "2026-07-01",
    "publishedTo": "2026-07-10",
    "timezone": "Asia/Shanghai"
  },
  "coverage": {
    "status": "complete",
    "fetchedPosts": 0,
    "reason": "TapTap feed cursor exhausted"
  },
  "candidates": [
    {
      "code": "AM7H5TK",
      "title": "7月10日公开兑换码",
      "reward": "奖励待确认",
      "expireAt": "",
      "sourceUrl": "https://www.taptap.cn/moment/...",
      "sourcePlatform": "taptap",
      "evidence": "帖子正文：今日兑换码 AM7H5TK",
      "confidence": "high"
    }
  ]
}
```

`candidates` may be empty only when the collection coverage is complete. Never put raw full-page HTML, cookies, account data, or secrets into either artifact. Summarize coverage status, fetched count, date-filtered count, relevant-post count, extracted-code count, and excluded-post reasons in the final response. Only direct the operator to import the compact candidate file through `/admin.html`; the audit file is for comparison and rule checks only.
