import { findByProps } from "@vendetta/metro";
import { FluxDispatcher, React } from "@vendetta/metro/common";
import { before } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { Forms, General } from "@vendetta/ui/components";
import { registerSection } from "@vendetta/ui/settings";
import { showToast } from "@vendetta/ui/toasts";

const { ScrollView } = General;
const { FormSection, FormRow, FormSwitch, FormInput } = Forms;

/* ------------------------------------------------------------------ */
/* How this works                                                      */
/* ------------------------------------------------------------------ */
// A scrobbler app (Pano Scrobbler) reads your music player's notification and
// tells Last.fm what's playing. This plugin asks Last.fm every few seconds
// "what is this user playing right now?" and turns the answer into a
// "Listening to ..." status. It only READS public Last.fm data with an API key.
// No Last.fm password and no Discord token are ever involved.

/* ------------------------------------------------------------------ */
/* Settings + state                                                    */
/* ------------------------------------------------------------------ */

// Settings > Bunny is where the nowplaying button goes. If another plugin's
// button there disappears, change this to something unique like "OkayNowPlaying".
const SECTION_NAME = "Bunny";

const DEFAULT_POLL = 20; // seconds between checks
const MIN_POLL = 10;
const MAX_POLL = 120;
const MAX_FAILURES = 5; // clear the status after this many failed checks in a row
const PLACEHOLDER_ART = "2a96cbd8b46e442fc41c2b86b821562f"; // Last.fm's "no artwork" image
// Used for album art when the Application ID field is blank, so art works out of the box.
// Swap in your own application's ID here if you ever make a new one.
const DEFAULT_APP_ID = "1559674148492681228";
const MAX_ART_TRIES = 3; // attempts to find and upload the cover for one song

const DEFAULTS: Record<string, any> = {
  enabled: true,
  username: "", // your Last.fm username
  apiKey: "", // free key from last.fm/api
  appId: "", // your Discord Application ID (needed for album art)
  activityName: "Lark Player", // shown as "Listening to <this>"
  pollSeconds: String(DEFAULT_POLL),
  showArt: true,
  showTime: true,
  showButton: false, // "View on Last.fm" button (only other people see it)
};

for (const key in DEFAULTS) {
  if (storage[key] === undefined) storage[key] = DEFAULTS[key];
}

const str = (key: string): string => String(storage[key] ?? "").trim();

const listeners = new Set<() => void>(); // screens to refresh
const ping = () => listeners.forEach(f => f());

let active = false;
let busy = false;
let timer: any;
let failures = 0;
let status = "Starting...";
let nowText = "";
let lastJson = ""; // the last activity we sent, so we don't resend identical ones
let trackKey = ""; // "artist||title" of the song we're showing
let trackStart = 0; // when we first noticed it
let trackDuration = 0; // ms, 0 if unknown
let currentArt: string | undefined; // Discord-proxied cover for the current song
let artTries = 0;
let artNote = ""; // where the cover came from, or why there isn't one

let RestAPI: any;
let unpatch: (() => void) | undefined;
let unregisterSection: any;
let sectionRegistered = false;

const artCache = new Map<string, string>();

/* ------------------------------------------------------------------ */
/* Last.fm                                                             */
/* ------------------------------------------------------------------ */

async function lastfm(method: string, params: Record<string, string>): Promise<any> {
  const query = { method, api_key: str("apiKey"), format: "json", ...params };
  const qs = Object.entries(query)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");

  const res = await fetch(`https://ws.audioscrobbler.com/2.0/?${qs}`);
  const data = await res.json();
  if (data?.error) throw new Error(data.message ?? `Last.fm error ${data.error}`);
  return data;
}

function pickArt(images: any[]): string | undefined {
  if (!Array.isArray(images)) return undefined;
  const urls = images.map((i: any) => String(i?.["#text"] ?? "")).filter(u => u && !u.includes(PLACEHOLDER_ART));
  return urls.length ? urls[urls.length - 1] : undefined; // the biggest size comes last
}

// Track length in ms from Last.fm, or 0 when it doesn't know
async function fetchDuration(artist: string, title: string): Promise<number> {
  try {
    const data = await lastfm("track.getInfo", { artist, track: title, autocorrect: "1" });
    const ms = Number(data?.track?.duration);
    return Number.isFinite(ms) && ms > 30000 && ms < 3600000 ? ms : 0;
  } catch (err) {
    return 0;
  }
}

