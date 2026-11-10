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
  ed?: { t: string; ts: number }[]; // earlier versions of the text, oldest first
  edTs?: number; // when it was last edited (ms)
  k?: boolean; // from a "kept" chat: protected when the log fills up
};

type Rule = "ignore" | "keep";

// Settings > Bunny is where the dellogs button goes. If other rows in that
// section ever misbehave, change this name to something unique like "dellogs".
const SECTION_NAME = "Bunny";

const MAX_CACHE = 1500; // recent messages remembered (so we have a copy when one is deleted)
const MAX_DELETED = 500; // deleted messages kept
const MAX_EDITED = 300; // edited messages kept
const MAX_VERSIONS = 5; // earlier versions kept per edited message
const LIST_PAGE = 40; // servers / DMs shown per page on the Chats screen
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
  logEdits: true, // keep earlier versions of edited messages
  toastEdits: false, // pop a toast when a remembered message is edited
  guildDefault: "log", // servers: "log" (save everything) or "ignore" (save nothing unless kept)
  dmDefault: "log", // DMs and group chats: same choices
};

for (const key in DEFAULTS) {
  if (storage[key] === undefined) storage[key] = DEFAULTS[key];
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const cache = new Map<string, Entry>(); // recent messages by id, oldest first
let deleted: Entry[] = []; // newest first
let edited: Entry[] = []; // newest first
let rules: Record<string, Rule> = {}; // "g:<serverId>" or "c:<channelId>" -> ignore / keep
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
let lastEditToast = 0;

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

    const ed = JSON.parse(storage.editedJson ?? "[]");
    edited = Array.isArray(ed) ? ed : [];

    const r = JSON.parse(storage.rulesJson ?? "{}");
    rules = r && typeof r === "object" && !Array.isArray(r) ? r : {};
  } catch (err) {
    console.error("[OkayDelLogs] couldn't restore the log", err);
    deleted = [];
    edited = [];
    rules = {};
  }
}

function saveRules() {
  try {
    storage.rulesJson = JSON.stringify(rules);
  } catch (err) {
    console.error("[OkayDelLogs] couldn't save the rules", err);
  }
}

function flush() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  try {
    storage.cacheJson = JSON.stringify([...cache.values()]);
    storage.deletedJson = JSON.stringify(deleted);
    storage.editedJson = JSON.stringify(edited);
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
/* Ignore and keep rules                                               */
/* ------------------------------------------------------------------ */

// A chat's own rule wins, then its server's rule, then the global default.
//   ignore = never saved, keep = always saved and protected when the log fills up
function modeFor(channelId: string, guildId?: string): "ignore" | "keep" | "log" {
  const own = rules[`c:${channelId}`] ?? (guildId ? rules[`g:${guildId}`] : undefined);
  if (own === "ignore" || own === "keep") return own;
  return (guildId ? storage.guildDefault : storage.dmDefault) === "ignore" ? "ignore" : "log";
}

// Normal -> Ignore -> Keep -> Normal
function cycleRule(key: string) {
  const current = rules[key];
  if (current === undefined) rules[key] = "ignore";
  else if (current === "ignore") rules[key] = "keep";
  else delete rules[key];
  saveRules();
}

/* ------------------------------------------------------------------ */
/* Keeping the log a sensible size                                     */
/* ------------------------------------------------------------------ */

// Drops the oldest entries first, but entries from "kept" chats only go as a last resort
function trimList(list: Entry[], max: number) {
  while (list.length > max) {
    let victim = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      if (!list[i].k) {
        victim = i;
        break;
      }
    }
    list.splice(victim === -1 ? list.length - 1 : victim, 1);
  }
}

function evictCache() {
  while (cache.size > MAX_CACHE) {
    let victim: string | undefined;
    for (const [id, e] of cache) {
      if (!e.k) {
        victim = id;
        break;
      }
    }
    if (victim === undefined) victim = cache.keys().next().value;
    if (victim === undefined) return;
    cache.delete(victim);
  }
}

/* ------------------------------------------------------------------ */
/* Handling events                                                     */
/* ------------------------------------------------------------------ */

function remember(entry: Entry) {
  cache.set(entry.id, entry);
  evictCache();
  markDirty();
}

