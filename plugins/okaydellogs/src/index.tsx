import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, React, ReactNative } from "@vendetta/metro/common";
import { before } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { Forms, General } from "@vendetta/ui/components";
import { registerSection } from "@vendetta/ui/settings";
import { showToast } from "@vendetta/ui/toasts";

const { ScrollView } = General;
const { FormSection, FormRow, FormSwitch, FormInput } = Forms;
const { View, Image, Pressable, Linking } = ReactNative;

/* ------------------------------------------------------------------ */
/* Types + constants                                                   */
/* ------------------------------------------------------------------ */

type Att = {
  n: string; // file name
  u: string; // url
  p?: string; // proxy url
  t?: string; // content type
  d?: number; // duration in seconds (voice messages)
  v?: boolean; // is a voice message
};
type Emb = { u: string; o: string }; // image to show ("" if none), link to open
type Reply = { a: string; t: string }; // who it replied to, and what they said
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
  rp?: Reply; // the message this one replied to
  where: string; // "Server #channel", "DM with X" or "GC ..."
  del?: number; // deleted at (ms)
};

// Settings > Bunny is where the dellogs button goes. If other rows in that
// section ever misbehave, change this name to something unique like "dellogs".
const SECTION_NAME = "Bunny";

const MAX_CACHE = 1500; // recent messages remembered (so we have a copy when one is deleted)
const MAX_DELETED = 500; // deleted messages kept
const SAVE_DELAY = 15000; // ms between disk writes while messages are coming in
const PAGE = 25; // deleted messages shown per page
const OK_TYPES = new Set([0, 19, 20]); // normal, reply, slash command
const IMG_RE = /\.(png|jpe?g|gif|webp|bmp)(\?|$)/i;
const VOICE_FLAG = 8192; // message flag for voice messages
const EPHEMERAL_FLAG = 64;

const DEFAULTS: Record<string, any> = {
  ignoreSelf: true, // don't remember my own messages
  ignoreBots: false, // don't remember bot messages
  toast: true, // pop a toast when something gets deleted
  cacheImages: true, // best effort: download images of new DM / group chat messages right away
  cacheServers: false, // also do that for server messages (uses more data)
};

for (const key in DEFAULTS) {
  if (storage[key] === undefined) storage[key] = DEFAULTS[key];
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const cache = new Map<string, Entry>(); // recent messages by id, oldest first
let deleted: Entry[] = []; // newest first
const listeners = new Set<() => void>(); // screens to refresh when something is deleted

let UserStore: any;
let ChannelStore: any;
let GuildStore: any;
let MessageStore: any;
let unpatch: (() => void) | undefined;
let unregisterSection: any;
let sectionRegistered = false;
let appStateSub: any;
let saveTimer: any;
let lastToast = 0;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const fmt = (ts: number) => new Date(ts).toLocaleString();
const isImage = (a: Att) => !!a.t?.startsWith("image/") || IMG_RE.test(a.n);
const attKind = (a: Att): "voice" | "image" | "video" | "file" =>
  a.v ? "voice" : isImage(a) ? "image" : a.t?.startsWith("video/") ? "video" : "file";

const openUrl = (url: string) => {
  Linking.openURL(url).catch(() => showToast("Couldn't open that link"));
};

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
    console.error("[OkayDelLogs] couldn't restore the log", err);
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
    console.error("[OkayDelLogs] couldn't save the log", err);
  }
}

// Writing the file on every message would be wasteful, so batch the writes
function markDirty() {
  if (!saveTimer) saveTimer = setTimeout(flush, SAVE_DELAY);
}

/* ------------------------------------------------------------------ */
/* Turning Discord messages into log entries                           */
/* ------------------------------------------------------------------ */

const userName = (u: any): string => u?.global_name ?? u?.globalName ?? u?.username ?? "Unknown";

