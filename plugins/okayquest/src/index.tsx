import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, React } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { Forms, General } from "@vendetta/ui/components";
import { showToast } from "@vendetta/ui/toasts";

const socketModule = findByProps("getSocket", "isConnected");
const QuestsStore: any =
  (() => { try { return findByStoreName("QuestsStore"); } catch { return null; } })() ??
  (() => { try { return findByStoreName("QuestStore"); } catch { return null; } })();

const OP_PRESENCE = 3;
const TICK_MS = 30_000;
const MAX_MINUTES = 20; // hard cap per quest, in case progress never advances

// ---------- storage ----------
if (typeof storage.enabled !== "boolean") storage.enabled = true;
if (typeof storage.includeActivity !== "boolean") storage.includeActivity = true; // also handle PLAY_ACTIVITY quests
if (!Array.isArray(storage.log)) storage.log = [];
if (typeof storage._v !== "number") storage._v = 0;

const pushLog = (line: string) => {
  storage.log = [`${new Date().toLocaleTimeString()} ${line}`, ...storage.log].slice(0, 40);
  storage._v++;
};

// ---------- runtime ----------
const timers: ReturnType<typeof setInterval>[] = [];
let running = false;
const startTimes = new Map<string, number>();

function taskOf(quest: any): string | null {
  const cfg = quest.config?.taskConfig ?? quest.config?.taskConfigV2 ?? {};
  const tasks = cfg.tasks ?? {};
  for (const t of ["PLAY_ON_DESKTOP", "PLAY_ACTIVITY", "STREAM_ON_DESKTOP"]) {
    if (tasks[t]) return t;
  }
  return null;
}

function eligible() {
  if (!QuestsStore?.quests) return [];
  const now = Date.now();
  return [...QuestsStore.quests.values()].filter((q: any) => {
    const us = q.userStatus;
    if (!us?.enrolledAt || us?.completedAt) return false;
    if (new Date(q.config.expiresAt).getTime() <= now) return false;
    const t = taskOf(q);
    if (!t) return false;
    if (t === "PLAY_ACTIVITY" && !storage.includeActivity) return false;
    return true;
  });
}

function appIdOf(quest: any): string | null {
  const cfg = quest.config ?? {};
  const task = cfg.taskConfig ?? cfg.taskConfigV2 ?? {};
  const t = taskOf(quest);
  if (!t) return null;
  const data = task.tasks?.[t];
  return cfg.application?.id ?? data?.applications?.[0]?.id ?? null;
}

function appNameOf(quest: any, appId: string): string {
  return (
    quest.config?.application?.name ??
    quest.config?.messages?.questName ??
    `App ${appId}`
  );
}

function progressOf(quest: any): number {
  const t = taskOf(quest);
  if (!t) return 0;
  const us = quest.userStatus ?? {};
  if (t === "PLAY_ON_DESKTOP") return Math.floor(us.progress?.PLAY_ON_DESKTOP?.value ?? 0);
  if (t === "PLAY_ACTIVITY") return Math.floor(us.progress?.PLAY_ACTIVITY?.value ?? 0);
  if (t === "STREAM_ON_DESKTOP") return Math.floor(us.progress?.STREAM_ON_DESKTOP?.value ?? 0);
  return 0;
}

function targetOf(quest: any): number {
  const cfg = quest.config?.taskConfig ?? quest.config?.taskConfigV2 ?? {};
  const t = taskOf(quest);
  return Number(cfg.tasks?.[t]?.target ?? 0) || 900; // 15 min default
}

function currentActivity() {
  try {
    // reuse whatever the client already thinks the local user is doing, if anything
    const UserStore = findByStoreName("UserStore");
    const me = UserStore?.getCurrentUser?.();
    return (me as any)?.activities?.[0] ?? null;
  } catch { return null; }
}

function buildPresence(appId: string, appName: string, sessionId: string) {
  return {
    since: Date.now(),
    activities: [
      {
        application_id: appId,
        name: appName,
        type: 0, // Playing
        session_id: sessionId,
        timestamps: { start: Date.now() },
        flags: 1 << 0, // INSTANCE
        details: "",
        state: "",
      },
    ],
    status: "online",
    afk: false,
  };
}

function sendPresence(appId: string, appName: string, sessionId: string) {
  const socket: any = socketModule?.getSocket?.();
  if (!socket || typeof socket.send !== "function") {
    pushLog("no socket — abort tick");
    return false;
  }
  try {
    socket.send(OP_PRESENCE, buildPresence(appId, appName, sessionId));
    return true;
  } catch (e) {
    pushLog(`send err: ${String(e).slice(0, 60)}`);
    return false;
  }
}

