import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, React } from "@vendetta/metro/common";
import { before, instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { Forms, General } from "@vendetta/ui/components";
import { registerSection } from "@vendetta/ui/settings";
import { showToast } from "@vendetta/ui/toasts";

const { ScrollView } = General;
const { FormSection, FormRow, FormSwitch } = Forms;

/* ------------------------------------------------------------------ */
/* How this works                                                      */
/* ------------------------------------------------------------------ */
// Your phone keeps two separate things: what your audio is really doing
// (muted / deafened on your side) and what it tells Discord's servers, which
// is what everyone else sees. This plugin only changes the second one: just
// before your voice status is sent out, it swaps in "muted" / "deafened".
// Your own audio is never touched, so you keep hearing (and, hopefully, talking).
//
// Two hooks, because I can't see which one your Discord build uses:
//  1. the gateway socket's voiceStateUpdate method (preferred)
//  2. WebSocket.send, looking for the voice status packet (fallback, JSON only)
// The Diagnostics section on the settings page shows which ones attached
// and what the last rewritten status was.

/* ------------------------------------------------------------------ */
/* Settings + state                                                    */
/* ------------------------------------------------------------------ */

// Settings > Bunny is where the fakedeafen button goes. If another plugin's
// button there disappears, change this to something unique like "OkayFakeDeafen".
const SECTION_NAME = "Bunny";

const DEFAULTS: Record<string, any> = {
  fakeDeafen: false, // others see you deafened (and muted)
  fakeMute: false, // others see you muted
};

for (const key in DEFAULTS) {
  if (storage[key] === undefined) storage[key] = DEFAULTS[key];
}

const diag = {
  gateway: "not attached",
  socket: "not attached",
  count: 0,
  last: "",
};

const listeners = new Set<() => void>(); // diagnostics screens to refresh
const ping = () => listeners.forEach(f => f());

let unpatches: (() => void)[] = [];
const patchedTargets = new WeakSet<object>();
let unregisterSection: any;
let sectionRegistered = false;

const active = () => !!(storage.fakeDeafen || storage.fakeMute);

/** What the server should be told, given what's really happening. */
function fakeFlags(realMute: boolean, realDeaf: boolean) {
  const deaf = realDeaf || !!storage.fakeDeafen;
  const mute = realMute || deaf || !!storage.fakeMute; // deafened always shows as muted too
  return { mute, deaf };
}

function note(realMute: boolean, realDeaf: boolean, mute: boolean, deaf: boolean, via: string) {
  diag.count++;
  diag.last = `real: mute ${realMute}, deaf ${realDeaf} -> sent: mute ${mute}, deaf ${deaf} (${via})`;
  ping();
}

/* ------------------------------------------------------------------ */
/* Hook 1: the gateway socket's voiceStateUpdate                       */
/* ------------------------------------------------------------------ */

function rewriteCall(arg: any): any {
  if (!active() || !arg || typeof arg !== "object") return arg;

  const channelId = arg.channelId ?? arg.channel_id;
  if (!channelId) return arg; // leaving voice, nothing to fake

  const realMute = !!(arg.selfMute ?? arg.self_mute);
  const realDeaf = !!(arg.selfDeaf ?? arg.self_deaf);
  const { mute, deaf } = fakeFlags(realMute, realDeaf);

  const out: any = { ...arg };
  if ("self_mute" in arg) out.self_mute = mute;
  else out.selfMute = mute;
  if ("self_deaf" in arg) out.self_deaf = deaf;
  else out.selfDeaf = deaf;

  note(realMute, realDeaf, mute, deaf, "gateway method");
  return out;
}

function gatewaySocket(): any {
  const store = findByStoreName("GatewayConnectionStore") ?? findByProps("getSocket");
  return store?.getSocket?.();
}

function attachGateway() {
  try {
    const socket = gatewaySocket();
    if (!socket) {
      diag.gateway = "no socket yet";
      return;
    }

    // Prefer the class prototype so new sockets (after a reconnect) are covered too
    const proto = Object.getPrototypeOf(socket);
    const target =
      typeof proto?.voiceStateUpdate === "function"
        ? proto
        : typeof socket.voiceStateUpdate === "function"
          ? socket
          : undefined;

    if (!target) {
      diag.gateway = "voiceStateUpdate not found";
      return;
    }
    if (patchedTargets.has(target)) {
      diag.gateway = "attached";
      return;
    }

    patchedTargets.add(target);
    unpatches.push(
      instead("voiceStateUpdate", target, (args: any[], orig: Function) => {
        try {
          args[0] = rewriteCall(args[0]);
        } catch (err) {
          console.error("[OkayFakeDeafen] couldn't rewrite the voice status", err);
        }
        return orig(...args);
      })
    );
    diag.gateway = "attached";
  } catch (err: any) {
    diag.gateway = `error: ${err?.message ?? err}`;
  } finally {
    ping();
  }
}

/* ------------------------------------------------------------------ */
/* Hook 2: WebSocket.send fallback (JSON packets only)                 */
/* ------------------------------------------------------------------ */

function attachSocketFallback() {
  try {
    const proto = (globalThis as any).WebSocket?.prototype;
    if (typeof proto?.send !== "function") {
      diag.socket = "WebSocket.send not found";
      return;
    }

    unpatches.push(
      before("send", proto, (args: any[]) => {
        try {
          const data = args[0];
          if (!active() || typeof data !== "string" || !data.includes('"op":4')) return;

          const msg = JSON.parse(data);
          const d = msg?.d;
          // only the voice status packet: op 4 with a channel and mute/deaf flags
          if (msg?.op !== 4 || !d?.channel_id || typeof d.self_mute !== "boolean") return;

          const { mute, deaf } = fakeFlags(!!d.self_mute, !!d.self_deaf);
          note(!!d.self_mute, !!d.self_deaf, mute, deaf, "WebSocket fallback");
          d.self_mute = mute;
          d.self_deaf = deaf;
          args[0] = JSON.stringify(msg);
          return args;
        } catch (err) {
          // never break sending because of us
        }
      })
    );
    diag.socket = "attached (JSON only)";
  } catch (err: any) {
    diag.socket = `error: ${err?.message ?? err}`;
  } finally {
    ping();
  }
}

/* ------------------------------------------------------------------ */
/* Re-sending the current status so changes apply instantly            */
/* ------------------------------------------------------------------ */

function resend(quiet = false) {
  try {
    const selected = findByStoreName("SelectedChannelStore") ?? findByProps("getVoiceChannelId");
    const channels = findByStoreName("ChannelStore") ?? findByProps("getChannel");
    const media = findByStoreName("MediaEngineStore");
    const socket = gatewaySocket();

    const channelId = selected?.getVoiceChannelId?.();
    if (!channelId) {
      if (!quiet) showToast("Join a voice channel first");
      return;
    }
    if (typeof socket?.voiceStateUpdate !== "function") {
      if (!quiet) showToast("Couldn't reach Discord's connection");
      return;
    }

    const channel = channels?.getChannel?.(channelId);
    // the hook rewrites this on its way out, so the server gets the fake status
    socket.voiceStateUpdate({
      guildId: channel?.guild_id ?? null,
      channelId,
      selfMute: !!media?.isSelfMute?.(),
      selfDeaf: !!media?.isSelfDeaf?.(),
      selfVideo: !!media?.isVideoEnabled?.(),
    });
    if (!quiet) showToast("Voice status re-sent");
  } catch (err) {
    console.error("[OkayFakeDeafen] couldn't re-send the voice status", err);
    if (!quiet) showToast("Couldn't re-send. Try muting and unmuting once instead");
  }
}

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */

function Controls() {
  useProxy(storage);
  const [, refresh] = React.useState(0);

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
            resend(true); // apply right away if you're in a call
          }}
        />
      }
    />
  );

  return (
    <>
      <FormSection title="Voice status">
        {toggle("fakeDeafen", "Fake deafen", "Others see you deafened and muted. You keep hearing")}
        {toggle("fakeMute", "Fake mute", "Others see you muted. Talking may or may not still work")}
        <FormRow
          label="Re-send my voice status"
          subLabel="Applies changes right away while you're in a call"
          trailing={<FormRow.Arrow />}
          onPress={() => resend()}
        />
      </FormSection>

      <FormSection title="Diagnostics">
        <FormRow label={`Gateway hook: ${diag.gateway}`} />
        <FormRow label={`WebSocket fallback: ${diag.socket}`} />
        <FormRow
          label={`Voice updates changed: ${diag.count}`}
          subLabel={diag.last || "None yet. Join a call, then mute and unmute once or tap Re-send"}
        />
        <FormRow
          label="Re-check hooks"
          trailing={<FormRow.Arrow />}
          onPress={() => {
            attachGateway();
            showToast("Checked");
          }}
        />
        <FormRow
          label={sectionRegistered ? "Also under Settings > Bunny > fakedeafen" : "The fakedeafen button couldn't be added"}
        />
      </FormSection>
    </>
  );
}

