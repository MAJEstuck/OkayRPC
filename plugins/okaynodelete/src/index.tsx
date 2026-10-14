import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, React, ReactNative } from "@vendetta/metro/common";
import { before } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { Forms, General } from "@vendetta/ui/components";
import { showToast } from "@vendetta/ui/toasts";

const { ScrollView } = General;
const { FormSection, FormRow, FormSwitch, FormInput } = Forms;
const { View, Image, Pressable, Linking } = ReactNative;

/* ------------------------------------------------------------------ */
/* Types + constants                                                   */
/* ------------------------------------------------------------------ */

type Att = { n: string; u: string; p?: string; t?: string }; // name, url, proxy url, content type
type Emb = { u: string; o: string }; // image to show ("" if none), link to open
type Entry = {
  id: string;
  c: string; // channel id
  g?: string; // guild id
  a: string; // author name
  ai: string; // author id
  t: string; // text
  ts: number; // sent at (ms)
  at?: Att[];
  em?: Emb[];
  st?: string[]; // sticker names
  where: string; // "Server #channel" or "DM"
  del?: number; // deleted at (ms)
};

const MAX_CACHE = 1500; // recent messages remembered (so we have a copy when one is deleted)
const MAX_DELETED = 500; // deleted messages kept
const SAVE_DELAY = 15000; // ms between disk writes while messages are coming in
const PAGE = 25; // deleted messages shown per page
const OK_TYPES = new Set([0, 19, 20]); // normal, reply, slash command
const IMG_RE = /\.(png|jpe?g|gif|webp|bmp)(\?|$)/i;

const DEFAULTS: Record<string, any> = {
  ignoreSelf: true, // don't remember my own messages
  ignoreBots: false, // don't remember bot messages
  toast: true, // pop a toast when something gets deleted
};

for (const key in DEFAULTS) {
  if (storage[key] === undefined) storage[key] = DEFAULTS[key];
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const cache = new Map<string, Entry>(); // recent messages by id, oldest first
let deleted: Entry[] = []; // newest first
const listeners = new Set<() => void>(); // settings screen refresh hooks

let UserStore: any;
let ChannelStore: any;
let GuildStore: any;
let unpatch: (() => void) | undefined;
let appStateSub: any;
let saveTimer: any;
let lastToast = 0;

/* ------------------------------------------------------------------ */
/* Saving + loading (plugin storage, as two JSON strings)              */
/* ------------------------------------------------------------------ */

function restore() {
  try {
    cache.clear();
    const c = JSON.parse(storage.cacheJson ?? "[]");
    if (Array.isArray(c)) for (const e of c) if (e?.id) cache.set(e.id, e);

    const d = JSON.parse(storage.deletedJson ?? "[]");
    deleted = Array.isArray(d) ? d : [];
  } catch (err) {
    console.error("[OkayNoDelete] couldn't restore the log", err);
    deleted = [];
  }
}

function flush() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  try {
    storage.cacheJson = JSON.stringify([...cache.values()]);
    storage.deletedJson = JSON.stringify(deleted);
  } catch (err) {
    console.error("[OkayNoDelete] couldn't save the log", err);
  }
}

// Writing the file on every message would be wasteful, so batch the writes
function markDirty() {
  if (!saveTimer) saveTimer = setTimeout(flush, SAVE_DELAY);
}

/* ------------------------------------------------------------------ */
/* Turning Discord messages into log entries                           */
/* ------------------------------------------------------------------ */

function whereLabel(channelId: string, guildId?: string): string {
  try {
    const channel = ChannelStore?.getChannel?.(channelId);
    const guild = guildId ? GuildStore?.getGuild?.(guildId) : undefined;
    if (!channel) return guild?.name ?? "Unknown chat";
    if (guild) return `${guild.name} #${channel.name}`;
    if (channel.type === 1) return "DM";
    return channel.name || "Group DM";
  } catch (err) {
    return "Unknown chat";
  }
}

function extractAttachments(list: any[]): Att[] {
  return (list ?? [])
    .slice(0, 6)
    .map((a: any) => ({ n: a.filename ?? "file", u: a.url, p: a.proxy_url, t: a.content_type }))
    .filter((a: Att) => !!a.u);
}

// GIFs posted as links (Tenor, Giphy...) arrive as embeds, usually in a later MESSAGE_UPDATE
function extractEmbeds(list: any[]): Emb[] {
  const out: Emb[] = [];
  for (const e of (list ?? []).slice(0, 4)) {
    const shown: string | undefined = e.image?.url ?? e.thumbnail?.url;
    const open: string | undefined = e.url ?? e.video?.url ?? shown;
    if (open) out.push({ u: shown ?? "", o: open });
  }
  return out;
}