function tickQuest(quest: any) {
  const t = taskOf(quest);
  const appId = appIdOf(quest);
  if (!appId) { pushLog(`no appId for ${quest.id} — skip`); return; }

  const appName = appNameOf(quest, appId);
  const need = targetOf(quest);
  const sessionId = `${quest.id}-${Date.now().toString(36)}`;
  startTimes.set(quest.id, Date.now());

  // initial send
  if (!sendPresence(appId, appName, sessionId)) return;
  pushLog(`presence started: ${appName} (${t})`);

  const iv = setInterval(() => {
    if (!running) { clearInterval(iv); return; }
    const done = progressOf(quest);
    const started = startTimes.get(quest.id) ?? Date.now();
    const minutesElapsed = (Date.now() - started) / 60_000;

    if (done >= need) {
      clearInterval(iv);
      startTimes.delete(quest.id);
      pushLog(`done (unclaimed): ${appName}`);
      return;
    }
    if (minutesElapsed > MAX_MINUTES) {
      clearInterval(iv);
      startTimes.delete(quest.id);
      pushLog(`timeout: ${appName}`);
      return;
    }
    if (!sendPresence(appId, appName, sessionId)) {
      clearInterval(iv);
      startTimes.delete(quest.id);
    }
  }, TICK_MS);

  timers.push(iv);
}

function start() {
  if (running) return;
  if (!QuestsStore?.quests) { pushLog("QuestsStore missing"); return; }
  if (!socketModule?.getSocket?.()) { pushLog("socket missing at start"); return; }

  running = true;
  const qs = eligible();
  pushLog(`scan: ${qs.length} desktop/activity quests`);
  for (const q of qs) tickQuest(q);
}

function stop() {
  running = false;
  timers.splice(0).forEach(clearInterval);
  startTimes.clear();
  // clear presence so we don't leave a fake game hanging
  const socket: any = socketModule?.getSocket?.();
  if (socket?.send) {
    try {
      socket.send(OP_PRESENCE, { since: 0, activities: [], status: "online", afk: false });
    } catch {}
  }
}

// ---------- lifecycle ----------
let connSub: (() => void) | null = null;

export const onLoad = () => {
  pushLog("onLoad");
  connSub = () => {
    if (storage.enabled) { stop(); start(); }
  };
  try { FluxDispatcher.subscribe("CONNECTION_OPEN", connSub); } catch {}
  if (storage.enabled) start();
};

export const onUnload = () => {
  pushLog("onUnload");
  if (connSub) { try { FluxDispatcher.unsubscribe("CONNECTION_OPEN", connSub); } catch {} }
  stop();
};

// ---------- settings ----------
export const settings = () => {
  useProxy(storage);
  return (
    <General.ScrollView>
      <Forms.FormSection title="QuestPresence">
        <Forms.FormRow
          label="Enabled"
          subLabel="Emits gateway presence for desktop quests"
          trailing={
            <Forms.FormSwitch
              value={storage.enabled}
              onValueChange={(v: boolean) => {
                storage.enabled = v; storage._v++;
                if (v) { stop(); start(); } else stop();
              }}
            />
          }
        />
        <Forms.FormRow
          label="Include PLAY_ACTIVITY"
          subLabel="Also fake presence for activity-type quests"
          trailing={
            <Forms.FormSwitch
              value={storage.includeActivity}
              onValueChange={(v: boolean) => {
                storage.includeActivity = v; storage._v++;
                stop(); if (storage.enabled) start();
              }}
            />
          }
        />
        <Forms.FormRow
          label="Run now"
          subLabel="Rescan and restart all quest presence loops"
          onPress={() => { stop(); start(); showToast("QuestPresence: restarted"); }}
        />
        <Forms.FormRow
          label="Stop"
          subLabel="Cancel presence loops and clear fake activity"
          onPress={() => { stop(); showToast("QuestPresence: stopped"); }}
        />
        <Forms.FormRow
          label="Clear log"
          onPress={() => { storage.log = []; storage._v++; }}
        />
      </Forms.FormSection>
      <Forms.FormSection title="Log">
        <Forms.FormRow
          label={storage.log.length ? storage.log.slice(0, 8).join("\n") : "no entries"}
          subLabel="newest first — up to 40 kept"
        />
      </Forms.FormSection>
    </General.ScrollView>
  );
};