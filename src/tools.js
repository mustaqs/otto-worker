/**
 * Otto's slim tools, mapped to Composio's actions (SPEC.md A76, decision 2;
 * six more apps at A77).
 *
 * PURE FUNCTIONS, no bindings, no fetch: each maps one of Otto's cloud tool
 * names and its arguments to one Composio action slug and its arguments, with
 * every parameter the user never said filled in here — from the user's day,
 * or from the DEFAULTS the connect callback recorded for the app (A77: the
 * GitHub login, the GitLab projects, the Jira projects, the Linear user and
 * teams); and each compacts Composio's reply to the few fields the model
 * needs. Nothing here logs, and nothing here is on the question path —
 * Bench/check-tool-path.sh asserts the file imports nothing and reads no `env`.
 *
 * The Composio schemas these fill were read from the API when the mapping was
 * designed (2026-09-14 for the A77 set); a field name that turns out to differ
 * shows up as an empty compact result, never as an error the user sees, and
 * is corrected from the live reply as the Gmail snippet was.
 */

/** The cloud tools by Otto's name. Mac tools never reach the Worker. */
export const CLOUD_TOOLS = {
  gmail_send:   { app: "gmail", slug: "GMAIL_SEND_EMAIL",             kind: "write" },
  gmail_search: { app: "gmail", slug: "GMAIL_FETCH_EMAILS",           kind: "read" },
  gcal_list:    { app: "gcal",  slug: "GOOGLECALENDAR_EVENTS_LIST",   kind: "read" },
  gcal_create:  { app: "gcal",  slug: "GOOGLECALENDAR_CREATE_EVENT",  kind: "create" },
  slack_post:   { app: "slack", slug: "SLACK_SEND_MESSAGE",           kind: "write" },
  slack_read:   { app: "slack", slug: "SLACK_SEARCH_MESSAGES",        kind: "read" },

  github_create_issue:   { app: "github", slug: "GITHUB_CREATE_AN_ISSUE",                               kind: "create" },
  github_my_issues:      { app: "github", slug: "GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER", kind: "read" },
  github_pull_requests:  { app: "github", slug: "GITHUB_LIST_PULL_REQUESTS",                            kind: "read" },
  gitlab_create_issue:   { app: "gitlab", slug: "GITLAB_CREATE_PROJECT_ISSUE",                          kind: "create" },
  gitlab_merge_requests: { app: "gitlab", slug: "GITLAB_GET_PROJECT_MERGE_REQUESTS",                    kind: "read" },
  jira_create_issue:     { app: "jira",   slug: "JIRA_CREATE_ISSUE",                                    kind: "create" },
  jira_my_issues:        { app: "jira",   slug: "JIRA_SEARCH_ISSUES",                                   kind: "read" },
  jira_comment:          { app: "jira",   slug: "JIRA_ADD_COMMENT",                                     kind: "write" },
  gdrive_find:           { app: "gdrive", slug: "GOOGLEDRIVE_FIND_FILE",                                kind: "read" },
  gdrive_create_doc:     { app: "gdrive", slug: "GOOGLEDRIVE_CREATE_FILE_FROM_TEXT",                    kind: "create" },
  notion_find_page:      { app: "notion", slug: "NOTION_SEARCH_NOTION_PAGE",                            kind: "read" },
  notion_create_page:    { app: "notion", slug: "NOTION_CREATE_NOTION_PAGE",                            kind: "create" },
  notion_append:         { app: "notion", slug: "NOTION_ADD_MULTIPLE_PAGE_CONTENT",                     kind: "write" },
  linear_create_issue:   { app: "linear", slug: "LINEAR_CREATE_LINEAR_ISSUE",                           kind: "create" },
  linear_my_issues:      { app: "linear", slug: "LINEAR_LIST_LINEAR_ISSUES",                            kind: "read" },
  linear_comment:        { app: "linear", slug: "LINEAR_CREATE_LINEAR_COMMENT",                         kind: "write" },

  // Never listed to the model: Otto's own undo of a create, by the id the
  // create returned (A76, decision 3 as approved; A77 for the four new ones).
  gcal_delete:    { app: "gcal",   slug: "GOOGLECALENDAR_DELETE_EVENT",                       kind: "delete" },
  jira_delete:    { app: "jira",   slug: "JIRA_DELETE_ISSUE",                                 kind: "delete" },
  gdrive_delete:  { app: "gdrive", slug: "GOOGLEDRIVE_GOOGLE_DRIVE_DELETE_FOLDER_OR_FILE_ACTION", kind: "delete" },
  notion_archive: { app: "notion", slug: "NOTION_ARCHIVE_NOTION_PAGE",                        kind: "delete" },
  linear_archive: { app: "linear", slug: "LINEAR_DELETE_LINEAR_ISSUE",                        kind: "delete" },
};