// Fallback when Last.fm has no cover: ask iTunes. Only trusted if it's clearly the same song.
async function findItunesArt(artist: string, title: string): Promise<string | undefined> {
  const res = await fetch(
    `https://itunes.apple.com/search?media=music&entity=song&limit=3&term=${encodeURIComponent(`${artist} ${title}`)}`
  );
  const data = await res.json();

  const a = artist.toLowerCase();
  const t = title.toLowerCase();
  const match = (data?.results ?? []).find((r: any) => {
    const ra = String(r?.artistName ?? "").toLowerCase();
    const rt = String(r?.trackName ?? "").toLowerCase();
    return (ra.includes(a) || a.includes(ra)) && (rt.includes(t) || t.includes(rt));
  });

  const small: string | undefined = match?.artworkUrl100;
  return small ? small.replace("100x100bb", "600x600bb") : undefined; // same image, bigger
}

/* ------------------------------------------------------------------ */
/* Album art + sending the status                                      */
/* ------------------------------------------------------------------ */

// Discord only accepts images it has proxied, so ask it for the proxied version
async function resolveArt(appId: string, url: string): Promise<string | undefined> {
  const cached = artCache.get(url);
  if (cached) return cached;
  if (!RestAPI) throw new Error("couldn't reach Discord's image service");

  const res = await RestAPI.post({
    url: `/applications/${appId}/external-assets`,
    body: { urls: [url] },
  });
  const path = res?.body?.[0]?.external_asset_path;
  if (!path) return undefined;

  const asset = `mp:${path}`;
  artCache.set(url, asset);
  return asset;
}

function setActivity(activity: Record<string, any> | null) {
  const json = JSON.stringify(activity);
  if (json === lastJson) return;
  lastJson = json;
  FluxDispatcher.dispatch({
    type: "LOCAL_ACTIVITY_UPDATE",
    activity,
    socketId: "OkayNowPlaying",
  });
}

/* ------------------------------------------------------------------ */
/* Polling                                                             */
/* ------------------------------------------------------------------ */

function schedule() {
  clearTimeout(timer);
  if (!active) return;
  const secs = Math.min(MAX_POLL, Math.max(MIN_POLL, Number(storage.pollSeconds) || DEFAULT_POLL));
  timer = setTimeout(poll, secs * 1000);
}

function clearNow(message: string) {
  status = message;
  nowText = "";
  trackKey = "";
  setActivity(null);
}

async function poll() {
  if (!active || busy) return;
  busy = true;
  clearTimeout(timer);

  try {
    if (!storage.enabled) return clearNow("Turned off in settings");

    const user = str("username");
    if (!user || !str("apiKey")) return clearNow("Add your Last.fm username and API key");

    const data = await lastfm("user.getrecenttracks", { user, limit: "2" });
    failures = 0;

    const raw = data?.recenttracks?.track;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const track = list[0];
    if (!track || track["@attr"]?.nowplaying !== "true") return clearNow("Nothing playing right now");

    const artist: string = track.artist?.["#text"] ?? track.artist?.name ?? "Unknown artist";
    const title: string = track.name ?? "Unknown track";
    const album: string = track.album?.["#text"] ?? "";
    const key = `${artist}||${title}`;

    if (key !== trackKey) {
      trackKey = key;
      trackStart = Date.now();
      trackDuration = storage.showTime ? await fetchDuration(artist, title) : 0;
      currentArt = undefined;
      artTries = 0;
      artNote = "";
    }

    const appId = str("appId") || DEFAULT_APP_ID;

    // Album art is automatic: Last.fm's cover first, then an iTunes search.
    // Tried a few times per song, so one network hiccup doesn't lose the cover.
    if (storage.showArt && !currentArt && artTries < MAX_ART_TRIES) {
      artTries++;
      try {
        let source = "Last.fm";
        let artUrl = pickArt(track.image);
        if (!artUrl) {
          artUrl = await findItunesArt(artist, title);
          source = "iTunes";
        }

        if (!artUrl) {
          artNote = "no cover found for this song";
          artTries = MAX_ART_TRIES; // don't keep searching for it
        } else {
          currentArt = await resolveArt(appId, artUrl);
          artNote = currentArt ? `cover from ${source}` : "Discord refused the cover image";
        }
      } catch (err: any) {
        artNote = `cover problem: ${err?.message ?? err}`; // no cover is better than no status
      }
    }
    const art = storage.showArt ? currentArt : undefined;

    const activity: Record<string, any> = {
      application_id: appId || "0",
      name: str("activityName") || "Music",
      type: 2, // Listening
      details: title.slice(0, 128),
      state: `by ${artist}`.slice(0, 128),
    };
    if (storage.showTime) {
      activity.timestamps = trackDuration
        ? { start: trackStart, end: trackStart + trackDuration }
        : { start: trackStart };
    }
    if (art) activity.assets = { large_image: art, large_text: (album || title).slice(0, 128) };
    if (storage.showButton && track.url) {
      activity.buttons = ["View on Last.fm"];
      activity.metadata = { button_urls: [track.url] };
    }

    setActivity(activity);
    nowText = `${title} by ${artist}${storage.showArt ? ` (${artNote || "looking for the cover"})` : ""}`;
    status = "Playing";
  } catch (err: any) {
    failures++;
    status = `Couldn't reach Last.fm: ${err?.message ?? err}`;
    if (failures >= MAX_FAILURES) clearNow(status);
  } finally {
    busy = false;
    ping();
    schedule();
  }
}

