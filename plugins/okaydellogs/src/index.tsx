import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, React, ReactNative } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { Forms, General } from "@vendetta/ui/components";
import { registerSection } from "@vendetta/ui/settings";
import { showToast } from "@vendetta/ui/toasts";

const { ScrollView } = General;
const { FormSection, FormRow, FormSwitch, FormInput } = Forms;
const { View, Image, Pressable, Linking } = ReactNative;

type Att = { n: string; u: string; p?: string; t?: string; d?: number; v?: boolean };
type Emb = { u: string; o: string };
type Reply = { a: string; t: string };
type Entry = {
  id: string; c: string; g?: string; a: string; ai: string; t: string; ts: number;
  at?: Att[]; em?: Emb[]; st?: string[]; rp?: Reply; where: string; del?: number;
};
type EditEntry = { id: string; before: Entry; after: Entry; editedAt: number };
type ChatState = "Normal" | "Ignore" | "Keep";
type ChatInfo = { key: string; id: string; guildId?: string; name: string; detail: string; isDM: boolean };

const SECTION_NAME = "Bunny";
const MAX_CACHE = 1500;
const MAX_DELETED = 500;
const MAX_EDITED = 500;
const MAX_EDITS_PER_MESSAGE = 5;
const SAVE_DELAY = 15000;
const PAGE = 25;
const OK_TYPES = new Set([0, 19, 20]);
const IMG_RE = /\.(png|jpe?g|gif|webp|bmp)(\?|$)/i;
const VOICE_FLAG = 8192;
const EPHEMERAL_FLAG = 64;
const DEFAULTS: Record<string, any> = {
  ignoreSelf: true, ignoreBots: false, toast: true, cacheImages: true, cacheServers: false,
  ignoreAllServers: false, ignoreAllDMs: false,
};
for (const key in DEFAULTS) if (storage[key] === undefined) storage[key] = DEFAULTS[key];

const cache = new Map<string, Entry>();
let deleted: Entry[] = [];
let edited: EditEntry[] = [];
let chatRules: Record<string, ChatState> = {};
const listeners = new Set<() => void>();
let UserStore: any, ChannelStore: any, GuildStore: any, MessageStore: any;
let unregisterSection: any;
let saveTimer: any;
let lastToast = 0;

const fmt = (ts: number) => new Date(ts).toLocaleString();
const isImage = (a: Att) => !!a.t?.startsWith("image/") || IMG_RE.test(a.n);
const attKind = (a: Att): "voice" | "image" | "video" | "file" =>
  a.v ? "voice" : isImage(a) ? "image" : a.t?.startsWith("video/") ? "video" : "file";
const openUrl = (url: string) => Linking.openURL(url).catch(() => showToast("Couldn't open that link"));
const userName = (u: any): string => u?.global_name ?? u?.globalName ?? u?.username ?? "Unknown";

function restore() {
  try {
    cache.clear();
    const c = JSON.parse(storage.cacheJson ?? "[]");
    if (Array.isArray(c)) for (const e of c) if (e?.id) cache.set(e.id, e);
    const d = JSON.parse(storage.deletedJson ?? "[]");
    deleted = Array.isArray(d) ? d : [];
    const ed = JSON.parse(storage.editedJson ?? "[]");
    edited = Array.isArray(ed) ? ed : [];
    const rules = JSON.parse(storage.chatRulesJson ?? "{}");
    chatRules = rules && typeof rules === "object" ? rules : {};
  } catch (err) {
    console.error("[OkayDelLogs] restore failed", err);
    deleted = []; edited = []; chatRules = {};
  }
}
function flush() {
  clearTimeout(saveTimer); saveTimer = undefined;
  try {
    storage.cacheJson = JSON.stringify([...cache.values()]);
    storage.deletedJson = JSON.stringify(deleted);
    storage.editedJson = JSON.stringify(edited);
    storage.chatRulesJson = JSON.stringify(chatRules);
  } catch (err) { console.error("[OkayDelLogs] save failed", err); }
}
function markDirty() { if (!saveTimer) saveTimer = setTimeout(flush, SAVE_DELAY); }