/** The cloud apps, in the catalog's order. The header lists connected ones first, in connect order. */
export const APPS = ["gmail", "gcal", "slack", "github", "gitlab", "jira", "gdrive", "notion", "linear"];

const str = (v) => (typeof v === "string" ? v.trim() : "");
const int = (v, fallback) => (Number.isInteger(v) ? v : fallback);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const list = (v) => str(v).split(",").map((s) => s.trim()).filter(Boolean);
const lower = (v) => str(v).toLowerCase();

/**
 * A refusal the Worker turns into `needs_detail` with a hint: a default the
 * user never said and the connection does not know — which repository,
 * project or team. Otto speaks the hint.
 */
export class NeedsDetail {
  constructor(hint) { this.hint = hint; }
}

/**
 * Composio's arguments for one of Otto's calls. `now` and `tz` come from the
 * app so defaults are computed in the user's day, not the Worker's;
 * `defaults` is what the connect callback recorded for the app (A77), or
 * nothing for a connection made before it existed. Returns null for an
 * unknown tool and throws NeedsDetail when a required default is missing.
 */
export function composioArguments(tool, input, now, tz, defaults = null) {
  const a = input && typeof input === "object" ? input : {};
  const d = defaults && typeof defaults === "object" ? defaults : {};
  switch (tool) {
    case "gmail_send":
      return {
        recipient_email: str(a.to),
        subject: str(a.subject),
        body: str(a.body),
        cc: list(a.cc),
        is_html: false,
        user_id: "me",
      };
    case "gmail_search":
      return {
        query: str(a.query) || "in:inbox",
        max_results: clamp(int(a.max, 5), 1, 10),
        verbose: false,
        include_payload: false,
        ids_only: false,
        user_id: "me",
      };
    case "gcal_list":
      return {
        timeMin: str(a.from) || now,
        timeMax: str(a.to) || endOfDay(now, tz),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 20,
        calendarId: "primary",
      };
    case "gcal_create": {
      const minutes = clamp(int(a.minutes, 30), 1, 24 * 60 * 30);
      const attendees = list(a.attendees);
      const args = {
        summary: str(a.title),
        start_datetime: naive(str(a.start)),
        timezone: tz,
        event_duration_hour: Math.floor(minutes / 60),
        event_duration_minutes: minutes % 60,
        calendar_id: "primary",
      };
      if (attendees.length) { args.attendees = attendees; args.send_updates = "all"; }
      if (str(a.location)) args.location = str(a.location);
      return args;
    }
    case "slack_post":
      return {
        channel: str(a.channel).replace(/^#/, ""),
        markdown_text: str(a.text),
      };
    case "slack_read":
      return {
        query: `in:#${str(a.channel).replace(/^#/, "")}`,
        count: clamp(int(a.count, 20), 1, 50),
        sort: "timestamp",
        sort_dir: "desc",
      };
    case "gcal_delete":
      if (!str(a.id)) return null;
      return { event_id: str(a.id), calendar_id: "primary" };

    // ---- GitHub: a bare repository name is the user's own (A77)
    case "github_create_issue": {
      const { owner, repo } = githubRepo(a.repo, d);
      const args = { owner, repo, title: str(a.title) };
      if (str(a.body)) args.body = str(a.body);
      return args;
    }
    case "github_my_issues": {
      const filter = ["assigned", "created", "mentioned"].includes(str(a.filter)) ? str(a.filter) : "assigned";
      return { filter, state: "open", sort: "updated", direction: "desc", pulls: false,
               per_page: clamp(int(a.max, 10), 1, 20), page: 1 };
    }
    case "github_pull_requests": {
      const { owner, repo } = githubRepo(a.repo, d);
      return { owner, repo, state: "open", sort: "updated", direction: "desc",
               per_page: clamp(int(a.max, 10), 1, 20), page: 1 };
    }

    // ---- GitLab: a bare project name is matched against the projects the
    // connection listed; a path is used as is, URL-encoded.
    case "gitlab_create_issue": {
      const args = { id: gitlabProject(a.project, d), title: str(a.title), issue_type: "issue" };
      if (str(a.description)) args.description = str(a.description);
      return args;
    }
    case "gitlab_merge_requests":
      return { id: gitlabProject(a.project, d), state: "opened", scope: "all",
               order_by: "updated_at", sort: "desc", view: "simple",
               per_page: clamp(int(a.max, 10), 1, 20) };

    // ---- Jira: a key, a name matched against the connection's projects, or
    // the first project as the default.
    case "jira_create_issue": {
      const type = ["Task", "Bug", "Story"].includes(str(a.type)) ? str(a.type) : "Task";
      const args = { project_key: jiraProject(a.project, d, true), summary: str(a.title), issue_type: type };
      if (str(a.description)) args.description = str(a.description);
      return args;
    }
    case "jira_my_issues": {
      const who = str(a.filter) === "reported" ? "reporter" : "assignee";
      const clauses = [`${who} = currentUser()`, "resolution = Unresolved"];
      if (str(a.project)) clauses.unshift(`project = "${jiraProject(a.project, d, false)}"`);
      return { jql: `${clauses.join(" AND ")} ORDER BY updated DESC`,
               max_results: clamp(int(a.max, 10), 1, 20), start_at: 0 };
    }
    case "jira_comment":
      return { issue_id_or_key: str(a.issue).toUpperCase(), comment: str(a.text) };
    case "jira_delete":
      if (!str(a.id)) return null;
      return { issue_id_or_key: str(a.id) };

    // ---- Google Drive
    case "gdrive_find":
      return {
        q: `name contains '${str(a.query).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and trashed = false`,
        orderBy: "modifiedTime desc",
        pageSize: clamp(int(a.max, 5), 1, 10),
        fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
        spaces: "drive",
        supportsAllDrives: true,
        includeItemsFromAllDrives: false,
      };
    case "gdrive_create_doc":
      return { file_name: str(a.name), text_content: str(a.text),
               mime_type: "application/vnd.google-apps.document" };
    case "gdrive_delete":
      if (!str(a.id)) return null;
      return { fileId: str(a.id) };

    // ---- Notion: ids come from notion_find_page (the resolve class)
    case "notion_find_page":
      return { query: str(a.query), page_size: 5, filter_value: "page", filter_property: "object" };
    case "notion_create_page":
      return { parent_id: str(a.parent_id), title: str(a.title) };
    case "notion_append":
      return { parent_block_id: str(a.page_id),
               content_blocks: [{ content_block: { block_property: "paragraph", content: str(a.text) } }] };
    case "notion_archive":
      if (!str(a.id)) return null;
      return { page_id: str(a.id), archive: true };

    // ---- Linear: the team by name or key, else the connection's default
    case "linear_create_issue": {
      const args = { team_id: linearTeam(a.team, d), title: str(a.title) };
      if (str(a.description)) args.description = str(a.description);
      return args;
    }
    case "linear_my_issues": {
      const args = { first: clamp(int(a.max, 10), 1, 20) };
      if (str(d.user_id)) args.assignee_id = str(d.user_id);
      return args;
    }
    case "linear_comment":
      return { issue_id: str(a.issue_id), body: str(a.text) };
    case "linear_archive":
      if (!str(a.id)) return null;
      return { issue_id: str(a.id) };

    default:
      return null;
  }
}

function githubRepo(value, d) {
  const given = str(value).replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  const parts = given.split("/").filter(Boolean);
  if (parts.length >= 2) return { owner: parts[0], repo: parts[1] };
  if (parts.length === 1 && str(d.login)) return { owner: str(d.login), repo: parts[0] };
  throw new NeedsDetail("repo");
}

function gitlabProject(value, d) {
  const given = str(value).replace(/^https?:\/\/gitlab\.com\//, "").replace(/\.git$/, "").replace(/^\/|\/$/g, "");
  if (given.includes("/")) return encodeURIComponent(given);
  const projects = Array.isArray(d.projects) ? d.projects : [];
  const match = projects.find((p) => lower(p.name) === lower(given) || lower(p.path) === lower(given)
                                     || lower(p.path).endsWith("/" + lower(given)));
  if (match && str(match.path)) return encodeURIComponent(str(match.path));
  if (match && match.id) return String(match.id);
  throw new NeedsDetail("project");
}

function jiraProject(value, d, allowDefault) {
  const given = str(value);
  const projects = Array.isArray(d.projects) ? d.projects : [];
  if (given) {
    const byKey = projects.find((p) => lower(p.key) === lower(given));
    if (byKey) return str(byKey.key);
    const byName = projects.find((p) => lower(p.name) === lower(given));
    if (byName) return str(byName.key);
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(given)) return given.toUpperCase();
  }
  if (allowDefault && projects.length && str(projects[0].key)) return str(projects[0].key);
  throw new NeedsDetail("project");
}

function linearTeam(value, d) {
  const given = str(value);
  const teams = Array.isArray(d.teams) ? d.teams : [];
  if (given) {
    const match = teams.find((t) => lower(t.key) === lower(given) || lower(t.name) === lower(given));
    if (match && str(match.id)) return str(match.id);
  }
  if (!given && teams.length && str(teams[0].id)) return str(teams[0].id);
  throw new NeedsDetail("team");
}

/**
 * The few fields the model needs, from Composio's `data`. Read results are
 * arrays of small objects; writes say what happened and carry the id of the
 * thing made, for undo. Composio wraps lists differently per toolkit, so the
 * list is looked for under the names seen in schemas and live replies.
 */
export function compact(tool, data) {
  const d = data && typeof data === "object" ? data : {};
  switch (tool) {
    case "gmail_send":
      return { result: { sent: true }, id: null };
    case "gmail_search": {
      const messages = Array.isArray(d.messages) ? d.messages : [];
      return {
        result: messages.map((m) => ({
          from: firstOf(m, ["sender", "from"]),
          subject: firstOf(m, ["subject"]),
          date: firstOf(m, ["messageTimestamp", "date", "internalDate"]),
          // MEASURED on 2026-09-14 against a live reply: `preview` is an
          // object holding `body` and `subject`, and `messageText` is empty
          // with include_payload false. The first draft read `preview` as a
          // string and every snippet came back blank.
          snippet: (m && m.preview && typeof m.preview === "object" ? str(m.preview.body) : firstOf(m, ["snippet", "messageText"])).slice(0, 200),
        })),
        id: null,
      };
    }
    case "gcal_list": {
      const items = Array.isArray(d.items) ? d.items : [];
      return {
        result: items.map((e) => ({
          title: firstOf(e, ["summary"]),
          start: when(e.start),
          end: when(e.end),
          location: firstOf(e, ["location"]),
          attendees: Array.isArray(e.attendees) ? e.attendees.length : 0,
        })),
        id: null,
      };
    }
    case "gcal_create":
      return { result: { created: true }, id: str(d.id) || str(d.event_id) || null };
    case "slack_post":
      return { result: { posted: true }, id: null };
    case "slack_read": {
      const matches = d.messages && Array.isArray(d.messages.matches) ? d.messages.matches : [];
      return {
        result: matches.map((m) => ({
          from: firstOf(m, ["username", "user"]),
          time: tsToISO(m.ts),
          text: firstOf(m, ["text"]).slice(0, 500),
        })),
        id: null,
      };
    }

    case "github_create_issue":
      // No delete in GitHub's catalog: the id stays null and Otto says an
      // issue cannot be taken back.
      return { result: { created: true, number: d.number ?? null, url: firstOf(d, ["html_url"]) }, id: null };
    case "github_my_issues":
      return { result: listIn(d, ["details", "items", "issues"]).map((i) => ({
        repo: repoName(i), number: i.number ?? null, title: firstOf(i, ["title"]),
        updated: firstOf(i, ["updated_at"]),
      })), id: null };
    case "github_pull_requests":
      return { result: listIn(d, ["details", "items", "pull_requests"]).map((p) => ({
        number: p.number ?? null, title: firstOf(p, ["title"]),
        author: p.user && typeof p.user === "object" ? firstOf(p.user, ["login"]) : "",
        updated: firstOf(p, ["updated_at"]), draft: p.draft === true,
      })), id: null };

    case "gitlab_create_issue":
      return { result: { created: true, iid: d.iid ?? null, url: firstOf(d, ["web_url"]) }, id: null };
    case "gitlab_merge_requests":
      return { result: listIn(d, ["details", "items", "merge_requests"]).map((m) => ({
        iid: m.iid ?? null, title: firstOf(m, ["title"]),
        author: m.author && typeof m.author === "object" ? firstOf(m.author, ["username", "name"]) : "",
        updated: firstOf(m, ["updated_at"]), draft: m.draft === true || m.work_in_progress === true,
      })), id: null };

    case "jira_create_issue":
      return { result: { created: true, key: firstOf(d, ["key"]) }, id: firstOf(d, ["key", "id"]) || null };
    case "jira_my_issues":
      return { result: listIn(d, ["issues", "results"]).map((i) => {
        const f = i.fields && typeof i.fields === "object" ? i.fields : i;
        return {
          key: firstOf(i, ["key"]), summary: firstOf(f, ["summary"]),
          status: f.status && typeof f.status === "object" ? firstOf(f.status, ["name"]) : firstOf(f, ["status"]),
          updated: firstOf(f, ["updated"]),
        };
      }), id: null };
    case "jira_comment":
      return { result: { posted: true }, id: null };

    case "gdrive_find":
      return { result: listIn(d, ["files", "items"]).map((f) => ({
        name: firstOf(f, ["name"]), kind: driveKind(firstOf(f, ["mimeType"])),
        modified: firstOf(f, ["modifiedTime"]), link: firstOf(f, ["webViewLink"]),
      })), id: null };
    case "gdrive_create_doc":
      return { result: { created: true, link: firstOf(d, ["webViewLink"]) }, id: str(d.id) || null };

    case "notion_find_page": {
      const raw = d.response_data && typeof d.response_data === "object" ? d.response_data : d;
      return { result: listIn(raw, ["results"]).map((p) => ({
        id: firstOf(p, ["id"]), title: notionTitle(p),
        edited: firstOf(p, ["last_edited_time"]), url: firstOf(p, ["url"]),
      })), id: null };
    }
    case "notion_create_page": {
      const page = d.data && typeof d.data === "object" ? d.data : d;
      return { result: { created: true, url: firstOf(page, ["url"]) }, id: str(page.id) || null };
    }
    case "notion_append":
      return { result: { added: true }, id: null };

    case "linear_create_issue": {
      const issue = d.issue && typeof d.issue === "object" ? d.issue : d;
      return { result: { created: true, identifier: firstOf(issue, ["identifier"]), url: firstOf(issue, ["url"]) },
               id: str(issue.id) || null };
    }
    case "linear_my_issues":
      return { result: listIn(d, ["issues", "nodes"]).map((i) => ({
        id: firstOf(i, ["id"]), identifier: firstOf(i, ["identifier"]), title: firstOf(i, ["title"]),
        state: i.state && typeof i.state === "object" ? firstOf(i.state, ["name"]) : firstOf(i, ["state"]),
        updated: firstOf(i, ["updatedAt", "updated_at"]),
      })), id: null };
    case "linear_comment":
      return { result: { posted: true }, id: null };

    case "gcal_delete":
    case "jira_delete":
    case "gdrive_delete":
    case "notion_archive":
    case "linear_archive":
      return { result: { deleted: true }, id: null };
    default:
      return { result: {}, id: null };
  }
}

const firstOf = (o, keys) => {
  for (const k of keys) if (o && typeof o[k] === "string" && o[k]) return o[k];
  return "";
};
const listIn = (o, keys) => {
  if (Array.isArray(o)) return o;
  for (const k of keys) if (o && Array.isArray(o[k])) return o[k];
  return [];
};
const when = (t) => (t && typeof t === "object" ? str(t.dateTime) || str(t.date) : "");
const tsToISO = (ts) => {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : "";
};
const repoName = (i) => {
  if (i.repository && typeof i.repository === "object") return firstOf(i.repository, ["full_name", "name"]);
  const url = firstOf(i, ["repository_url"]);
  return url.replace(/^https?:\/\/api\.github\.com\/repos\//, "");
};
const notionTitle = (p) => {
  const props = p.properties && typeof p.properties === "object" ? p.properties : {};
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop && prop.type === "title" && Array.isArray(prop.title)) {
      return prop.title.map((t) => firstOf(t, ["plain_text"])).join("");
    }
  }
  return firstOf(p, ["title"]);
};
export function driveKind(mime) {
  const m = str(mime);
  if (m === "application/vnd.google-apps.document") return "Google Doc";
  if (m === "application/vnd.google-apps.spreadsheet") return "Google Sheet";
  if (m === "application/vnd.google-apps.presentation") return "Google Slides";
  if (m === "application/vnd.google-apps.folder") return "folder";
  if (m === "application/pdf") return "PDF";
  if (m.startsWith("image/")) return "image";
  return m.split("/").pop() || "file";
}