function pollNow() {
  busy = false; // a manual check always goes through
  poll();
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

  const input = (key: string, title: string, placeholder?: string) => (
    <FormInput
      key={key}
      title={title}
      placeholder={placeholder}
      value={String(storage[key] ?? "")}
      onChange={(v: string) => {
        storage[key] = v;
      }}
    />
  );

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
            pollNow();
          }}
        />
      }
    />
  );

  return (
    <>
      <FormSection title="Now playing">
        <FormRow label={`Status: ${status}`} subLabel={nowText || "Play a song, then tap Check now"} />
        <FormRow
          label="Check now"
          subLabel="Asks Last.fm right away instead of waiting"
          trailing={<FormRow.Arrow />}
          onPress={() => {
            pollNow();
            showToast("Checking...");
          }}
        />
        {toggle("enabled", "Show on my profile", "Turn off to hide your music status")}
      </FormSection>

      <FormSection title="Last.fm (read only)">
        {input("username", "Last.fm username")}
        {input("apiKey", "Last.fm API key", "from last.fm/api/account/create")}
        <FormRow
          label="Your Last.fm profile must be public"
          subLabel="If 'hide recent listening' is on in your Last.fm privacy settings, this can't see your songs"
        />
      </FormSection>

      <FormSection title="Discord">
        {input("activityName", "Shown as 'Listening to'", "e.g. Lark Player")}
        {input("appId", "Application ID (optional)", "leave blank to use the built-in one")}
        {input("pollSeconds", "Check every (seconds)", "10 to 120, default 20")}
        {toggle("showArt", "Album art", "Automatic: Last.fm's cover, then an iTunes search")}
        {toggle("showTime", "Time and progress bar", "Starts when the plugin first notices the song, so it can be a few seconds late")}
        {toggle("showButton", "'View on Last.fm' button", "Other people see it, you don't")}
      </FormSection>

      <FormSection title="About">
        <FormRow
          label={sectionRegistered ? "Also under Settings > Bunny > nowplaying" : "The nowplaying button couldn't be added"}
          subLabel="If you also use OkayRPC, turn its status off or both will show"
        />
      </FormSection>
    </>
  );
}

// Opened from Settings > Bunny > nowplaying
const NowPlayingPage: any = () => (
  <ScrollView keyboardShouldPersistTaps="handled">
    <Controls />
  </ScrollView>
);
NowPlayingPage.default = NowPlayingPage; // works whether the settings system wants a component or a module

// Opened from the plugin's gear icon
function Settings() {
  return (
    <ScrollView keyboardShouldPersistTaps="handled">
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
    const names = ["ic_music", "ic_headset_24px", "ic_headset_deafened", "ic_cog_24px"];
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
          key: "OKAY_NOWPLAYING",
          title: () => "nowplaying",
          icon,
          render: () => Promise.resolve(NowPlayingPage),
        },
      ],
    });
    sectionRegistered = true;
  } catch (err) {
    sectionRegistered = false;
    console.error("[OkayNowPlaying] couldn't add the nowplaying button", err);
  }
}

export const onLoad = () => {
  active = true;
  busy = false;
  failures = 0;
  lastJson = "";
  RestAPI = findByProps("getAPIBaseURL", "get");

  // after a reconnect Discord can drop the status, so send it again
  unpatch = before("dispatch", FluxDispatcher, (args: any[]) => {
    if (args[0]?.type === "CONNECTION_OPEN") {
      setTimeout(() => {
        lastJson = "";
        pollNow();
      }, 3000);
    }
  });

  registerButton();
  poll();
};

export const onUnload = () => {
  active = false;
  clearTimeout(timer);
  timer = undefined;
  unpatch?.();
  unpatch = undefined;
  if (typeof unregisterSection === "function") unregisterSection();
  unregisterSection = undefined;
  sectionRegistered = false;

  // take the status down
  lastJson = "";
  try {
    FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity: null, socketId: "OkayNowPlaying" });
  } catch (err) {
    // nothing to clean up
  }
};

export const settings = Settings;
