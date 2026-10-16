import { React, FluxDispatcher } from "@vendetta/metro/common";
import { findByStoreName, findByProps } from "@vendetta/metro";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { Forms, General } from "@vendetta/ui/components";
import { showToast } from "@vendetta/ui/toasts";

// ---------- safe finder ----------
const tryFind = <T,>(fn: () => T): T | null => {
  try { return fn() ?? null; } catch { return null; }
};

// ---------- multi-strategy finders (Shiggy / Bunny / Revenge / Vendetta) ----------
const api: any = tryFind(() => findByProps("get", "post", "put"));

const QuestsStore: any =
  tryFind(() => findByStoreName("QuestsStore")) ??
  tryFind(() => findByStoreName("QuestStore")) ??
  tryFind(() => findByProps("quests", "getQuest")) ??
  tryFind(() => findByProps("getQuest", "getQuests")) ??
  tryFind(() => findByProps("quests")) ??
  null;

const RunningGameStore: any =
  tryFind(() => findByStoreName("RunningGameStore")) ??
  tryFind(() => findByProps("getRunningGames", "getGameForPID")) ??
  tryFind(() => findByProps("getRunningGames")) ??
  null;

const StreamingStore: any =
  tryFind(() => findByStoreName("ApplicationStreamingStore")) ??
  tryFind(() => findByProps("getStreamerActiveStreamMetadata")) ??
  null;

// ---------- runtime state ----------
const timers: ReturnType<typeof setTimeout>[] = [];
const subs: Array<[string, (...a: any[]) => void]> = [];
let running = false;
let retries = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let connSub: ((...a: any[]) => void) | null = null;

// ---------- storage defaults ----------
if (typeof storage.enabled !== "boolean") storage.enabled = true;
if (!Array.isArray(storage.log)) storage.log = [];
if (typeof storage._v !== "number") storage._v = 0;

const pushLog = (line: string) => {
  storage.log = [`${new Date().toLocaleTimeString()} ${line}`, ...storage.log].slice(0, 40);
  storage._v++;
};

// ---------- task discovery ----------
type Task = { name: string; data: any };

function findTask(quest: any): Task | null {
  const cfg = quest.config.taskConfig ?? quest.config.taskConfigV2 ?? {};
  const tasks = cfg.tasks ?? {};
  const order = [
    "WATCH_VIDEO",
    "WATCH_VIDEO_ON_MOBILE",
    "PLAY_ACTIVITY",
    "PLAY_ON_DESKTOP",
    "STREAM_ON_DESKTOP",
  ];
  for (const t of order) if (tasks[t]) return { name: t, data: tasks[t] };
  return null;
}

function listEligibleQuests() {
  if (!QuestsStore?.quests) return [];
  const now = Date.now();
  return [...QuestsStore.quests.values()].filter((q: any) => {
    const us = q.userStatus;
    if (!us?.enrolledAt || us?.completedAt) return false;
    if (new Date(q.config.expiresAt).getTime() <= now) return false;
    return findTask(q) != null;
  });
}

// ---------- WATCH_VIDEO — silent, stops short of claim ----------
function runVideoQuest(quest: any, task: Task) {
  const key = task.name;
  const need = task.data.target as number;
  let done = Math.floor(quest.userStatus?.progress?.[key]?.value ?? 0);
  const speed = 7;

  const tick = async () => {
    while (running && done < need) {
      const step = Math.min(speed, need - done);
      await new Promise<void>((r) => { timers.push(setTimeout(r, step * 1000)); });
      if (!running) return;
      done = Math.min(need, done + step);
      try {
        await api.post({
          url: `/quests/${quest.id}/video-progress`,
          body: { timestamp: done + Math.random() },
        });
      } catch (e) {
        pushLog(`video err: ${String(e).slice(0, 60)}`);
        return;
      }
    }
    // Deliberately NOT calling the exact-target call — that's what
    // triggers Discord's claim prompt / robot check.
    pushLog(`video done (unclaimed): ${quest.config.messages?.questName ?? quest.id}`);
  };
  tick().catch((e) => pushLog(`video crash: ${String(e).slice(0, 60)}`));
}