function consider(m: any, channelHint?: string, live = false) {
  try {
    const entry = toEntry(m, channelHint);
    if (!entry || !allowed(m)) return;

    const mode = modeFor(entry.c, entry.g);
    if (mode === "ignore") return;
    if (mode === "keep") entry.k = true;

    remember(entry);
    if (live) prefetchMedia(entry);
  } catch (err) {
    console.error("[OkayDelLogs] couldn't log a message", err);
  }
}

const clip = (s: string, n = 40) => {
  const flat = s.replace(/\s+/g, " ").trim() || "(empty)";
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

function touchEdited(entry: Entry) {
  const i = edited.findIndex(x => x.id === entry.id);
  if (i !== -1) edited.splice(i, 1);
  edited.unshift(entry);
  trimList(edited, MAX_EDITED);
}

// Called with the new text before it replaces the old one
function recordEdit(entry: Entry, next: string, editedAt?: string) {
  const prev = entry.t;

  const versions = entry.ed ?? [];
  versions.push({ t: prev, ts: entry.edTs ?? entry.ts });
  while (versions.length > MAX_VERSIONS) versions.shift();
  entry.ed = versions;

  const parsed = Date.parse(editedAt ?? "");
  entry.edTs = Number.isFinite(parsed) ? parsed : Date.now();
  entry.k = modeFor(entry.c, entry.g) === "keep" || undefined;

  touchEdited(entry);
  listeners.forEach(f => f());

  // toasts are rate limited so a burst of edits doesn't flood the screen
  const now = Date.now();
  if (storage.toastEdits && now - lastEditToast > 2000) {
    lastEditToast = now;
    showToast(`✎ ${entry.a}: ${clip(prev)} → ${clip(next)}`);
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
    const next = m.content.slice(0, 2000);
    if (storage.logEdits && modeFor(existing.c, existing.g) !== "ignore") {
      recordEdit(existing, next, m.edited_timestamp);
    }
    existing.t = next;
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

  // rules can change after a message was remembered, so check again now
  const mode = modeFor(entry.c, entry.g);
  if (mode === "ignore") {
    markDirty();
    return;
  }
  entry.k = mode === "keep" || undefined;

  entry.del = Date.now();
  deleted.unshift(entry);
  trimList(deleted, MAX_DELETED);
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

// If a screen ever throws while drawing, show a message instead of taking Discord down
class Boundary extends React.Component<any, { err?: string }> {
  state: { err?: string } = {};

  static getDerivedStateFromError(error: any) {
    return { err: String(error?.message ?? error) };
  }

  render() {
    if (this.state.err) {
      return <FormRow label="This screen hit an error" subLabel={`${this.state.err}. Go back and open it again.`} />;
    }
    return (this.props as any).children ?? null;
  }
}

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

// One saved message: who, where, what it replied to, the text, earlier versions and media
function Item({ e }: { e: Entry }) {
  const atts = e.at ?? [];
  const hasMedia = atts.length > 0 || !!e.em?.length || !!e.st?.length;
  const versions = e.ed ? [...e.ed].reverse() : []; // newest first

  const times = [`sent ${fmt(e.ts)}`];
  if (e.edTs) times.push(`edited ${fmt(e.edTs)}`);
  if (e.del) times.push(`deleted ${fmt(e.del)}`);

  const text = e.t || (hasMedia ? "(no text, media below)" : "(empty)");

  return (
    <View style={{ marginBottom: 14 }}>
      {e.rp && <FormRow label={`↪ Replying to ${e.rp.a}`} subLabel={e.rp.t || "(no text)"} />}
      <FormRow label={e.a} subLabel={`${e.where}${e.k ? " · kept chat" : ""}`} />
      <FormRow label={versions.length ? `Now: ${text}` : text} subLabel={times.join(" · ")} />
      {versions.map((v, i) => (
        <FormRow key={`v${i}`} label={v.t || "(empty)"} subLabel={`✎ earlier version · ${fmt(v.ts)}`} />
      ))}
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

// The deleted or edited list, with search and a clear button
function Logs({ kind }: { kind: "deleted" | "edited" }) {
  const [, refresh] = React.useState(0);
  const [shown, setShown] = React.useState(PAGE);
  const [query, setQuery] = React.useState("");
  const [confirmClear, setConfirmClear] = React.useState(false);

  // update live if something gets deleted or edited while this is open
  React.useEffect(() => {
    const listener = () => refresh(x => x + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const source = kind === "deleted" ? deleted : edited;
  const noun = kind === "deleted" ? "Deleted" : "Edited";
  const q = query.trim().toLowerCase();
  const list = q
    ? source.filter(e => `${e.t} ${e.a} ${e.where} ${e.rp?.a ?? ""}`.toLowerCase().includes(q))
    : source;

  return (
    <>
      <FormSection title={`${noun} messages (${source.length})`}>
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
          <FormRow
            label="Nothing here yet"
            subLabel={
              kind === "deleted"
                ? "Messages show up here after someone deletes them"
                : "Messages show up here after someone edits them"
            }
          />
        )}
        {list.slice(0, shown).map(e => (
          <Item key={e.id} e={e} />
        ))}
        {list.length > shown && (
          <FormRow
            label="Show more"
            subLabel={`${list.length - shown} more`}
            trailing={<FormRow.Arrow />}
            onPress={() => setShown(n => n + PAGE)}
          />
        )}
      </FormSection>

      <FormSection title="Manage">
        <FormRow
          label={confirmClear ? "Tap again to clear this whole list" : `Clear ${noun.toLowerCase()} messages`}
          subLabel={`${source.length} saved, including kept chats`}
          trailing={<FormRow.Arrow />}
          onPress={() => {
            if (!confirmClear) {
              setConfirmClear(true);
              setTimeout(() => setConfirmClear(false), 4000);
              return;
            }
            setConfirmClear(false);
            if (kind === "deleted") deleted = [];
            else edited = [];
            flush();
            refresh(x => x + 1);
            showToast("Cleared");
          }}
        />
      </FormSection>
    </>
  );
}

/* ----- Chats and rules ----- */

function dmLabel(channel: any): string {
  if (channel.type === 3) return `GC "${groupName(channel)}"`;
  const other = channel.rawRecipients?.[0] ?? UserStore?.getUser?.(channel.recipients?.[0]);
  return other ? `DM with ${userName(other)}` : "DM";
}

function listGuilds(): { id: string; name: string }[] {
  try {
    const all = GuildStore?.getGuilds?.() ?? {};
    return Object.values(all)
      .map((g: any) => ({ id: String(g.id), name: String(g.name ?? "Unnamed server") }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    return [];
  }
}

function listDms(): { id: string; name: string }[] {
  try {
    const all: any[] = ChannelStore?.getSortedPrivateChannels?.() ?? [];
    return all.map((c: any) => ({ id: String(c.id), name: dmLabel(c) }));
  } catch (err) {
    return [];
  }
}

function ruleText(key: string, isGuild: boolean): string {
  const r = rules[key];
  if (r === "ignore") return "Ignored: nothing from here is saved";
  if (r === "keep") return "Kept: always saved and protected from clean-up";
  return (isGuild ? storage.guildDefault : storage.dmDefault) === "ignore"
    ? "Normal: ignored by default"
    : "Normal: saved";
}

function Chats() {
  const [, refresh] = React.useState(0);
  const [query, setQuery] = React.useState("");
  const [shownG, setShownG] = React.useState(LIST_PAGE);
  const [shownD, setShownD] = React.useState(LIST_PAGE);

  const q = query.trim().toLowerCase();
  const guilds = listGuilds().filter(g => !q || g.name.toLowerCase().includes(q));
  const dms = listDms().filter(d => !q || d.name.toLowerCase().includes(q));

  const ruleValues = Object.values(rules);
  const ignoredCount = ruleValues.filter(r => r === "ignore").length;
  const keptCount = ruleValues.filter(r => r === "keep").length;

  const cycle = (key: string) => {
    cycleRule(key);
    refresh(x => x + 1);
  };

  const defaultRow = (key: "guildDefault" | "dmDefault", label: string) => (
    <FormRow
      label={label}
      subLabel={`${storage[key] === "ignore" ? "Ignore everything" : "Save everything"} by default (tap to change). Rules on a chat override this`}
      trailing={<FormRow.Arrow />}
      onPress={() => {
        storage[key] = storage[key] === "ignore" ? "log" : "ignore";
        refresh(x => x + 1);
      }}
    />
  );

  return (
    <>
      <FormSection title="Defaults">
        {defaultRow("guildDefault", "Servers")}
        {defaultRow("dmDefault", "DMs and group chats")}
        <FormRow
          label={`${ignoredCount} ignored, ${keptCount} kept`}
          subLabel="Tap a chat below to cycle: Normal, Ignore, Keep. Ignore saves nothing from it, Keep always saves it and protects it when the log fills up"
        />
      </FormSection>

      <FormSection title="Find a chat">
        <FormInput
          title="Search"
          placeholder="server, person or group chat"
          value={query}
          onChange={(v: string) => {
            setQuery(v);
            setShownG(LIST_PAGE);
            setShownD(LIST_PAGE);
          }}
        />
      </FormSection>

      <FormSection title={`DMs and group chats (${dms.length})`}>
        {dms.length === 0 && <FormRow label="None found" />}
        {dms.slice(0, shownD).map(d => (
          <FormRow
            key={`c${d.id}`}
            label={d.name}
            subLabel={ruleText(`c:${d.id}`, false)}
            trailing={<FormRow.Arrow />}
            onPress={() => cycle(`c:${d.id}`)}
          />
        ))}
        {dms.length > shownD && (
          <FormRow
            label="Show more"
            subLabel={`${dms.length - shownD} more`}
            trailing={<FormRow.Arrow />}
            onPress={() => setShownD(n => n + LIST_PAGE)}
          />
        )}
      </FormSection>

      <FormSection title={`Servers (${guilds.length})`}>
        {guilds.length === 0 && <FormRow label="None found" />}
        {guilds.slice(0, shownG).map(g => (
          <FormRow
            key={`g${g.id}`}
            label={g.name}
            subLabel={ruleText(`g:${g.id}`, true)}
            trailing={<FormRow.Arrow />}
            onPress={() => cycle(`g:${g.id}`)}
          />
        ))}
        {guilds.length > shownG && (
          <FormRow
            label="Show more"
            subLabel={`${guilds.length - shownG} more`}
            trailing={<FormRow.Arrow />}
            onPress={() => setShownG(n => n + LIST_PAGE)}
          />
        )}
      </FormSection>
    </>
  );
}

/* ----- The screens people open ----- */

// Deleted / Edited / Chats tabs, shared by the dellogs page and the plugin's settings screen
function Browser() {
  const [tab, setTab] = React.useState<"deleted" | "edited" | "chats">("deleted");
  const [, refresh] = React.useState(0);

  // keep the counts in the tab rows fresh
  React.useEffect(() => {
    const listener = () => refresh(x => x + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const row = (id: "deleted" | "edited" | "chats", label: string, subLabel: string) => (
    <FormRow
      key={id}
      label={`${tab === id ? "● " : "○ "}${label}`}
      subLabel={subLabel}
      trailing={<FormRow.Arrow />}
      onPress={() => setTab(id)}
    />
  );

  return (
    <>
      <FormSection title="View">
        {row("deleted", `Deleted (${deleted.length})`, "Messages people deleted")}
        {row("edited", `Edited (${edited.length})`, "Messages that have earlier versions")}
        {row("chats", "Chats and rules", "Choose which servers and DMs to ignore or keep")}
      </FormSection>
      <Boundary key={tab}>{tab === "chats" ? <Chats /> : <Logs kind={tab} />}</Boundary>
    </>
  );
}

// Opened from Settings > Bunny > dellogs
const DelLogsPage: any = () => (
  <ScrollView keyboardShouldPersistTaps="handled">
    <Boundary>
      <Browser />
    </Boundary>
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
        {toggle("logEdits", "Save edit history", "Keep earlier versions of edited messages")}
        {toggle("toast", "Show a toast on delete", "A small popup when a remembered message is deleted")}
        {toggle("toastEdits", "Show a toast on edit", "A small popup when a remembered message is edited")}
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

      <Boundary>
        <Browser />
      </Boundary>
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
