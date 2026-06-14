import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { HumanTask, HumanSummary, TaskStatus } from "@delegate-to-human/shared";
import "./styles.css";

type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  revokedAt: string | null;
};

type Delivery = {
  id: string;
  taskId: string;
  channel: string;
  status: string;
  error: string | null;
  createdAt: string;
};

type ChannelHealth = {
  channel: string;
  configured: boolean;
  ok: boolean;
  message?: string;
};

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function api<T>(
  path: string,
  init: RequestInit = {},
  adminToken?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData)) headers.set("content-type", "application/json");
  if (adminToken) headers.set("authorization", `Bearer ${adminToken}`);
  const response = await fetch(`${BASE}${path}`, { ...init, headers, credentials: "include" });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function formatDate(value?: string): string {
  if (!value) return "No deadline";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

const statusLabels: Record<TaskStatus, string> = {
  pending_delivery: "Sending",
  awaiting_human: "Your turn",
  awaiting_agent: "Waiting for agent",
  awaiting_agent_review: "Under review",
  completed: "Completed",
  declined: "Declined",
  expired: "Expired",
  canceled: "Canceled",
  delivery_failed: "Delivery failed",
};

function App() {
  const rel = window.location.pathname.slice(BASE.length) || "/";
  if (rel === "/admin" || rel === "/admin/") return <AdminApp />;
  if (rel === "/auth" || rel === "/auth/") return <MagicAuth />;
  return <HumanApp />;
}

function MagicAuth() {
  const [error, setError] = useState("");

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      setError("This sign-in link is missing its token.");
      return;
    }
    api<{ taskId: string | null }>("/api/auth/magic", {
      method: "POST",
      body: JSON.stringify({ token }),
    })
      .then(({ taskId }) => {
        window.location.replace(taskId ? `${BASE}/?task=${taskId}` : `${BASE}/`);
      })
      .catch((reason: Error) => setError(reason.message));
  }, []);

  return (
    <main className="center-page">
      <div className="auth-card">
        <div className="logo-mark">H</div>
        <h1>{error ? "Link unavailable" : "Opening your workspace"}</h1>
        <p>{error || "Verifying the secure link..."}</p>
      </div>
    </main>
  );
}