// ---------- PLAY_ACTIVITY — pure API ----------
function runActivityQuest(quest: any, task: Task) {
  const need = task.data.target as number;
  const streamKey = `call:0:1`;

  const tick = async () => {
    while (running) {
      try {
        const res = await api.post({
          url: `/quests/${quest.id}/heartbeat`,
          body: { stream_key: streamKey, terminal: false },
        });
        const progress = res?.body?.progress?.PLAY_ACTIVITY?.value ?? 0;
        if (progress >= need) {
          pushLog(`activity done (unclaimed): ${quest.config.messages?.questName ?? quest.id}`);
          return;
        }
      } catch (e) {
        pushLog(`activity err: ${String(e).slice(0, 60)}`);
        return;
      }
      await new Promise<void>((r) => { timers.push(setTimeout(r, 20_000)); });
    }
  };
  tick().catch((e) => pushLog(`activity crash: ${String(e).slice(0, 60)}`));
}

// ---------- PLAY_ON_DESKTOP — best-effort store patch ----------
function runDesktopQuest(quest: any, task: Task) {
  if (!RunningGameStore?.getRunningGames) {
    pushLog("desktop: RunningGameStore missing — skipped");
    return;
  }
  const appId = quest.config.application?.id ?? task.data.applications?.[0]?.id;
  if (!appId) { pushLog("desktop: no appId — skipped"); return; }

  const pid = Math.floor(Math.random() * 30000) + 1000;
  const fake = {
    cmdLine: `C:\\Program Files\\Fake\\fake.exe`,
    exeName: "fake.exe",
    exePath: "c:/program files/fake/fake.exe",
    hidden: false,
    isLauncher: false,
    id: appId,
    name: "Fake",
    pid,
    pidPath: [pid],
    processName: "Fake",
    start: Date.now(),
  };

  const realGet = RunningGameStore.getRunningGames;
  const realPid = RunningGameStore.getGameForPID;
  const realGames = realGet.call(RunningGameStore);

  RunningGameStore.getRunningGames = () => [fake];
  RunningGameStore.getGameForPID = (p: number) => (p === pid ? fake : null);
  FluxDispatcher.dispatch({
    type: "RUNNING_GAMES_CHANGE",
    removed: realGames,
    added: [fake],
    games: [fake],
  });

  const handler = (data: any) => {
    const progress = Math.floor(
      data?.userStatus?.progress?.PLAY_ON_DESKTOP?.value ?? 0
    );
    if (progress >= (task.data.target as number)) {
      RunningGameStore.getRunningGames = realGet;
      RunningGameStore.getGameForPID = realPid;
      FluxDispatcher.dispatch({
        type: "RUNNING_GAMES_CHANGE",
        removed: [fake],
        added: [],
        games: [],
      });
      FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", handler);
      pushLog(`desktop done (unclaimed): ${quest.config.messages?.questName ?? quest.id}`);
    }
  };
  FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", handler);
  subs.push(["QUESTS_SEND_HEARTBEAT_SUCCESS", handler]);
  pushLog(`desktop spoofed: ${quest.config.messages?.questName ?? quest.id}`);
}

// ---------- STREAM_ON_DESKTOP — needs a real viewer ----------
function runStreamQuest(quest: any, task: Task) {
  if (!StreamingStore?.getStreamerActiveStreamMetadata) {
    pushLog("stream: StreamingStore missing — skipped");
    return;
  }
  const appId = quest.config.application?.id ?? task.data.applications?.[0]?.id;
  if (!appId) { pushLog("stream: no appId — skipped"); return; }

  const pid = Math.floor(Math.random() * 30000) + 1000;
  const real = StreamingStore.getStreamerActiveStreamMetadata;
  StreamingStore.getStreamerActiveStreamMetadata = () => ({
    id: appId,
    pid,
    sourceName: null,
  });

  const handler = (data: any) => {
    const progress = Math.floor(
      data?.userStatus?.progress?.STREAM_ON_DESKTOP?.value ?? 0
    );
    if (progress >= (task.data.target as number)) {
      StreamingStore.getStreamerActiveStreamMetadata = real;
      FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", handler);
      pushLog(`stream done (unclaimed): ${quest.config.messages?.questName ?? quest.id}`);
    }
  };
  FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", handler);
  subs.push(["QUESTS_SEND_HEARTBEAT_SUCCESS", handler]);
  pushLog(`stream spoofed: ${quest.config.messages?.questName ?? quest.id} (needs VC partner)`);
}