/**
 * CONNECT-TIME DEFAULTS (A77). What the callback looks up once, after
 * Composio reports the account active, and stores on the row: the values a
 * spoken request never carries. Pure: the slugs and arguments to run, and how
 * to read the replies. Never at question time.
 */
export const DEFAULT_LOOKUPS = {
  github: [{ slug: "GITHUB_GET_THE_AUTHENTICATED_USER", arguments: {} }],
  gitlab: [{ slug: "GITLAB_GET_PROJECTS", arguments: { membership: true, simple: true, per_page: 100, order_by: "last_activity_at" } }],
  jira:   [{ slug: "JIRA_GET_ALL_PROJECTS", arguments: {} }],
  linear: [{ slug: "LINEAR_GET_CURRENT_USER", arguments: {} },
           { slug: "LINEAR_GET_ALL_LINEAR_TEAMS", arguments: {} }],
};

/** The defaults object from the lookups' `data` replies, in the same order. */
export function defaultsFromReplies(app, replies) {
  const r = Array.isArray(replies) ? replies.map((x) => (x && typeof x === "object" ? x : {})) : [];
  switch (app) {
    case "github":
      return { login: firstOf(r[0] || {}, ["login"]) };
    case "gitlab":
      return { projects: listIn(r[0] || {}, ["details", "items", "projects"]).slice(0, 100).map((p) => ({
        id: p.id ?? null, name: firstOf(p, ["name"]), path: firstOf(p, ["path_with_namespace"]) })) };
    case "jira":
      return { projects: listIn(r[0] || {}, ["values", "projects"]).slice(0, 100).map((p) => ({
        key: firstOf(p, ["key"]), name: firstOf(p, ["name"]) })) };
    case "linear": {
      const user = r[0] && r[0].user && typeof r[0].user === "object" ? r[0].user : (r[0] || {});
      return { user_id: firstOf(user, ["id"]),
               teams: listIn(r[1] || {}, ["items", "teams", "nodes"]).slice(0, 50).map((t) => ({
                 id: firstOf(t, ["id"]), key: firstOf(t, ["key"]), name: firstOf(t, ["name"]) })) };
    }
    default:
      return null;
  }
}