// Opened from Settings > Bunny > fakedeafen
const FakeDeafenPage: any = () => (
  <ScrollView>
    <Controls />
  </ScrollView>
);
FakeDeafenPage.default = FakeDeafenPage; // works whether the settings system wants a component or a module

// Opened from the plugin's gear icon
function Settings() {
  return (
    <ScrollView>
      <Controls />
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

function registerButton() {
  try {
    // first icon name that exists on this client; the cog is the last resort
    const names = ["ic_headset_deafened", "ic_deafened", "ic_headset_24px", "ic_mic_24px", "ic_cog_24px"];
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
          key: "OKAY_FAKEDEAFEN",
          title: () => "fakedeafen",
          icon,
          render: () => Promise.resolve(FakeDeafenPage),
        },
      ],
    });
    sectionRegistered = true;
  } catch (err) {
    sectionRegistered = false;
    console.error("[OkayFakeDeafen] couldn't add the fakedeafen button", err);
  }
}

export const onLoad = () => {
  attachGateway();
  attachSocketFallback();

  // the socket can be recreated after a reconnect, so look again
  unpatches.push(
    before("dispatch", FluxDispatcher, (args: any[]) => {
      const type = args[0]?.type;
      if (type === "CONNECTION_OPEN" || type === "VOICE_CHANNEL_SELECT") {
        setTimeout(attachGateway, 1500);
      }
    })
  );

  registerButton();

  // if you left it on last time and you're already in a call, apply it now
  if (active()) setTimeout(() => resend(true), 3000);
};

export const onUnload = () => {
  const wasActive = active();

  for (const unpatch of unpatches) {
    try {
      unpatch();
    } catch (err) {
      // already removed
    }
  }
  unpatches = [];

  if (typeof unregisterSection === "function") unregisterSection();
  unregisterSection = undefined;
  sectionRegistered = false;

  // hooks are gone now, so this sends your real status back to Discord
  if (wasActive) resend(true);
};

export const settings = Settings;