function groupName(channel: any): string {
  if (channel?.name) return channel.name;
  const raw = (channel?.rawRecipients ?? []).map((r: any) => userName(r)).filter(Boolean);
  if (raw.length) return raw.join(", ");
  const recipients = (channel?.recipients ?? []).map((id: string) => UserStore?.getUser?.(id)).filter(Boolean).map(userName);
  return recipients.length ? recipients.join(", ") : "unnamed group";
}
function whereLabel(channelId: string, guildId?: string): string {
  try {
    const channel = ChannelStore?.getChannel?.(channelId);
    const guild = guildId ? GuildStore?.getGuild?.(guildId) : undefined;
    if (!channel) return guild?.name ?? "Unknown chat";
    if (guild) return `${guild.name} #${channel.name ?? "channel"}`;
    if (channel.type === 1) {
      const current = UserStore?.getCurrentUser?.()?.id;
      const recipient = (channel.rawRecipients ?? []).find((u: any) => u?.id !== current) ?? channel.rawRecipients?.[0];
      return recipient ? `DM with ${userName(recipient)}` : "DM";
    }
    if (channel.type === 3) return `GC "${groupName(channel)}"`;
    return channel.name || "Chat";
  } catch { return "Unknown chat"; }
}
function chatKey(channelId: string, guildId?: string) { return guildId ? `g:${guildId}` : `c:${channelId}`; }
function chatState(channelId: string, guildId?: string): ChatState {
  const key = chatKey(channelId, guildId);
  if (chatRules[key]) return chatRules[key];
  const ignored = guildId ? !!storage.ignoreAllServers : !!storage.ignoreAllDMs;
  return ignored ? "Ignore" : "Normal";
}
function isIgnored(e: Pick<Entry, "c" | "g">) { return chatState(e.c, e.g) === "Ignore"; }
function isKept(e: Pick<Entry, "c" | "g">) { return chatState(e.c, e.g) === "Keep"; }