/** "2026-09-14T15:00:00+05:30" → "2026-09-14T15:00:00": the zone rides separately. */
export function naive(iso) {
  return iso.replace(/(\.\d+)?(Z|[+-]\d\d:?\d\d)$/, "");
}

/**
 * 23:59:59 at the end of the day `nowISO` falls on in `tz`, as RFC 3339 with
 * that zone's offset. Intl does the calendar; no library.
 */
export function endOfDay(nowISO, tz) {
  const now = new Date(nowISO);
  if (Number.isNaN(now.getTime())) return nowISO;
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      timeZoneName: "longOffset",
    }).formatToParts(now);
  } catch {
    return nowISO;
  }
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || "";
  const offsetName = get("timeZoneName");           // "GMT+05:30" or "GMT"
  const offset = offsetName === "GMT" ? "+00:00" : offsetName.replace("GMT", "");
  return `${get("year")}-${get("month")}-${get("day")}T23:59:59${offset}`;
}

/**
 * The `otto-integrations` header: one field per cloud app, `active`,
 * `expired`, `pending` or `none`. THE APPS WITH A ROW COME FIRST, OLDEST
 * CONNECTION FIRST (A77): Otto lists tools inline in connect order, and
 * this header is where a second Mac learns that order. The rest follow in
 * catalog order. Mac apps never appear.
 */