// ---------- main ----------
function start() {
  if (running) return;

  if (!QuestsStore || !QuestsStore.quests) {
    if (retries < 20) {
      retries++;
      pushLog(`QuestsStore not ready (retry ${retries}/20)`);
      retryTimer = setTimeout(start, 15_000);
      return;
    }
    pushLog("QuestsStore not found after retries — abort");
    return;
  }
  if (!api) { pushLog("api client not found — abort"); return; }

  running = true;
  retries = 0;

  const quests = listEligibleQuests();
  pushLog(`scan: ${quests.length} eligible quests`);
  if (!quests.length) { running = false; return; }

  for (const quest of quests) {
    const task = findTask(quest);
    if (!task) continue;
    if (task.name === "WATCH_VIDEO" || task.name === "WATCH_VIDEO_ON_MOBILE") runVideoQuest(quest, task);
    else if (task.name === "PLAY_ACTIVITY") runActivityQuest(quest, task);
    else if (task.name === "PLAY_ON_DESKTOP") runDesktopQuest(quest, task);
    else if (task.name === "STREAM_ON_DESKTOP") runStreamQuest(quest, task);
  }
}

function stop() {
  running = false;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  timers.splice(0).forEach(clearTimeout);
  for (const [evt, fn] of subs.splice(0)) {
    try { FluxDispatcher.unsubscribe(evt, fn); } catch {}
  }
}

// ---------- lifecycle ----------
export const onLoad = () => {
  pushLog("onLoad");
  connSub = () => {
    if (storage.enabled) { retries = 0; start(); }
  };
  try { FluxDispatcher.subscribe("CONNECTION_OPEN", connSub); } catch {}
  if (storage.enabled) start();
};

export const onUnload = () => {
  pushLog("onUnload");
  if (connSub) {
    try { FluxDispatcher.unsubscribe("CONNECTION_OPEN", connSub); } catch {}
    connSub = null;
  }
  stop();
};

// ---------- settings ----------
export const settings = () => {
  useProxy(storage);
  return (
    <General.ScrollView>
      <Forms.FormSection title="QuestSpoofer">
        <Forms.FormRow
          label="Enabled"
          subLabel="Runs on load and on gateway reconnect"
          trailing={
            <Forms.FormSwitch
              value={storage.enabled}
              onValueChange={(v) => {
                storage.enabled = v;
                storage._v++;
                if (v) { retries = 0; start(); }
                else stop();
              }}
            />
          }
        />
        <Forms.FormRow
          label="Run now"
          subLabel="Scan + start any new quests"
          onPress={() => {
            retries = 0;
            start();
            showToast("QuestSpoofer: scan started");
          }}
        />
        <Forms.FormRow
          label="Stop"
          subLabel="Cancel timers and unpatch stores"
          onPress={() => { stop(); showToast("QuestSpoofer: stopped"); }}
        />
        <Forms.FormRow
          label="Dump finders"
          subLabel="Log every quest/stream module we can find"
          onPress={() => {
            const hits: string[] = [];
            const tries: [string, () => any][] = [
              ["Store:QuestsStore",  () => findByStoreName("QuestsStore")],
              ["Store:QuestStore",   () => findByStoreName("QuestStore")],
              ["Props:quests+getQuest", () => findByProps("quests", "getQuest")],
              ["Props:getQuest",     () => findByProps("getQuest")],
              ["Props:quests",       () => findByProps("quests")],
              ["Store:RunningGameStore", () => findByStoreName("RunningGameStore")],
              ["Props:getRunningGames",  () => findByProps("getRunningGames")],
              ["Store:ApplicationStreamingStore", () => findByStoreName("ApplicationStreamingStore")],
              ["Props:getStreamerActiveStreamMetadata", () => findByProps("getStreamerActiveStreamMetadata")],
              ["Props:get+post+put", () => findByProps("get", "post", "put")],
            ];
            for (const [label, fn] of tries) {
              const v = tryFind(fn);
              const shape = v ? Object.keys(v).slice(0, 8).join(",") : "null";
              hits.push(`${label}: ${shape}`);
            }
            storage.log = [`--- DUMP ---`, ...hits, ...storage.log].slice(0, 40);
            storage._v++;
            showToast("QuestSpoofer: dump written to log");
          }}
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
