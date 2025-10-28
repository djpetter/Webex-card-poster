import React, { useEffect, useMemo, useState } from "react";

export default function WebexBotPoster() {
  // Tabs: "post" | "rooms"
  const [activeTab, setActiveTab] = useState<"post" | "rooms">("post");

  // Posting state
  const [token, setToken] = useState("");
  const [roomId, setRoomId] = useState("");
  const [text, setText] = useState("");
  const [cardJson, setCardJson] = useState(`{
  "type": "AdaptiveCard",
  "version": "1.4",
  "body": [
    { "type": "TextBlock", "size": "Large", "weight": "Bolder", "text": "Hello from Adaptive Card" },
    { "type": "TextBlock", "wrap": true, "text": "This was posted by a Webex bot." }
  ]
}`);
  const [saveLocally, setSaveLocally] = useState(true);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  const [deleteId, setDeleteId] = useState("");

  // Rooms browser state
  const [rooms, setRooms] = useState<any[]>([]);
  const [roomQuery, setRoomQuery] = useState("");
  const [roomsLoadedCount, setRoomsLoadedCount] = useState(0);

  // hydrate from localStorage
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("webexPoster") || "{}");
      if (saved.token) setToken(saved.token);
      if (saved.roomId) setRoomId(saved.roomId);
      if (typeof saved.saveLocally === "boolean") setSaveLocally(saved.saveLocally);
    } catch {}
  }, []);

  // persist to localStorage
  useEffect(() => {
    if (!saveLocally) return;
    const payload = JSON.stringify({ token, roomId, saveLocally });
    localStorage.setItem("webexPoster", payload);
  }, [token, roomId, saveLocally]);

  // API headers
  const headers = useMemo(
    () => ({
      Authorization: `Bearer ${token.trim()}`,
      "Content-Type": "application/json",
    }),
    [token]
  );

  const pushLog = (m: string) =>
    setLog((prev) => [`${new Date().toLocaleTimeString()}  ${m}`, ...prev]);

  const ensureToken = () => {
    if (!token.trim()) throw new Error("Missing Bot Access Token.");
  };

  // --- Webex API: messages ---
  async function postText() {
    try {
      setBusy(true);
      ensureToken();
      if (!roomId.trim()) throw new Error("Missing Room ID.");

      const resp = await fetch("https://webexapis.com/v1/messages", {
        method: "POST",
        headers,
        body: JSON.stringify({ roomId: roomId.trim(), text: text || "(no text)" }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || resp.statusText);

      pushLog(`✅ Text message sent (${data.id})`);
      setDeleteId(data.id);
      await listMessages(true); // silent refresh
    } catch (e: any) {
      pushLog(`❌ ${e.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  async function postCard() {
    try {
      setBusy(true);
      ensureToken();
      if (!roomId.trim()) throw new Error("Missing Room ID.");

      let content: any;
      try {
        content = JSON.parse(cardJson);
      } catch {
        throw new Error("Adaptive Card JSON is invalid.");
      }

      // If user pasted full Webex payload, extract the card
      if (content && (content.attachments || content.roomId || content.markdown)) {
        const maybe = content.attachments?.[0]?.content || content.content || content.card;
        if (maybe) content = maybe;
      }

      // Ensure valid Adaptive Card root
      if (!content.type) content.type = "AdaptiveCard";
      if (content.type !== "AdaptiveCard") throw new Error("Root 'type' must be 'AdaptiveCard'.");
      if (!content.version) content.version = "1.4";

      const body = {
        roomId: roomId.trim(),
        text: text?.trim() ? text : "Adaptive card", // Webex requires non-empty text/file/meetingId
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content,
          },
        ],
      };

      const resp = await fetch("https://webexapis.com/v1/messages", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || resp.statusText);

      pushLog(`✅ Card posted (${data.id})`);
      setDeleteId(data.id);
      await listMessages(true); // silent refresh
    } catch (e: any) {
      pushLog(`❌ ${e.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  async function listMessages(silent = false) {
    try {
      setBusy(true);
      ensureToken();
      if (!roomId.trim()) throw new Error("Missing Room ID.");

      const url = new URL("https://webexapis.com/v1/messages");
      url.searchParams.set("roomId", roomId.trim());
      url.searchParams.set("max", "20");

      const resp = await fetch(url.toString(), { headers });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || resp.statusText);

      setMessages(data.items || []);
      if (!silent) pushLog(`ℹ️ Loaded ${data.items?.length || 0} recent messages.`);
    } catch (e: any) {
      if (!silent) pushLog(`❌ Refresh failed: ${e.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteMessage(id?: string) {
    const targetId = (id || deleteId).trim();
    if (!targetId) return pushLog("❌ Provide a messageId to delete.");
    try {
      setBusy(true);
      ensureToken();
      const resp = await fetch(`https://webexapis.com/v1/messages/${targetId}`, {
        method: "DELETE",
        headers,
      });
      if (!resp.ok) throw new Error(await resp.text());
      pushLog(`🗑️ Deleted message ${targetId}`);
      await listMessages(true); // silent refresh
    } catch (e: any) {
      pushLog(`❌ ${e.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  // --- Webex API: rooms (spaces bot is a member of) ---
  async function listRooms() {
    try {
      setBusy(true);
      ensureToken();

      const collected: any[] = [];
      let nextUrl = "https://webexapis.com/v1/rooms?max=100&sortBy=lastactivity";
      for (let page = 0; page < 3; page++) {
        const resp = await fetch(nextUrl, { headers });
        if (!resp.ok) {
          const txt = await resp.text();
          throw new Error(`${resp.status} ${txt || resp.statusText}`);
        }
        const data = await resp.json();
        if (Array.isArray(data.items)) collected.push(...data.items);

        const link = resp.headers.get("link") || resp.headers.get("Link");
        const match = link && link.split(",").find((l) => l.includes('rel="next"'));
        if (match) {
          const urlPart = match.split(";")[0].trim();
          nextUrl = urlPart.slice(1, -1); // remove < >
        } else {
          break;
        }
      }

      setRooms(collected);
      setRoomsLoadedCount(collected.length);
      pushLog(`ℹ️ Loaded ${collected.length} rooms.`);
    } catch (e: any) {
      pushLog(`❌ Rooms load failed: ${e.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  const filteredRooms = rooms.filter((r) =>
    (r.title || "").toLowerCase().includes(roomQuery.trim().toLowerCase())
  );

  function useRoom(id: string) {
    setRoomId(id);
    setActiveTab("post");
    pushLog(`✅ Selected room: ${id}`);
  }

  const openDesigner = () => {
    // Styled like a tab, but opens external tool
    window.open("https://developer.webex.com/buttons-and-cards-designer", "_blank");
  };

  // Tab button helper (blue scheme)
  const TabButton: React.FC<{
    active?: boolean;
    onClick: () => void;
    children: React.ReactNode;
  }> = ({ active, onClick, children }) => (
    <button
      onClick={onClick}
      className={
        active
          ? "px-3 py-1 rounded-2xl border bg-blue-600 text-white border-blue-600 shadow"
          : "px-3 py-1 rounded-2xl border bg-white text-blue-700 border-blue-200 hover:border-blue-400"
      }
    >
      {children}
    </button>
  );

  // --- UI ---
  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Webex Bot Poster</h1>
          <div className="flex items-center gap-3">
            <nav className="flex gap-2">
              <TabButton active={activeTab === "post"} onClick={() => setActiveTab("post")}>
                Post
              </TabButton>
              <TabButton active={activeTab === "rooms"} onClick={() => setActiveTab("rooms")}>
                Rooms
              </TabButton>
              <TabButton active={false} onClick={openDesigner}>
                Card Designer ↗
              </TabButton>
            </nav>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={saveLocally}
                onChange={(e) => setSaveLocally(e.target.checked)}
              />
              Remember inputs locally
            </label>
            {busy && <span className="text-sm">Working…</span>}
          </div>
        </header>

        {activeTab === "post" ? (
          <>
            <section className="grid md:grid-cols-2 gap-4">
              <div className="space-y-3">
                <label className="block">
                  <span className="text-sm font-medium">Bot Access Token</span>
                  <input
                    type="password"
                    className="w-full mt-1 p-2 rounded-xl border"
                    placeholder="e.g. MjQ0Y2…"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="text-sm font-medium">Room ID</span>
                  <input
                    className="w-full mt-1 p-2 rounded-xl border"
                    placeholder="Y2lzY29zc…"
                    value={roomId}
                    onChange={(e) => setRoomId(e.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="text-sm font-medium">Message text (optional)</span>
                  <input
                    className="w-full mt-1 p-2 rounded-xl border"
                    placeholder="Hello team!"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                  />
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={postText}
                    className="px-4 py-2 rounded-2xl shadow bg-white border hover:shadow-md"
                  >
                    Post text
                  </button>
                  <button
                    onClick={() => listMessages(false)}
                    className="px-4 py-2 rounded-2xl shadow bg-white border hover:shadow-md"
                  >
                    Refresh messages
                  </button>
                </div>
              </div>

              <div className="space-y-3">
                <div className="text-sm text-gray-600">
                  Tip: If your card JSON lacks <code>version</code>, I'll default to <code>1.4</code>.
                </div>
                <label className="block">
                  <span className="text-sm font-medium">Adaptive Card JSON</span>
                  <textarea
                    className="w-full mt-1 p-2 rounded-xl border font-mono h-64"
                    value={cardJson}
                    onChange={(e) => setCardJson(e.target.value)}
                  />
                </label>
                <button
                  onClick={postCard}
                  className="px-4 py-2 rounded-2xl shadow bg-white border hover:shadow-md"
                >
                  Post card
                </button>
              </div>
            </section>

            <section className="space-y-3">
              <h2 className="text-xl font-semibold">Recent messages</h2>
              <div className="grid gap-2">
                {messages.map((m) => (
                  <div key={m.id} className="p-3 rounded-2xl border bg-white shadow-sm">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-mono">{m.id}</div>
                      <button
                        onClick={() => deleteMessage(m.id)}
                        className="text-sm underline"
                      >
                        delete
                      </button>
                    </div>
                    <div className="text-sm text-gray-600">{m.created}</div>
                    {m.text && <div className="mt-1">{m.text}</div>}
                    {m.attachments?.length ? (
                      <div className="mt-2 text-sm text-gray-700">
                        {m.attachments.length} attachment(s)
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>

            {/* Delete message (POST TAB ONLY) */}
            <section className="space-y-3">
              <h2 className="text-xl font-semibold">Delete a message</h2>
              <div className="flex gap-2 items-center">
                <input
                  className="flex-1 p-2 rounded-xl border"
                  placeholder="messageId to delete"
                  value={deleteId}
                  onChange={(e) => setDeleteId(e.target.value)}
                />
                <button
                  onClick={() => deleteMessage()}
                  className="px-4 py-2 rounded-2xl shadow bg-white border hover:shadow-md"
                >
                  Delete
                </button>
              </div>
            </section>
          </>
        ) : (
          // ROOMS TAB
          <section className="space-y-4">
            <div className="grid md:grid-cols-3 gap-3">
              <label className="block md:col-span-2">
                <span className="text-sm font-medium">Bot Access Token</span>
                <input
                  type="password"
                  className="w-full mt-1 p-2 rounded-xl border"
                  placeholder="e.g. MjQ0Y2…"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </label>
              <div className="flex md:justify-end items-end">
                <button
                  onClick={listRooms}
                  className="px-4 py-2 rounded-2xl shadow bg-white border hover:shadow-md w-full md:w-auto"
                >
                  Load rooms
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input
                className="flex-1 p-2 rounded-xl border"
                placeholder="Search rooms by title…"
                value={roomQuery}
                onChange={(e) => setRoomQuery(e.target.value)}
              />
              <div className="text-sm text-gray-600">
                {roomsLoadedCount ? `${filteredRooms.length}/${roomsLoadedCount} shown` : ""}
              </div>
            </div>

            <div className="grid gap-2">
              {filteredRooms.map((r) => (
                <div key={r.id} className="p-3 rounded-2xl border bg-white shadow-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-medium">{r.title || "(untitled room)"}</div>
                      <div className="text-xs text-gray-600">
                        <span className="font-mono">{r.id}</span> • {r.type}
                        {r.lastActivity ? ` • last: ${new Date(r.lastActivity).toLocaleString()}` : ""}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => navigator.clipboard?.writeText(r.id)}
                        className="px-3 py-1 rounded-xl border bg-white hover:shadow"
                        title="Copy ID"
                      >
                        Copy ID
                      </button>
                      <button
                        onClick={() => useRoom(r.id)}
                        className="px-3 py-1 rounded-xl border bg-white hover:shadow"
                        title="Use this room for posting"
                      >
                        Use
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              {!rooms.length && (
                <div className="text-sm text-gray-600">
                  No rooms loaded yet. Click <strong>Load rooms</strong>.
                </div>
              )}
            </div>
          </section>
        )}

        {/* Activity log */}
        <section className="space-y-2">
          <h2 className="text-xl font-semibold">Activity</h2>
          <div className="text-xs text-gray-600">Newest first</div>
          <div className="grid gap-1">
            {log.map((l, i) => (
              <div key={i} className="text-sm font-mono">
                {l}
              </div>
            ))}
          </div>
        </section>

        <footer className="text-xs text-gray-500 pt-6">
          Tips: double-check you’re using the bot’s <strong>access token</strong> (starts with a
          long base64-like string), not the bot ID.
        </footer>
      </div>
    </div>
  );
}