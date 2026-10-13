import { findByProps } from "@vendetta/metro";
import { FluxDispatcher, React } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { Forms, General } from "@vendetta/ui/components";
import { showToast } from "@vendetta/ui/toasts";

const { ScrollView } = General;
const { FormSection, FormInput, FormRow, FormSwitch } = Forms;

/* ------------------------------------------------------------------ */
/* Settings + defaults                                                 */
/* ------------------------------------------------------------------ */

// Discord activity types. 4 (Custom Status) is a different feature, so it's left out.
const TYPES = [
  { id: 0, name: "Playing" },
  { id: 1, name: "Streaming" },
  { id: 2, name: "Listening" },
  { id: 3, name: "Watching" },
  { id: 5, name: "Competing" },
];

const DEFAULTS: Record<string, any> = {
  enabled: true,
  appName: "",
  appId: "",
  type: 0,
  streamUrl: "",
  details: "",
  state: "",
  largeImage: "",
  largeText: "",
  smallImage: "",
  smallText: "",
  timestamps: false,
  startMs: "",
  endMs: "",
  partySize: "",
  partyMax: "",
  button1Label: "",
  button1Url: "",
  button2Label: "",
  button2Url: "",
};

for (const key in DEFAULTS) {
  if (storage[key] === undefined) storage[key] = DEFAULTS[key];
}

const str = (key: string): string => String(storage[key] ?? "").trim();
const num = (key: string): number => {
  const n = Number(str(key));
  return Number.isFinite(n) ? n : 0;
};

/* ------------------------------------------------------------------ */
/* Image resolving                                                     */
/* ------------------------------------------------------------------ */

// Discord's own REST client (the same one the app uses, already authenticated)
const RestAPI = findByProps("getAPIBaseURL", "get");

let appAssetsCache = new Map<string, Record<string, string>>();

async function loadAppAssets(appId: string): Promise<Record<string, string>> {
  const cached = appAssetsCache.get(appId);
  if (cached) return cached;

  const res = await RestAPI.get({ url: `/oauth2/applications/${appId}/assets` });
  const map: Record<string, string> = {};
  for (const asset of res?.body ?? []) map[asset.name] = asset.id;

  appAssetsCache.set(appId, map);
  return map;
}

/**
 * Turns whatever the user typed into something Discord accepts as an image:
 *  - "mp:..." strings and numeric asset IDs are used as they are
 *  - Discord CDN attachment links become "mp:attachments/..."
 *  - any other http(s) link is proxied through Discord's external-assets endpoint
 *  - anything else is treated as an asset name uploaded on the application
 */
async function resolveAsset(appId: string, key: string): Promise<string | undefined> {
  if (!key) return undefined;
  if (key.startsWith("mp:") || /^\d+$/.test(key)) return key;

  const cdn = key.match(/^https?:\/\/(?:cdn|media)\.discordapp\.(?:com|net)\/(attachments\/.+)$/i);
  if (cdn) return `mp:${cdn[1]}`;

  if (!appId) throw new Error("Images need an Application ID");
  if (!RestAPI) throw new Error("Couldn't find Discord's REST module");

  if (/^https?:\/\//i.test(key)) {
    const res = await RestAPI.post({
      url: `/applications/${appId}/external-assets`,
      body: { urls: [key] },
    });
    const path = res?.body?.[0]?.external_asset_path;
    if (!path) throw new Error(`Couldn't proxy image: ${key}`);
    return `mp:${path}`;
  }

  const assets = await loadAppAssets(appId);
  if (!assets[key]) throw new Error(`No asset called "${key}" on that application`);
  return assets[key];
}

/* ------------------------------------------------------------------ */
/* Building + sending the activity                                     */
/* ------------------------------------------------------------------ */

let sessionStart = Date.now();