function HumanApp() {
  const [human, setHuman] = useState<{ displayName: string } | null>(null);
  const [tasks, setTasks] = useState<HumanTask[]>([]);
  const [selectedId, setSelectedId] = useState(
    new URLSearchParams(window.location.search).get("task"),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = async () => {
    try {
      const [profile, taskData] = await Promise.all([
        api<{ human: { displayName: string } }>("/api/human/me"),
        api<{ tasks: HumanTask[] }>("/api/human/tasks"),
      ]);
      setHuman(profile.human);
      setTasks(taskData.tasks);
      if (!selectedId && taskData.tasks[0]) setSelectedId(taskData.tasks[0].id);
      setError("");
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const selected = tasks.find((task) => task.id === selectedId);

  if (loading) {
    return <main className="center-page"><div className="spinner" /></main>;
  }
  if (!human) {
    return (
      <main className="center-page">
        <div className="auth-card">
          <div className="logo-mark">H</div>
          <h1>Human delegation inbox</h1>
          <p>{error === "Unauthorized" ? "Use a secure sign-in link from your administrator or assignment notification." : error}</p>
          <a className="text-link" href={`${BASE}/admin`}>Open admin console</a>
        </div>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo-mark small">H</div>
          <div><strong>Delegate</strong><span>Human workspace</span></div>
        </div>
        <div className="inbox-header">
          <span>Assigned to {human.displayName}</span>
          <button className="icon-button" onClick={() => void refresh()} title="Refresh">↻</button>
        </div>
        <div className="task-list">
          {tasks.length === 0 && <div className="empty-list">No delegated tasks yet.</div>}
          {tasks.map((task) => (
            <button
              key={task.id}
              className={`task-row ${task.id === selectedId ? "selected" : ""}`}
              onClick={() => setSelectedId(task.id)}
            >
              <div className="row-top">
                <span className={`status-dot status-${task.status}`} />
                <time>{formatDate(task.updatedAt)}</time>
              </div>
              <strong>{task.title}</strong>
              <span>{statusLabels[task.status]}</span>
            </button>
          ))}
        </div>
        <button
          className="logout"
          onClick={async () => {
            await api("/api/auth/logout", { method: "POST" });
            window.location.reload();
          }}
        >
          Sign out
        </button>
      </aside>
      <main className="workspace">
        {selected ? (
          <TaskView task={selected} onChanged={refresh} />
        ) : (
          <div className="empty-workspace">
            <div className="logo-mark muted">H</div>
            <h2>Select a task</h2>
            <p>The task brief, conversation, and result controls will appear here.</p>
          </div>
        )}
      </main>
    </div>
  );
}

function TaskView({ task, onChanged }: { task: HumanTask; onChanged: () => Promise<void> }) {
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<"message" | "question" | "result">("message");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canRespond = task.status === "awaiting_human";

  useEffect(() => {
    setBody("");
    setFiles([]);
    setError("");
  }, [task.id, task.status]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setError("");
    const form = new FormData();
    form.set("body", body);
    for (const file of files) form.append("files", file);
    const endpoint =
      mode === "result"
        ? `/api/human/tasks/${task.id}/result`
        : `/api/human/tasks/${task.id}/messages`;
    if (mode !== "result") form.set("kind", mode);
    try {
      await api(endpoint, { method: "POST", body: form });
      setBody("");
      setFiles([]);
      await onChanged();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="task-header">
        <div>
          <div className="eyebrow">Delegated task</div>
          <h1>{task.title}</h1>
          <div className="task-meta">
            <span className={`status-pill status-${task.status}`}>{statusLabels[task.status]}</span>
            <span>Due {formatDate(task.deadline)}</span>
            {task.deliveredChannel && <span>via {task.deliveredChannel}</span>}
          </div>
        </div>
        <span className="task-id">#{task.id.slice(0, 8)}</span>
      </header>

      <div className="task-content">
        <section className="brief-card">
          <h2>Brief</h2>
          <p className="pre-wrap">{task.instructions}</p>
          {task.acceptanceCriteria.length > 0 && (
            <>
              <h3>Acceptance criteria</h3>
              <ul className="criteria">
                {task.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}
              </ul>
            </>
          )}
          {task.attachments.length > 0 && <AttachmentList attachments={task.attachments} />}
        </section>

        <section className="conversation">
          <div className="section-title">
            <h2>Conversation</h2>
            <span>{task.messages.length} messages</span>
          </div>
          <div className="thread">
            {task.messages.length === 0 && (
              <div className="thread-empty">No messages yet. Ask a question if you need more context.</div>
            )}
            {task.messages.map((message) => (
              <article key={message.id} className={`message message-${message.author}`}>
                <div className="message-head">
                  <strong>{message.author === "human" ? "You" : message.author}</strong>
                  <span>{message.kind.replace("_", " ")}</span>
                  <time>{formatDate(message.createdAt)}</time>
                </div>
                <p className="pre-wrap">{message.body}</p>
                {message.attachments.length > 0 && <AttachmentList attachments={message.attachments} />}
              </article>
            ))}
          </div>
        </section>
      </div>

      <footer className="composer">
        {canRespond ? (
          <form onSubmit={submit}>
            <div className="mode-tabs">
              {(["message", "question", "result"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={mode === value ? "active" : ""}
                  onClick={() => setMode(value)}
                >
                  {value === "result" ? "Submit result" : value}
                </button>
              ))}
            </div>
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder={
                mode === "result"
                  ? "Describe the completed result and anything the agent should know..."
                  : mode === "question"
                    ? "Ask the agent for the missing information..."
                    : "Send an update..."
              }
              rows={4}
            />
            <div className="composer-actions">
              <label className="file-button">
                Attach files
                <input
                  type="file"
                  multiple
                  onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
                />
              </label>
              <span className="file-count">{files.length ? `${files.length} file(s) selected` : ""}</span>
              <button className="primary-button" disabled={busy || !body.trim()}>
                {busy ? "Sending..." : mode === "result" ? "Submit for review" : "Send"}
              </button>
            </div>
            {error && <p className="form-error">{error}</p>}
            <button
              type="button"
              className="danger-link"
              onClick={async () => {
                const reason = window.prompt("Why are you declining this task?");
                if (reason === null) return;
                await api(`/api/human/tasks/${task.id}/decline`, {
                  method: "POST",
                  body: JSON.stringify({ reason }),
                });
                await onChanged();
              }}
            >
              Decline task
            </button>
          </form>
        ) : (
          <div className="composer-locked">
            {task.status === "awaiting_agent"
              ? "Your question was sent. The agent needs to respond before work continues."
              : task.status === "awaiting_agent_review"
                ? "Your result is awaiting agent review."
                : `This task is ${statusLabels[task.status].toLowerCase()}.`}
          </div>
        )}
      </footer>
    </>
  );
}

function AttachmentList({ attachments }: { attachments: HumanTask["attachments"] }) {
  return (
    <div className="attachments">
      {attachments.map((attachment) => (
        <a key={attachment.id} href={attachment.downloadUrl} className="attachment">
          <span className="file-icon">↧</span>
          <span><strong>{attachment.filename}</strong><small>{Math.ceil(attachment.sizeBytes / 1024)} KB</small></span>
        </a>
      ))}
    </div>
  );
}

function AdminApp() {
  const [token, setToken] = useState(() => localStorage.getItem("dth_admin_token") ?? "");
  const [humans, setHumans] = useState<HumanSummary[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [channelHealth, setChannelHealth] = useState<ChannelHealth[]>([]);
  const [newKey, setNewKey] = useState("");
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"humans" | "keys" | "deliveries">("humans");

  const refresh = async (candidate = token) => {
    if (!candidate) return;
    try {
      const [humanData, keyData, deliveryData, healthData] = await Promise.all([
        api<{ humans: HumanSummary[] }>("/api/admin/humans", {}, candidate),
        api<{ apiKeys: ApiKey[] }>("/api/admin/api-keys", {}, candidate),
        api<{ deliveries: Delivery[] }>("/api/admin/deliveries", {}, candidate),
        api<{ channels: ChannelHealth[] }>("/api/admin/channel-health", {}, candidate),
      ]);
      setHumans(humanData.humans);
      setApiKeys(keyData.apiKeys);
      setDeliveries(deliveryData.deliveries);
      setChannelHealth(healthData.channels);
      setError("");
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const configuredChannels = useMemo(
    () => humans.reduce((total, human) => total + human.channels.length, 0),
    [humans],
  );

  if (!token || error === "Unauthorized") {
    return (
      <main className="center-page admin-login">
        <form
          className="auth-card"
          onSubmit={(event) => {
            event.preventDefault();
            const value = new FormData(event.currentTarget).get("token")?.toString() ?? "";
            localStorage.setItem("dth_admin_token", value);
            setToken(value);
            setError("");
            void refresh(value);
          }}
        >
          <div className="logo-mark">H</div>
          <h1>Admin console</h1>
          <p>Enter the server’s <code>ADMIN_TOKEN</code>.</p>
          <input name="token" type="password" placeholder="Admin token" autoFocus />
          <button className="primary-button">Continue</button>
          {error && <p className="form-error">{error}</p>}
        </form>
      </main>
    );
  }

  return (
    <div className="admin-shell">
      <aside className="admin-nav">
        <div className="brand">
          <div className="logo-mark small">H</div>
          <div><strong>Delegate</strong><span>Administration</span></div>
        </div>
        {(["humans", "keys", "deliveries"] as const).map((value) => (
          <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>
            {value === "keys" ? "API keys" : value}
          </button>
        ))}
        <a href={`${BASE}/`}>Human inbox</a>
      </aside>
      <main className="admin-main">
        <header className="admin-header">
          <div><div className="eyebrow">System overview</div><h1>Human delegation</h1></div>
          <button className="secondary-button" onClick={() => void refresh()}>Refresh</button>
        </header>
        <div className="metrics">
          <div><strong>{humans.length}</strong><span>Human profiles</span></div>
          <div><strong>{configuredChannels}</strong><span>Channel bindings</span></div>
          <div><strong>{apiKeys.filter((key) => !key.revokedAt).length}</strong><span>Active agent keys</span></div>
        </div>
        {error && <p className="banner-error">{error}</p>}
        {newKey && (
          <div className="secret-banner">
            <div><strong>New API key</strong><span>This value is shown once.</span></div>
            <code>{newKey}</code>
            <button onClick={() => void navigator.clipboard.writeText(newKey)}>Copy</button>
            <button onClick={() => setNewKey("")}>Dismiss</button>
          </div>
        )}
        {tab === "humans" && <HumansPanel token={token} humans={humans} refresh={refresh} />}
        {tab === "keys" && (
          <KeysPanel
            token={token}
            apiKeys={apiKeys}
            refresh={refresh}
            onCreated={setNewKey}
          />
        )}
        {tab === "deliveries" && <DeliveriesPanel deliveries={deliveries} channelHealth={channelHealth} />}
      </main>
    </div>
  );
}

function HumansPanel({
  token,
  humans,
  refresh,
}: {
  token: string;
  humans: HumanSummary[];
  refresh: () => Promise<void>;
}) {
  const [showForm, setShowForm] = useState(false);
  const [loginLink, setLoginLink] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const channels: Array<{ type: string; preferenceOrder: number; config: Record<string, string> }> = [];
    const email = data.get("email")?.toString().trim();
    const telegram = data.get("telegram")?.toString().trim();
    if (email) channels.push({ type: "email", preferenceOrder: 1, config: { address: email } });
    if (telegram) channels.push({
      type: "telegram",
      preferenceOrder: email ? 2 : 1,
      config: { chatId: telegram, userId: telegram },
    });
    channels.push({ type: "web", preferenceOrder: channels.length + 1, config: {} });
    await api("/api/admin/humans", {
      method: "POST",
      body: JSON.stringify({
        displayName: data.get("name"),
        skills: data.get("skills")?.toString().split(",").map((value) => value.trim()).filter(Boolean),
        timezone: data.get("timezone") || "UTC",
        availability: "available",
        channels,
      }),
    }, token);
    event.currentTarget.reset();
    setShowForm(false);
    await refresh();
  };

  const save = async (id: string, event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await api(`/api/admin/humans/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        displayName: data.get("displayName")?.toString().trim() || undefined,
        availability: data.get("availability")?.toString().trim() || undefined,
        skills: data.get("skills")?.toString().split(",").map((s) => s.trim()).filter(Boolean),
        timezone: data.get("timezone")?.toString().trim() || undefined,
      }),
    }, token);
    setEditingId(null);
    await refresh();
  };

  return (
    <section className="admin-panel">
      <div className="panel-heading">
        <div><h2>Humans</h2><p>People agents can discover and delegate work to.</p></div>
        <button className="primary-button" onClick={() => setShowForm(!showForm)}>Add human</button>
      </div>
      {showForm && (
        <form className="admin-form" onSubmit={create}>
          <label>Name<input name="name" required /></label>
          <label>Skills<input name="skills" placeholder="research, legal review, design" /></label>
          <label>Timezone<input name="timezone" defaultValue="UTC" /></label>
          <label>Email<input name="email" type="email" placeholder="person@example.com" /></label>
          <label>Telegram chat ID<input name="telegram" placeholder="123456789" /></label>
          <div className="form-span"><small>Email is preferred when present; Telegram follows; web is always available.</small></div>
          <div className="form-span form-actions"><button className="primary-button">Create profile</button></div>
        </form>
      )}
      {loginLink && (
        <div className="secret-banner"><code>{loginLink}</code><button onClick={() => void navigator.clipboard.writeText(loginLink)}>Copy</button><button onClick={() => setLoginLink("")}>Dismiss</button></div>
      )}
      <div className="data-table">
        <div className="table-row table-head"><span>Human</span><span>Skills</span><span>Channels</span><span>Availability</span><span /></div>
        {humans.map((human) => editingId === human.id ? (
          <form key={human.id} className="admin-form edit-row-form" onSubmit={(e) => void save(human.id, e)}>
            <label>Name<input name="displayName" defaultValue={human.displayName} required /></label>
            <label>Availability
              <select name="availability" defaultValue={human.availability}>
                <option value="available">available</option>
                <option value="busy">busy</option>
                <option value="away">away</option>
                <option value="on leave">on leave</option>
              </select>
            </label>
            <label>Skills<input name="skills" defaultValue={human.skills.join(", ")} /></label>
            <label>Timezone<input name="timezone" defaultValue={human.timezone} /></label>
            <div className="form-span form-actions">
              <button className="primary-button">Save</button>
              <button type="button" className="secondary-button" onClick={() => setEditingId(null)}>Cancel</button>
            </div>
          </form>
        ) : (
          <div className="table-row" key={human.id}>
            <span><strong>{human.displayName}</strong><small>{human.timezone}</small></span>
            <span className="tag-list">{human.skills.map((skill) => <i key={skill}>{skill}</i>)}</span>
            <span className="tag-list">{human.channels.map((channel) => <i key={channel}>{channel}</i>)}</span>
            <span>{human.availability}</span>
            <span>
              <button className="text-button" onClick={() => setEditingId(human.id)}>Edit</button>
              {" · "}
              <button
                className="text-button"
                onClick={async () => {
                  const response = await api<{ url: string }>(
                    `/api/admin/humans/${human.id}/login-link`,
                    { method: "POST", body: "{}" },
                    token,
                  );
                  setLoginLink(response.url);
                }}
              >
                Login link
              </button>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function KeysPanel({
  token,
  apiKeys,
  refresh,
  onCreated,
}: {
  token: string;
  apiKeys: ApiKey[];
  refresh: () => Promise<void>;
  onCreated: (token: string) => void;
}) {
  const create = async () => {
    const name = window.prompt("Name this agent integration:");
    if (!name) return;
    const response = await api<{ token: string }>(
      "/api/admin/api-keys",
      { method: "POST", body: JSON.stringify({ name }) },
      token,
    );
    onCreated(response.token);
    await refresh();
  };
  return (
    <section className="admin-panel">
      <div className="panel-heading">
        <div><h2>API keys</h2><p>Bearer credentials used by MCP clients.</p></div>
        <button className="primary-button" onClick={() => void create()}>Issue API key</button>
      </div>
      <div className="data-table">
        <div className="table-row key-row table-head"><span>Name</span><span>Prefix</span><span>Created</span><span>Status</span><span /></div>
        {apiKeys.map((key) => (
          <div className="table-row key-row" key={key.id}>
            <span><strong>{key.name}</strong></span>
            <code>{key.prefix}…</code>
            <span>{formatDate(key.createdAt)}</span>
            <span>{key.revokedAt ? "Revoked" : "Active"}</span>
            <span>
              {!key.revokedAt && <button className="danger-link" onClick={async () => {
                await api(`/api/admin/api-keys/${key.id}`, { method: "DELETE" }, token);
                await refresh();
              }}>Revoke</button>}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function DeliveriesPanel({
  deliveries,
  channelHealth,
}: {
  deliveries: Delivery[];
  channelHealth: ChannelHealth[];
}) {
  return (
    <section className="admin-panel">
      <div className="panel-heading"><div><h2>Delivery diagnostics</h2><p>Recent channel attempts and failures.</p></div></div>
      <div className="channel-health">
        {channelHealth.map((channel) => (
          <div key={channel.channel} className={channel.ok ? "healthy" : "unhealthy"}>
            <span className="health-dot" />
            <strong>{channel.channel}</strong>
            <span>{channel.ok ? "Healthy" : channel.message ?? "Unavailable"}</span>
          </div>
        ))}
      </div>
      <div className="data-table">
        <div className="table-row delivery-row table-head"><span>Time</span><span>Task</span><span>Channel</span><span>Status</span><span>Detail</span></div>
        {deliveries.map((delivery) => (
          <div className="table-row delivery-row" key={delivery.id}>
            <span>{formatDate(delivery.createdAt)}</span>
            <code>#{delivery.taskId.slice(0, 8)}</code>
            <span>{delivery.channel}</span>
            <span>{delivery.status}</span>
            <span>{delivery.error ?? "Delivered"}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