function groupName(channel: any): string {
  if (channel.name) return channel.name;
  const raw: string[] = (channel.rawRecipients ?? []).map((r: any) => userName(r)).filter(Boolean);
  if (raw.length) return raw.join(", ");
  const viaStore: string[] = (channel.recipients ?? [])
    .map((id: string) => UserStore?.getUser?.(id))
    .filter(Boolean)
    .map((u: any) => userName(u));
  return viaStore.length ? viaStore.join(", ") : "unnamed group";
}

function whereLabel(channelId: string, guildId?: string): string {
  try {
    const channel = ChannelStore?.getChannel?.(channelId);
    const guild = guildId ? GuildStore?.getGuild?.(guildId) : undefined;
    if (!channel) return guild?.name ?? "Unknown chat";
    if (guild) return `${guild.name} #${channel.name}`;
    if (channel.type === 1) {
      const other = channel.rawRecipients?.[0];
      return other ? `DM with ${userName(other)}` : "DM";
    }
    if (channel.type === 3) return `GC "${groupName(channel)}"`;
    return channel.name || "Chat";
  } catch (err) {
    return "Unknown chat";
  }
}

function extractAttachments(list: any[]): Att[] {
  return (list ?? [])
    .slice(0, 6)
    .map((a: any) => ({
      n: a.filename ?? "file",
      u: a.url,
      p: a.proxy_url,
      t: a.content_type,
      d: typeof a.duration_secs === "number" ? a.duration_secs : undefined,
      v: a.duration_secs != null || a.waveform != null ? true : undefined,
    }))
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

function mediaLabel(e: { at?: any[]; em?: any[]; st?: any[] }): string {
  if (e.at?.length) return "[attachment]";
  if (e.em?.length) return "[embed]";
  if (e.st?.length) return "[sticker]";
  return "";
}

// The message this one replied to: from the event if Discord sent it,
// otherwise from our own log or Discord's message store
function replyOf(m: any, channelId: string): Reply | undefined {
  try {
    let ref = m.referenced_message;
    const refId: string | undefined = m.message_reference?.message_id;

    if (!ref && refId) {
      const known = cache.get(refId);
      if (known) return { a: known.a, t: (known.t || mediaLabel(known)).slice(0, 300) };

      const record = MessageStore?.getMessage?.(m.message_reference.channel_id ?? channelId, refId);
      if (record) ref = { author: record.author, content: record.content, attachments: record.attachments };
    }
    if (!ref) return undefined;

    const text = String(ref.content ?? "").slice(0, 300);
    return { a: userName(ref.author), t: text || (ref.attachments?.length ? "[attachment]" : "") };
  } catch (err) {
    return undefined;
  }
}

function toEntry(m: any, channelHint?: string): Entry | null {
  const channelId = m?.channel_id ?? channelHint;
  if (!m?.id || !channelId || !m.author) return null;
  if (!OK_TYPES.has(m.type ?? 0)) return null; // joins, pins and other system messages
  if ((m.flags ?? 0) & EPHEMERAL_FLAG) return null; // "only you can see this"

  const guildId: string | undefined = m.guild_id ?? ChannelStore?.getChannel?.(channelId)?.guild_id ?? undefined;
  const at = extractAttachments(m.attachments);
  if ((m.flags ?? 0) & VOICE_FLAG) for (const a of at) a.v = true;
  const em = extractEmbeds(m.embeds);
  const st = (m.sticker_items ?? []).map((s: any) => s.name).filter(Boolean);
  const parsed = Date.parse(m.timestamp);

  return {
    id: m.id,
    c: channelId,
    g: guildId,
    a: userName(m.author),
    ai: m.author.id,
    t: String(m.content ?? "").slice(0, 2000),
    ts: Number.isFinite(parsed) ? parsed : Date.now(),
    at: at.length ? at : undefined,
    em: em.length ? em : undefined,
    st: st.length ? st : undefined,
    rp: replyOf(m, channelId),
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
/* Best effort image caching                                           */
/* ------------------------------------------------------------------ */

// Discord's image links can stop working after a message is deleted (they also expire).
// Asking the phone to download new images right away puts them in the image cache,
// so the list can still show them later. Not guaranteed: the phone can clear that cache.
function prefetchMedia(e: Entry) {
  if (!storage.cacheImages) return;
  if (e.g && !storage.cacheServers) return; // server messages only if enabled
  try {
    const urls = [
      ...(e.at ?? []).filter(a => attKind(a) === "image").map(a => a.u),
      ...(e.em ?? []).filter(m => m.u && IMG_RE.test(m.u)).map(m => m.u),
    ];
    for (const url of urls.slice(0, 4)) {
      const result = (Image as any).prefetch?.(url);
      result?.catch?.(() => {});
    }
  } catch (err) {
    console.error("[OkayDelLogs] couldn't cache an image", err);
  }
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

function consider(m: any, channelHint?: string, live = false) {
  try {
    const entry = toEntry(m, channelHint);
    if (!entry || !allowed(m)) return;
    remember(entry);
    if (live) prefetchMedia(entry);
  } catch (err) {
    console.error("[OkayDelLogs] couldn't log a message", err);
  }
}

function handleUpdate(m: any, channelHint?: string) {
  if (!m?.id) return;
  const existing = cache.get(m.id);

  if (!existing) {
    // an edit we never saw the original of: only usable if it's a full message
    if (m.author) consider(m, channelHint, true);
    return;
  }

  let changed = false;
  let mediaChanged = false;
  if (typeof m.content === "string" && m.content !== existing.t) {
    existing.t = m.content.slice(0, 2000);
    changed = true;
  }
  if (Array.isArray(m.embeds)) {
    const em = extractEmbeds(m.embeds);
    existing.em = em.length ? em : undefined;
    changed = mediaChanged = true;
  }
  if (Array.isArray(m.attachments)) {
    const at = extractAttachments(m.attachments);
    existing.at = at.length ? at : undefined;
    changed = mediaChanged = true;
  }
  if (changed) markDirty();
  if (mediaChanged) prefetchMedia(existing);
}

function summary(e: Entry): string {
  const text = e.t.replace(/\s+/g, " ").trim();
  if (text) return text.length > 60 ? `${text.slice(0, 57)}...` : text;
  if (e.at?.some(a => a.v)) return "[voice message]";
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
      consider(event.message, event.channelId, true);
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
/* Screens                                                             */
/* ------------------------------------------------------------------ */

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
    <View style={{ marginBottom: 14 }}>
      {e.rp && <FormRow label={`↪ Replying to ${e.rp.a}`} subLabel={e.rp.t || "(no text)"} />}
      <FormRow label={e.a} subLabel={e.where} />
      <FormRow
        label={e.t || (hasMedia ? "(no text, media below)" : "(empty)")}
        subLabel={`sent ${fmt(e.ts)} · deleted ${fmt(e.del ?? e.ts)}`}
      />
      {atts.map((a, i) => {
        const kind = attKind(a);
        if (kind === "image") return <Thumb key={`a${i}`} uri={a.u} fallback={a.p} open={a.u} />;
        const label =
          kind === "voice"
            ? `🎤 Voice message${a.d ? ` · ${Math.round(a.d)}s` : ""}`
            : kind === "video"
              ? `🎞️ ${a.n}`
              : `📎 ${a.n}`;
        return (
          <FormRow
            key={`a${i}`}
            label={label}
            subLabel="Tap to open"
            trailing={<FormRow.Arrow />}
            onPress={() => openUrl(a.u)}
          />
        );
      })}
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

// The deleted messages list, shared by the dellogs page and the plugin's settings screen
function Logs() {
  const [, refresh] = React.useState(0);
  const [shown, setShown] = React.useState(PAGE);
  const [query, setQuery] = React.useState("");
  const [confirmClear, setConfirmClear] = React.useState(false);

  // update live if something gets deleted while this is open
  React.useEffect(() => {
    const listener = () => refresh(x => x + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const q = query.trim().toLowerCase();
  const list = q
    ? deleted.filter(e => `${e.t} ${e.a} ${e.where} ${e.rp?.a ?? ""}`.toLowerCase().includes(q))
    : deleted;

  return (
    <>
      <FormSection title={`Deleted messages (${deleted.length})`}>
        <FormInput
          title="Search"
          placeholder="text, name, server or group chat"
          value={query}
          onChange={(v: string) => {
            setQuery(v);
            setShown(PAGE);
          }}
        />
        {list.length === 0 && (
          <FormRow label="Nothing here yet" subLabel="Messages show up here after someone deletes them" />
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
    </>
  );
}

// Opened from Settings > Bunny > dellogs
const DelLogsPage: any = () => (
  <ScrollView keyboardShouldPersistTaps="handled">
    <Logs />
  </ScrollView>
);
DelLogsPage.default = DelLogsPage; // works whether the settings system wants a component or a module

// Opened from the plugin's gear icon
function Settings() {
  useProxy(storage);

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

  return (
    <ScrollView keyboardShouldPersistTaps="handled">
      <FormSection title="Settings">
        {toggle("ignoreSelf", "Ignore my own messages", "Don't remember or log messages you sent")}
        {toggle("ignoreBots", "Ignore bot messages", "Bots delete their own messages a lot")}
        {toggle("toast", "Show a toast on delete", "A small popup when a remembered message is deleted")}
        {toggle("cacheImages", "Cache images of new DM / GC messages", "Best effort, so images can still show after a delete")}
        {toggle("cacheServers", "Also cache server images", "Uses more mobile data")}
      </FormSection>

      <FormSection title="Status">
        <FormRow
          label={`Remembering ${cache.size} recent messages`}
          subLabel={
            sectionRegistered
              ? "Also under Settings > Bunny > dellogs"
              : "The dellogs button couldn't be added, use this screen"
          }
        />
      </FormSection>

      <Logs />
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

function registerDelLogs() {
  try {
    // first icon name that exists on this client; the cog is the last resort
    const names = ["ic_message_delete", "ic_trash_24px", "TrashIcon", "ic_delete_24px", "ic_cog_24px"];
    let icon: number | undefined;
    for (const n of names) {
      try {
        icon = getAssetIDByName(n);
      } catch (err) {
        icon = undefined;
      }
      if (icon) break;
    }

    unregisterSection = registerSection({
      name: SECTION_NAME,
      items: [
        {
          key: "OKAY_DELLOGS",
          title: () => "dellogs",
          icon,
          render: () => Promise.resolve(DelLogsPage),
        },
      ],
    });
    sectionRegistered = true;
  } catch (err) {
    sectionRegistered = false;
    console.error("[OkayDelLogs] couldn't add the dellogs button", err);
  }
}

export const onLoad = () => {
  UserStore = findByStoreName("UserStore") ?? findByProps("getCurrentUser", "getUser");
  ChannelStore = findByStoreName("ChannelStore") ?? findByProps("getChannel", "getDMFromUserId");
  GuildStore = findByStoreName("GuildStore") ?? findByProps("getGuild", "getGuilds");
  MessageStore = findByStoreName("MessageStore") ?? findByProps("getMessage", "getMessages");

  restore();

  unpatch = before("dispatch", FluxDispatcher, (args: any[]) => {
    try {
      observe(args[0]);
    } catch (err) {
      console.error("[OkayDelLogs]", err);
    }
  });

  registerDelLogs();

  // save right away when the app goes to the background, in case Android kills it
  try {
    appStateSub = ReactNative.AppState?.addEventListener?.("change", (state: string) => {
      if (state !== "active") flush();
    });
  } catch (err) {
    console.error("[OkayDelLogs] couldn't watch app state", err);
  }
};

export const onUnload = () => {
  unpatch?.();
  unpatch = undefined;
  if (typeof unregisterSection === "function") unregisterSection();
  unregisterSection = undefined;
  sectionRegistered = false;
  appStateSub?.remove?.();
  appStateSub = undefined;
  flush();
};

export const settings = Settings;