async function buildActivity(): Promise<{ activity: Record<string, any> | null; warnings: string[] }> {
  const warnings: string[] = [];
  const name = str("appName");
  if (!storage.enabled || !name) return { activity: null, warnings };

  const type = TYPES.some(t => t.id === Number(storage.type)) ? Number(storage.type) : 0;
  const appId = str("appId");

  const activity: Record<string, any> = {
    application_id: appId || "0",
    name,
    type,
  };

  // Streaming only gets the purple badge with a Twitch / YouTube URL
  if (type === 1) {
    const url = str("streamUrl");
    if (!url) {
      warnings.push("Streaming needs a Stream URL (Twitch or YouTube)");
    } else {
      activity.url = url;
      if (!/^https?:\/\/(?:www\.|m\.|gaming\.)?(?:twitch\.tv|youtube\.com|youtu\.be)\//i.test(url)) {
        warnings.push("Stream URL should be a twitch.tv or youtube.com link");
      }
    }
  }

  if (str("details")) activity.details = str("details");
  if (str("state")) activity.state = str("state");

  // Images
  const assets: Record<string, string> = {};
  for (const [field, textField, imgKey, txtKey] of [
    ["largeImage", "largeText", "large_image", "large_text"],
    ["smallImage", "smallText", "small_image", "small_text"],
  ]) {
    if (str(textField)) assets[txtKey] = str(textField);
    if (!str(field)) continue;
    try {
      const resolved = await resolveAsset(appId, str(field));
      if (resolved) assets[imgKey] = resolved;
    } catch (e: any) {
      warnings.push(e?.message ?? String(e));
    }
  }
  if (Object.keys(assets).length) activity.assets = assets;

  // Timestamps (ms since epoch). Blank start = when the plugin loaded.
  if (storage.timestamps) {
    const start = num("startMs") > 0 ? num("startMs") : sessionStart;
    const end = num("endMs");
    activity.timestamps = end > start ? { start, end } : { start };
  }

  // Party size, shown as (size of max)
  const size = Math.floor(num("partySize"));
  const max = Math.floor(num("partyMax"));
  if (size > 0 && max >= size) activity.party = { size: [size, max] };

  // Buttons: labels go in `buttons`, URLs in `metadata.button_urls` (same as Vencord)
  const buttons: [string, string][] = [];
  for (const n of [1, 2]) {
    const label = str(`button${n}Label`).slice(0, 32);
    const url = str(`button${n}Url`);
    if (!label && !url) continue;
    if (!label || !/^https?:\/\//i.test(url)) {
      warnings.push(`Button ${n} needs a label and an http(s) URL`);
      continue;
    }
    buttons.push([label, url]);
  }
  if (buttons.length) {
    activity.buttons = buttons.map(b => b[0]);
    activity.metadata = { button_urls: buttons.map(b => b[1]) };
  }

  return { activity, warnings };
}

function dispatchActivity(activity: Record<string, any> | null) {
  FluxDispatcher.dispatch({
    type: "LOCAL_ACTIVITY_UPDATE",
    activity,
    socketId: "CustomRPC",
  });
}

let active = false;
let applyTicket = 0;

async function apply(manual = false) {
  const ticket = ++applyTicket;
  try {
    appAssetsCache = new Map(); // pick up newly uploaded assets
    const { activity, warnings } = await buildActivity();

    // plugin was unloaded, or a newer update started while images were resolving
    if (!active || ticket !== applyTicket) return;

    dispatchActivity(activity);

    if (manual || warnings.length) {
      const base = activity ? "Presence updated" : storage.enabled ? "Nothing to show: add a name" : "Presence is off";
      showToast(warnings.length ? `${base}. ${warnings.join(". ")}` : base);
    }
  } catch (e: any) {
    console.error("[CustomRPC]", e);
    showToast(`CustomRPC error: ${e?.message ?? e}`);
  }
}

/* ------------------------------------------------------------------ */
/* Settings screen                                                     */
/* ------------------------------------------------------------------ */