export function integrationsHeader(rows) {
  const known = (rows || [])
    .filter((row) => APPS.includes(row.app))
    .sort((a, b) => (Number(a.connected_at) || Number(a.updated_at) || 0) - (Number(b.connected_at) || Number(b.updated_at) || 0));
  const seen = new Set();
  const fields = [];
  for (const row of known) {
    if (seen.has(row.app)) continue;
    seen.add(row.app);
    fields.push(`${row.app}=${row.state}`);
  }
  for (const app of APPS) if (!seen.has(app)) fields.push(`${app}=none`);
  return { "otto-integrations": fields.join(";") };
}

/**
 * Whether a Composio execute reply means the authorization is gone. Composio's
 * `error` is free text; these are the shapes a lapsed token produces.
 * Anything else is a failed call, not a lost connection.
 */
export function looksLikeLostAuthorization(error) {
  const text = String(error || "").toLowerCase();
  return /\b401\b|unauthori[sz]ed|invalid_grant|token (has )?expired|expired|revoked|invalid_auth|not_authed|account_inactive/.test(text);
}

/**
 * Composio signs each webhook as HMAC-SHA256 over `${id}.${timestamp}.${body}`.
 * The signature header may carry several space-separated `v1,<base64>` entries
 * or one bare base64 value; any match verifies. The secret is used as UTF-8,
 * and if it carries a `whsec_` prefix its base64 remainder is tried too.
 * A timestamp outside `tolerance` seconds is refused whatever the signature.
 */
export async function verifyWebhookSignature({ id, timestamp, signature, body, secret, now = Date.now(), tolerance = 300 }) {
  if (!id || !timestamp || !signature || !secret) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > tolerance) return false;

  const candidates = String(signature).split(/\s+/).map((s) => s.replace(/^v1,/, "")).filter(Boolean);
  const message = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
  const secrets = [new TextEncoder().encode(secret)];
  if (secret.startsWith("whsec_")) {
    try { secrets.push(Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0))); } catch { /* not base64 */ }
  }
  for (const raw of secrets) {
    const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
    const expected = btoa(String.fromCharCode(...mac));
    for (const candidate of candidates) if (timingSafeEqual(candidate, expected)) return true;
  }
  return false;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