function extractAttachments(list: any[]): Att[] {
  return (list ?? []).slice(0, 6).map((a: any) => ({
    n: a.filename ?? "file", u: a.url, p: a.proxy_url, t: a.content_type,
    d: typeof a.duration_secs === "number" ? a.duration_secs : undefined,
    v: a.duration_secs != null || a.waveform != null ? true : undefined,
  })).filter((a: Att) => !!a.u);
}
function extractEmbeds(list: any[]): Emb[] {
  const out: Emb[] = [];
  for (const e of (list ?? []).slice(0, 4)) {
    const shown = e.image?.url ?? e.thumbnail?.url;
    const open = e.url ?? e.video?.url ?? shown;
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
function replyOf(m: any, channelId: string): Reply | undefined {
  try {
    let ref = m.referenced_message;
    const refId = m.message_reference?.message_id;
    if (!ref && refId) {
      const known = cache.get(refId);
      if (known) return { a: known.a, t: (known.t || mediaLabel(known)).slice(0, 300) };
      const record = MessageStore?.getMessage?.(m.message_reference.channel_id ?? channelId, refId);
      if (record) ref = { author: record.author, content: record.content, attachments: record.attachments };
    }
    if (!ref) return undefined;
    const text = String(ref.content ?? "").slice(0, 300);
    return { a: userName(ref.author), t: text || (ref.attachments?.length ? "[attachment]" : "") };
  } catch { return undefined; }
}
function toEntry(m: any, channelHint?: string): Entry | null {
  const channelId = m?.channel_id ?? channelHint;
  if (!m?.id || !channelId || !m.author || !OK_TYPES.has(m.type ?? 0)) return null;
  if ((m.flags ?? 0) & EPHEMERAL_FLAG) return null;
  const guildId = m.guild_id ?? ChannelStore?.getChannel?.(channelId)?.guild_id ?? undefined;
  const at = extractAttachments(m.attachments);
  if ((m.flags ?? 0) & VOICE_FLAG) for (const a of at) a.v = true;
  const em = extractEmbeds(m.embeds);
  const st = (m.sticker_items ?? []).map((s: any) => s.name).filter(Boolean);
  const parsed = Date.parse(m.timestamp);
  return {
    id: m.id, c: channelId, g: guildId, a: userName(m.author), ai: m.author.id,
    t: String(m.content ?? "").slice(0, 2000), ts: Number.isFinite(parsed) ? parsed : Date.now(),
    at: at.length ? at : undefined, em: em.length ? em : undefined, st: st.length ? st : undefined,
    rp: replyOf(m, channelId), where: whereLabel(channelId, guildId),
  };
}
function allowed(m: any): boolean {
  const myId = UserStore?.getCurrentUser?.()?.id;
  if (storage.ignoreSelf && myId && m.author?.id === myId) return false;
  if (storage.ignoreBots && m.author?.bot) return false;
  return true;
}
function prefetchMedia(e: Entry) {
  if (!storage.cacheImages || (e.g && !storage.cacheServers)) return;
  try {
    const urls = [
      ...(e.at ?? []).filter(a => attKind(a) === "image").map(a => a.u),
      ...(e.em ?? []).filter(m => m.u && IMG_RE.test(m.u)).map(m => m.u),
    ];
    for (const url of urls.slice(0, 4)) {
      const result = (Image as any).prefetch?.(url);
      result?.catch?.(() => {});
    }
  } catch (err) { console.error("[OkayDelLogs] image cache failed", err); }
}

function trimCache() {
  while (cache.size > MAX_CACHE) {
    let removed = false;
    for (const [id, entry] of cache) {
      if (!isKept(entry)) { cache.delete(id); removed = true; break; }
    }
    if (!removed) break;
  }
}
function trimLogs() {
  while (deleted.length > MAX_DELETED) {
    const index = deleted.findIndex(e => !isKept(e));
    if (index < 0) break;
    deleted.splice(index, 1);
  }
  while (edited.length > MAX_EDITED) {
    const index = edited.findIndex(e => !isKept(e.before));
    if (index < 0) break;
    edited.splice(index, 1);
  }
}
function remember(entry: Entry) {
  if (isIgnored(entry)) { cache.delete(entry.id); return; }
  cache.delete(entry.id);
  cache.set(entry.id, entry);
  trimCache();
  markDirty();
}
function consider(m: any, channelHint?: string, live = false) {
  try {
    const entry = toEntry(m, channelHint);
    if (!entry || !allowed(m) || isIgnored(entry)) return;
    remember(entry);
    if (live) prefetchMedia(entry);
  } catch (err) { console.error("[OkayDelLogs] couldn't log a message", err); }
}
function handleUpdate(m: any, channelHint?: string) {
  if (!m?.id) return;
  const existing = cache.get(m.id);
  if (!existing) {
    if (m.author) consider(m, channelHint, true);
    return;
  }
  if (isIgnored(existing)) { cache.delete(m.id); markDirty(); return; }

  const next: Entry = { ...existing };
  if (typeof m.content === "string") next.t = m.content.slice(0, 2000);
  if (Array.isArray(m.embeds)) { const em = extractEmbeds(m.embeds); next.em = em.length ? em : undefined; }
  if (Array.isArray(m.attachments)) { const at = extractAttachments(m.attachments); next.at = at.length ? at : undefined; }
  if (Array.isArray(m.sticker_items)) {
    const st = m.sticker_items.map((s: any) => s.name).filter(Boolean);
    next.st = st.length ? st : undefined;
  }  const changed = next.t !== existing.t || JSON.stringify(next.at ?? []) !== JSON.stringify(existing.at ?? [])
    || JSON.stringify(next.em ?? []) !== JSON.stringify(existing.em ?? [])
    || JSON.stringify(next.st ?? []) !== JSON.stringify(existing.st ?? []);
  if (!changed) return;

  const history: EditEntry = { id: existing.id, before: { ...existing }, after: { ...next }, editedAt: Date.now() };
  edited.unshift(history);
  let count = 0;
  edited = edited.filter(x => x.id !== existing.id || ++count <= MAX_EDITS_PER_MESSAGE);
  cache.set(m.id, next);
  trimLogs();
  markDirty();
  if (Array.isArray(m.embeds) || Array.isArray(m.attachments)) prefetchMedia(next);
  listeners.forEach(f => f());
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
  if (!entry) return;
  cache.delete(id);
  if (isIgnored(entry)) { markDirty(); return; }
  const myId = UserStore?.getCurrentUser?.()?.id;
  if (storage.ignoreSelf && myId && entry.ai === myId) { markDirty(); return; }
  entry.del = Date.now();
  deleted.unshift(entry);
  trimLogs();
  markDirty();
  listeners.forEach(f => f());
  const now = Date.now();
  if (storage.toast && now - lastToast > 2000) {
    lastToast = now;
    showToast(`🗑️ ${entry.a}: ${summary(entry)}`);
  }
}
function observe(event: any) {
  switch (event?.type) {
    case "MESSAGE_CREATE":
      if (!event.optimistic && !event.isPushNotification) consider(event.message, event.channelId, true);
      break;
    case "LOAD_MESSAGES_SUCCESS":
      for (const m of event.messages ?? []) consider(m, event.channelId);
      break;
    case "MESSAGE_UPDATE": handleUpdate(event.message, event.channelId); break;
    case "MESSAGE_DELETE": handleDelete(event.id); break;
    case "MESSAGE_DELETE_BULK": for (const id of event.ids ?? []) handleDelete(id); break;
  }
}

function getChats(): ChatInfo[] {
  const out: ChatInfo[] = [];
  try {
    const guilds = GuildStore?.getGuilds?.() ?? {};
    for (const guild of Object.values(guilds) as any[]) {
      if (!guild?.id) continue;
      out.push({ key: `g:${guild.id}`, id: guild.id, guildId: guild.id, name: guild.name ?? "Unnamed server", detail: "Server", isDM: false });
    }
  } catch {}
  try {
    const channels = ChannelStore?.getSortedPrivateChannels?.() ?? ChannelStore?.getPrivateChannels?.() ?? [];
    const values = Array.isArray(channels) ? channels : Object.values(channels);
    for (const item of values as any[]) {
      const channel = typeof item === "string" ? ChannelStore?.getChannel?.(item) : item;
      if (!channel?.id || (channel.type !== 1 && channel.type !== 3)) continue;
      const name = channel.type === 1
        ? (() => {
            const current = UserStore?.getCurrentUser?.()?.id;
            const recipient = (channel.rawRecipients ?? []).find((u: any) => u?.id !== current) ?? channel.rawRecipients?.[0];
            return recipient ? `DM with ${userName(recipient)}` : "Direct message";
          })()
        : `Group: ${groupName(channel)}`;
      out.push({ key: `c:${channel.id}`, id: channel.id, name, detail: channel.type === 1 ? "Direct message" : "Group DM", isDM: true });
    }
  } catch {}
  const seen = new Set(out.map(x => x.key));
  for (const e of [...cache.values(), ...deleted, ...edited.map(x => x.before)]) {
    const key = chatKey(e.c, e.g);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key, id: e.g ?? e.c, guildId: e.g, name: e.where,
      detail: e.g ? "Server" : "Direct message / group", isDM: !e.g,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
function cycleChatState(chat: ChatInfo) {
  const current = chatRules[chat.key] ?? (chat.isDM
    ? (storage.ignoreAllDMs ? "Ignore" : "Normal")
    : (storage.ignoreAllServers ? "Ignore" : "Normal"));
  const next: ChatState = current === "Normal" ? "Ignore" : current === "Ignore" ? "Keep" : "Normal";
  chatRules[chat.key] = next;

  if (next === "Ignore") {
    for (const [id, e] of cache) if (chat.key === chatKey(e.c, e.g)) cache.delete(id);
    deleted = deleted.filter(e => chat.key !== chatKey(e.c, e.g));
    edited = edited.filter(e => chat.key !== chatKey(e.before.c, e.before.g));
  }
  trimCache(); trimLogs(); flush(); listeners.forEach(f => f());
  showToast(`${chat.name}: ${next}`);
}

/* ------------------------------- UI -------------------------------- */

function Thumb({ uri, fallback, open }: { uri: string; fallback?: string; open: string }) {
  const [src, setSrc] = React.useState(uri);
  return (
    <Pressable onPress={() => openUrl(open)} style={{ marginLeft: 16, marginBottom: 8 }}>
      <Image source={{ uri: src }} resizeMode="contain" style={{ width: 240, height: 180, borderRadius: 8 }}
        onError={() => { if (fallback && src !== fallback) setSrc(fallback); }} />
    </Pressable>
  );
}
function EntryContent({ e }: { e: Entry }) {
  const atts = e.at ?? [];
  const hasMedia = atts.length > 0 || !!e.em?.length || !!e.st?.length;
  return (
    <View style={{ marginBottom: 14 }}>
      {e.rp && <FormRow label={`↪ Replying to ${e.rp.a}`} subLabel={e.rp.t || "(no text)"} />}
      <FormRow label={e.a} subLabel={e.where} />
      <FormRow label={e.t || (hasMedia ? "(no text, media below)" : "(empty)")} subLabel={`sent ${fmt(e.ts)}`} />
      {atts.map((a, i) => {
        const kind = attKind(a);
        if (kind === "image") return <Thumb key={`a${i}`} uri={a.u} fallback={a.p} open={a.u} />;
        const label = kind === "voice" ? `🎤 Voice message${a.d ? ` · ${Math.round(a.d)}s` : ""}`
          : kind === "video" ? `🎞️ ${a.n}` : `📎 ${a.n}`;
        return <FormRow key={`a${i}`} label={label} subLabel="Tap to open" trailing={<FormRow.Arrow />} onPress={() => openUrl(a.u)} />;
      })}
      {(e.em ?? []).map((m, i) => m.u && IMG_RE.test(m.u)
        ? <Thumb key={`e${i}`} uri={m.u} open={m.o} />
        : <FormRow key={`e${i}`} label="🔗 Open embed" subLabel={m.o} trailing={<FormRow.Arrow />} onPress={() => openUrl(m.o)} />)}
      {(e.st ?? []).map((s, i) => <FormRow key={`s${i}`} label={`Sticker: ${s}`} />)}
    </View>
  );
}
function DeletedItem({ e }: { e: Entry }) {
  return <View>
    <EntryContent e={e} />
    <FormRow label="Deleted" subLabel={fmt(e.del ?? e.ts)} />
  </View>;
}
function EditedItem({ e }: { e: EditEntry }) {
  return <View style={{ marginBottom: 16 }}>
    <FormRow label={e.before.a} subLabel={`${e.before.where} · edited ${fmt(e.editedAt)}`} />
    <FormRow label="Before" subLabel={e.before.t || summary(e.before)} />
    <FormRow label="After" subLabel={e.after.t || summary(e.after)} />
    {(e.before.at?.length || e.after.at?.length) ? (
      <FormRow label="Media changed" subLabel="Attachments and embeds are saved when Discord includes them in the update." />
    ) : null}
  </View>;
}function Logs() {
  const [, refresh] = React.useState(0);
  const [shown, setShown] = React.useState(PAGE);
  const [query, setQuery] = React.useState("");
  const [tab, setTab] = React.useState<"Deleted" | "Edited">("Deleted");
  const [confirmClear, setConfirmClear] = React.useState(false);
  React.useEffect(() => {
    const listener = () => refresh(x => x + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  const q = query.trim().toLowerCase();
  const source: any[] = tab === "Deleted" ? deleted : edited;
  const list = q ? source.filter(x => {
    const e: Entry = tab === "Deleted" ? x : x.before;
    const after = tab === "Edited" ? x.after : undefined;
    return `${e.t} ${after?.t ?? ""} ${e.a} ${e.where} ${e.rp?.a ?? ""}`.toLowerCase().includes(q);
  }) : source;
  return <>
    <FormSection title="Message history">
      <FormRow label={`Deleted (${deleted.length})`} subLabel={tab === "Deleted" ? "Currently viewing" : "Tap to view"} onPress={() => { setTab("Deleted"); setShown(PAGE); }} />
      <FormRow label={`Edited (${edited.length})`} subLabel={tab === "Edited" ? "Currently viewing" : "Tap to view"} onPress={() => { setTab("Edited"); setShown(PAGE); }} />
      <FormInput title="Search" placeholder="text, name, server or group chat" value={query}
        onChange={(v: string) => { setQuery(v); setShown(PAGE); }} />
      {list.length === 0 && <FormRow label="Nothing here yet" subLabel={tab === "Deleted" ? "Deleted messages will appear here" : "Edited messages will appear here"} />}
      {list.slice(0, shown).map((e: any, i: number) => tab === "Deleted"
        ? <DeletedItem key={`${e.id}-${i}`} e={e} />
        : <EditedItem key={`${e.id}-${e.editedAt}-${i}`} e={e} />)}
      {list.length > shown && <FormRow label="Show more" subLabel={`${list.length - shown} more`} trailing={<FormRow.Arrow />} onPress={() => setShown(s => s + PAGE)} />}
    </FormSection>
    <FormSection title="Manage">
      <FormRow label={confirmClear ? "Tap again to clear this history" : `Clear ${tab.toLowerCase()} history`}
        subLabel={`${source.length} saved`} trailing={<FormRow.Arrow />}
        onPress={() => {
          if (!confirmClear) { setConfirmClear(true); setTimeout(() => setConfirmClear(false), 4000); return; }
          setConfirmClear(false);
          if (tab === "Deleted") deleted = []; else edited = [];
          flush(); refresh(x => x + 1); showToast("Cleared");
        }} />
    </FormSection>
  </>;
}
const DelLogsPage: any = () => <ScrollView keyboardShouldPersistTaps="handled"><Logs /></ScrollView>;
DelLogsPage.default = DelLogsPage;

function Chats() {
  const [, refresh] = React.useState(0);
  const [query, setQuery] = React.useState("");
  React.useEffect(() => {
    const listener = () => refresh(x => x + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  const q = query.trim().toLowerCase();
  const chats = getChats().filter(c => `${c.name} ${c.detail}`.toLowerCase().includes(q));
  return <>
    <FormSection title="Default chat behavior">
      <FormRow label="Ignore all servers" subLabel="Chats without an individual override are ignored"
        trailing={<FormSwitch value={!!storage.ignoreAllServers} onValueChange={(v: boolean) => { storage.ignoreAllServers = v; listeners.forEach(f => f()); }} />} />
      <FormRow label="Ignore all DMs and group chats" subLabel="Chats without an individual override are ignored"
        trailing={<FormSwitch value={!!storage.ignoreAllDMs} onValueChange={(v: boolean) => { storage.ignoreAllDMs = v; listeners.forEach(f => f()); }} />} />
    </FormSection>
    <FormSection title={`Chats (${chats.length})`}>
      <FormInput title="Search chats" placeholder="Search servers, people or group chats" value={query} onChange={(v: string) => setQuery(v)} />
      <FormRow label="Tap a chat to cycle: Normal → Ignore → Keep → Normal" subLabel="Keep protects its history from automatic trimming." />
      {chats.map(chat => {
        const state = chatState(chat.id, chat.guildId);
        return <FormRow key={chat.key} label={chat.name} subLabel={`${chat.detail} · ${state}`}
          trailing={<FormRow.Arrow />} onPress={() => cycleChatState(chat)} />;
      })}
      {!chats.length && <FormRow label="No chats found" subLabel="Try another search, or open the chats in Discord first." />}
    </FormSection>
  </>;
}

function Settings() {
  useProxy(storage);
  const toggle = (key: string, label: string, subLabel: string) => (
    <FormRow key={key} label={label} subLabel={subLabel}
      trailing={<FormSwitch value={!!storage[key]} onValueChange={(v: boolean) => { storage[key] = v; }} />} />
  );
  return <ScrollView keyboardShouldPersistTaps="handled">
    <FormSection title="Settings">
      {toggle("ignoreSelf", "Ignore my own messages", "Don't remember or log messages you sent")}
      {toggle("ignoreBots", "Ignore bot messages", "Bots delete their own messages a lot")}
      {toggle("toast", "Show a toast on delete", "A small popup when a remembered message is deleted")}
      {toggle("cacheImages", "Cache images of new DM / GC messages", "Best effort, so images can still show after deletion")}
      {toggle("cacheServers", "Also cache server images", "Uses more data")}
    </FormSection>
    <FormSection title="History limits">
      <FormRow label="Recent message cache" subLabel={`${MAX_CACHE} messages; Keep chats can exceed this`} />
      <FormRow label="Deleted history" subLabel={`${MAX_DELETED} entries; Keep chats can exceed this`} />
      <FormRow label="Edit history" subLabel={`Up to ${MAX_EDITS_PER_MESSAGE} edits per message; ${MAX_EDITED} entries overall`} />
    </FormSection>
    <Chats />
    <Logs />
  </ScrollView>;
}

/* ----------------------------- lifecycle --------------------------- */
function getStores() {
  try { UserStore = findByStoreName("UserStore"); } catch {}
  try { ChannelStore = findByStoreName("ChannelStore"); } catch {}
  try { GuildStore = findByStoreName("GuildStore"); } catch {}
  try { MessageStore = findByStoreName("MessageStore"); } catch {}
  try { UserStore ??= findByProps("getCurrentUser"); } catch {}
  try { ChannelStore ??= findByProps("getChannel", "getDMFromUserId"); } catch {}
  try { GuildStore ??= findByProps("getGuild", "getGuilds"); } catch {}
  try { MessageStore ??= findByProps("getMessage", "getMessages"); } catch {}
}
export default {
  onLoad() {
    restore();
    getStores();
    try {
      FluxDispatcher.subscribe("MESSAGE_CREATE", observe);
      FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS", observe);
      FluxDispatcher.subscribe("MESSAGE_UPDATE", observe);
      FluxDispatcher.subscribe("MESSAGE_DELETE", observe);
      FluxDispatcher.subscribe("MESSAGE_DELETE_BULK", observe);
    } catch (err) { console.error("[OkayDelLogs] event subscription failed", err); }
    try {
      unregisterSection = (registerSection as any)({
        section: SECTION_NAME,
        name: "okaydellogs",
        title: "OkayDelLogs",
        screen: DelLogsPage,
        render: DelLogsPage,
      });
    } catch (err) { console.error("[OkayDelLogs] settings section registration failed", err); }
  },
  onUnload() {
    try {
      FluxDispatcher.unsubscribe("MESSAGE_CREATE", observe);
      FluxDispatcher.unsubscribe("LOAD_MESSAGES_SUCCESS", observe);
      FluxDispatcher.unsubscribe("MESSAGE_UPDATE", observe);
      FluxDispatcher.unsubscribe("MESSAGE_DELETE", observe);
      FluxDispatcher.unsubscribe("MESSAGE_DELETE_BULK", observe);
    } catch {}
    try { unregisterSection?.(); } catch {}
    unregisterSection = undefined;
    flush();
    listeners.clear();
  },
};
export const settings = Settings;