function Settings() {
  useProxy(storage);

  const input = (key: string, title: string, placeholder?: string, numeric = false) => (
    <FormInput
      key={key}
      title={title}
      placeholder={placeholder}
      keyboardType={numeric ? "numeric" : "default"}
      value={String(storage[key] ?? "")}
      onChange={(v: string) => {
        storage[key] = v;
      }}
    />
  );

  const typeIndex = Math.max(0, TYPES.findIndex(t => t.id === Number(storage.type)));
  const isStreaming = TYPES[typeIndex].id === 1;

  const updateRow = (
    <FormRow
      label="Update presence"
      subLabel="Applies everything below"
      trailing={<FormRow.Arrow />}
      onPress={() => apply(true)}
    />
  );

  return (
    <ScrollView keyboardShouldPersistTaps="handled">
      <FormSection title="Presence">
        <FormRow
          label="Show presence"
          trailing={
            <FormSwitch
              value={!!storage.enabled}
              onValueChange={(v: boolean) => {
                storage.enabled = v;
                apply(true);
              }}
            />
          }
        />
        {updateRow}
      </FormSection>

      <FormSection title="Basic">
        {input("appName", "Name", "Shown as the activity name")}
        <FormRow
          label="Activity type"
          subLabel={`${TYPES[typeIndex].name} (tap to change)`}
          trailing={<FormRow.Arrow />}
          onPress={() => {
            storage.type = TYPES[(typeIndex + 1) % TYPES.length].id;
          }}
        />
        {isStreaming && input("streamUrl", "Stream URL", "https://twitch.tv/yourname")}
        {input("details", "Details")}
        {input("state", "State")}
        {input("appId", "Application ID", "Needed for images")}
      </FormSection>

      <FormSection title="Images">
        {input("largeImage", "Large image", "asset name or image URL")}
        {input("largeText", "Large image text")}
        {input("smallImage", "Small image", "asset name or image URL")}
        {input("smallText", "Small image text")}
      </FormSection>

      <FormSection title="Timestamps">
        <FormRow
          label="Enable timestamps"
          trailing={
            <FormSwitch
              value={!!storage.timestamps}
              onValueChange={(v: boolean) => {
                storage.timestamps = v;
              }}
            />
          }
        />
        {input("startMs", "Start (ms)", "blank = when plugin loaded", true)}
        {input("endMs", "End (ms)", "optional, shows a countdown", true)}
        <FormRow
          label="Use current time"
          subLabel="Set now as the start timestamp"
          trailing={<FormRow.Arrow />}
          onPress={() => {
            storage.startMs = String(Date.now());
          }}
        />
      </FormSection>

      <FormSection title="Party">
        {input("partySize", "Current size", "e.g. 2", true)}
        {input("partyMax", "Max size", "e.g. 5", true)}
      </FormSection>

      <FormSection title="Buttons (other people see these, you don't)">
        {input("button1Label", "Button 1 label")}
        {input("button1Url", "Button 1 URL", "https://example.com")}
        {input("button2Label", "Button 2 label")}
        {input("button2Url", "Button 2 URL", "https://example.com")}
      </FormSection>

      <FormSection>{updateRow}</FormSection>
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

let reapplyTimer: any;

// The plugin loads before Discord finishes connecting, and reconnects can wipe
// local activities, so re-send the presence every time the connection opens.
const onConnectionOpen = () => {
  clearTimeout(reapplyTimer);
  reapplyTimer = setTimeout(() => apply(), 3000);
};

export const onLoad = () => {
  active = true;
  sessionStart = Date.now();
  try {
    FluxDispatcher.subscribe("CONNECTION_OPEN", onConnectionOpen);
  } catch (e) {
    console.error("[CustomRPC] couldn't subscribe to CONNECTION_OPEN", e);
  }
  apply();
};

export const onUnload = () => {
  active = false;
  applyTicket++;
  clearTimeout(reapplyTimer);
  try {
    FluxDispatcher.unsubscribe("CONNECTION_OPEN", onConnectionOpen);
  } catch (e) {
    // already unsubscribed, nothing to do
  }
  dispatchActivity(null);
};

export const settings = Settings;