function toEntry(m: any, channelHint?: string): Entry | null {
  const channelId = m?.channel_id ?? channelHint;
  if (!m?.id || !channelId || !m.author) return null;
  if (!OK_TYPES.has(m.type ?? 0)) return null; // joins, pins and other system messages
  if ((m.flags ?? 0) & 64) return null; // ephemeral "only you can see this"

  const guildId: string | undefined = m.guild_id ?? ChannelStore?.getChannel?.(channelId)?.guild_id ?? undefined;
  const at = extractAttachments(m.attachments);
  const em = extractEmbeds(m.embeds);
  const st = (m.sticker_items ?? []).map((s: any) => s.name).filter(Boolean);
  const parsed = Date.parse(m.timestamp);

  return {
    id: m.id,
    c: channelId,
    g: guildId,
    a: m.author.global_name ?? m.author.username ?? "Unknown",
    ai: m.author.id,
    t: String(m.content ?? "").slice(0, 2000),
    ts: Number.isFinite(parsed) ? parsed : Date.now(),
    at: at.length ? at : undefined,
    em: em.length ? em : undefined,
    st: st.length ? st : undefined,
    where: whereLabel(channelId, guildId),
  };
}

function allowed(m: any): boolean {
  const myId = UserStore?.getCurrentUser?.()?.id;
  if (storage.ignoreSelf && myId && m.author?.id === myId) return false;
  if (storage.ignoreBots && m.author?.bot) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Handling events                                                     */
/* ------------------------------------------------------------------ */

function remember(entry: Entry) {
  cache.set(entry.id, entry);
  if (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  markDirty();
}

function consider(m: any, channelHint?: string) {
  try {
    const entry = toEntry(m, channelHint);
    if (entry && allowed(m)) remember(entry);
  } catch (err) {
    console.error("[OkayNoDelete] couldn't log a message", err);
  }
}

function handleUpdate(m: any, channelHint?: string) {
  if (!m?.id) return;
  const existing = cache.get(m.id);

  if (!existing) {
    // an edit we never saw the original of: only usable if it's a full message
    if (m.author) consider(m, channelHint);
    return;
  }

  let changed = false;
  if (typeof m.content === "string" && m.content !== existing.t) {
    existing.t = m.content.slice(0, 2000);
    changed = true;
  }
  if (Array.isArray(m.embeds)) {
    const em = extractEmbeds(m.embeds);
    existing.em = em.length ? em : undefined;
    changed = true;
  }
  if (Array.isArray(m.attachments)) {
    const at = extractAttachments(m.attachments);
    existing.at = at.length ? at : undefined;
    changed = true;
  }
  if (changed) markDirty();
}

function summary(e: Entry): string {
  const text = e.t.replace(/\s+/g, " ").trim();
  if (text) return text.length > 60 ? `${text.slice(0, 57)}...` : text;
  if (e.at?.length) return `[${e.at.length} attachment${e.at.length === 1 ? "" : "s"}]`;
  if (e.em?.length) return "[embed]";
  if (e.st?.length) return "[sticker]";
  return "[no text]";
}

function handleDelete(id: string) {
  const entry = cache.get(id);
  if (!entry) return; // we never saw this message, nothing to save

  cache.delete(id);

  const myId = UserStore?.getCurrentUser?.()?.id;
  if (storage.ignoreSelf && myId && entry.ai === myId) {
    markDirty();
    return;
  }

  entry.del = Date.now();
  deleted.unshift(entry);
  if (deleted.length > MAX_DELETED) deleted.length = MAX_DELETED;
  markDirty();
  listeners.forEach(f => f());

  // toasts are rate limited so a mass purge doesn't flood the screen
  const now = Date.now();
  if (storage.toast && now - lastToast > 2000) {
    lastToast = now;
    showToast(`🗑️ ${entry.a}: ${summary(entry)}`);
  }
}

// We only watch events here and never block or change them, so chats behave exactly as normal
function observe(event: any) {
  switch (event?.type) {
    case "MESSAGE_CREATE":
      if (event.optimistic || event.isPushNotification) return;
      consider(event.message, event.channelId);
      break;
    case "LOAD_MESSAGES_SUCCESS":
      for (const m of event.messages ?? []) consider(m, event.channelId);
      break;
    case "MESSAGE_UPDATE":
      handleUpdate(event.message, event.channelId);
      break;
    case "MESSAGE_DELETE":
      handleDelete(event.id);
      break;
    case "MESSAGE_DELETE_BULK":
      for (const id of event.ids ?? []) handleDelete(id);
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Settings screen with the deleted messages list                      */
/* ------------------------------------------------------------------ */

const fmt = (ts: number) => new Date(ts).toLocaleString();
const isImage = (a: Att) => !!a.t?.startsWith("image/") || IMG_RE.test(a.n);
const openUrl = (url: string) => {
  Linking.openURL(url).catch(() => showToast("Couldn't open that link"));
};

function Thumb({ uri, fallback, open }: { uri: string; fallback?: string; open: string }) {
  const [src, setSrc] = React.useState(uri);
  return (
    <Pressable onPress={() => openUrl(open)} style={{ marginLeft: 16, marginBottom: 8 }}>
      <Image
        source={{ uri: src }}
        resizeMode="contain"
        style={{ width: 240, height: 180, borderRadius: 8 }}
        onError={() => {
          if (fallback && src !== fallback) setSrc(fallback);
        }}
      />
    </Pressable>
  );
}

function DeletedItem({ e }: { e: Entry }) {
  const atts = e.at ?? [];
  const hasMedia = atts.length > 0 || !!e.em?.length || !!e.st?.length;

  return (
    <View style={{ marginBottom: 12 }}>
      <FormRow
        label={e.t || (hasMedia ? "(no text)" : "(empty)")}
        subLabel={`${e.a} · ${e.where} · deleted ${fmt(e.del ?? e.ts)}`}
      />
      {atts.map((a, i) =>
        isImage(a) ? (
          <Thumb key={`a${i}`} uri={a.u} fallback={a.p} open={a.u} />
        ) : (
          <FormRow
            key={`a${i}`}
            label={`📎 ${a.n}`}
            trailing={<FormRow.Arrow />}
            onPress={() => openUrl(a.u)}
          />
        )
      )}
      {(e.em ?? []).map((m, i) =>
        m.u && IMG_RE.test(m.u) ? (
          <Thumb key={`e${i}`} uri={m.u} open={m.o} />
        ) : (
          <FormRow
            key={`e${i}`}
            label="🔗 Open embed"
            subLabel={m.o}
            trailing={<FormRow.Arrow />}
            onPress={() => openUrl(m.o)}
          />
        )
      )}
      {(e.st ?? []).map((s, i) => (
        <FormRow key={`s${i}`} label={`Sticker: ${s}`} />
      ))}
    </View>
  );
}

function Settings() {
  useProxy(storage);
  const [, refresh] = React.useState(0);
  const [shown, setShown] = React.useState(PAGE);
  const [query, setQuery] = React.useState("");
  const [confirmClear, setConfirmClear] = React.useState(false);

  // update live if something gets deleted while this screen is open
  React.useEffect(() => {
    const listener = () => refresh(x => x + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const toggle = (key: string, label: string, subLabel: string) => (
    <FormRow
      key={key}
      label={label}
      subLabel={subLabel}
      trailing={
        <FormSwitch
          value={!!storage[key]}
          onValueChange={(v: boolean) => {
            storage[key] = v;
          }}
        />
      }
    />
  );

  const q = query.trim().toLowerCase();
  const list = q ? deleted.filter(e => `${e.t} ${e.a} ${e.where}`.toLowerCase().includes(q)) : deleted;

  return (
    <ScrollView keyboardShouldPersistTaps="handled">
      <FormSection title="Settings">
        {toggle("ignoreSelf", "Ignore my own messages", "Don't remember or log messages you sent")}
        {toggle("ignoreBots", "Ignore bot messages", "Bots delete their own messages a lot")}
        {toggle("toast", "Show a toast on delete", "A small popup when a remembered message is deleted")}
      </FormSection>

      <FormSection title="Status">
        <FormRow
          label={`Remembering ${cache.size} recent messages`}
          subLabel="Kept on this phone so a copy exists when one gets deleted"
        />
      </FormSection>

      <FormSection title={`Deleted messages (${deleted.length})`}>
        <FormInput
          title="Search"
          placeholder="text, name or server"
          value={query}
          onChange={(v: string) => {
            setQuery(v);
            setShown(PAGE);
          }}
        />
        {list.length === 0 && (
          <FormRow
            label="Nothing here yet"
            subLabel="Messages show up here after someone deletes them"
          />
        )}
        {list.slice(0, shown).map(e => (
          <DeletedItem key={e.id} e={e} />
        ))}
        {list.length > shown && (
          <FormRow
            label="Show more"
            subLabel={`${list.length - shown} more`}
            trailing={<FormRow.Arrow />}
            onPress={() => setShown(s => s + PAGE)}
          />
        )}
      </FormSection>

      <FormSection title="Manage">
        <FormRow
          label={confirmClear ? "Tap again to delete the whole list" : "Clear deleted messages"}
          subLabel={`${deleted.length} saved`}
          trailing={<FormRow.Arrow />}
          onPress={() => {
            if (!confirmClear) {
              setConfirmClear(true);
              setTimeout(() => setConfirmClear(false), 4000);
              return;
            }
            setConfirmClear(false);
            deleted = [];
            flush();
            refresh(x => x + 1);
            showToast("Cleared");
          }}
        />
      </FormSection>
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

export const onLoad = () => {
  UserStore = findByStoreName("UserStore") ?? findByProps("getCurrentUser", "getUser");
  ChannelStore = findByStoreName("ChannelStore") ?? findByProps("getChannel", "getDMFromUserId");
  GuildStore = findByStoreName("GuildStore") ?? findByProps("getGuild", "getGuilds");

  restore();

  unpatch = before("dispatch", FluxDispatcher, (args: any[]) => {
    try {
      observe(args[0]);
    } catch (err) {
      console.error("[OkayNoDelete]", err);
    }
  });

  // save right away when the app goes to the background, in case Android kills it
  try {
    appStateSub = ReactNative.AppState?.addEventListener?.("change", (state: string) => {
      if (state !== "active") flush();
    });
  } catch (err) {
    console.error("[OkayNoDelete] couldn't watch app state", err);
  }
};

export const onUnload = () => {
  unpatch?.();
  unpatch = undefined;
  appStateSub?.remove?.();
  appStateSub = undefined;
  flush();
};

export const settings = Settings;
