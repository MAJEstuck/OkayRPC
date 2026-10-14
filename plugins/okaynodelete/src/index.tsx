import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, React } from "@vendetta/metro/common";
import { instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { Forms, General } from "@vendetta/ui/components";
import { showToast } from "@vendetta/ui/toasts";

const { ScrollView } = General;
const { FormSection, FormRow, FormSwitch } = Forms;

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const DEFAULTS: Record<string, any> = {
  ignoreSelf: true, // your own deletions behave normally
  ignoreBots: false, // keep bot messages too
  mark: true, // add a "deleted" line to kept messages
};

for (const key in DEFAULTS) {
  if (storage[key] === undefined) storage[key] = DEFAULTS[key];
}

const MARKER = "🗑️ *deleted*";

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

type Kept = { id: string; channelId: string; guildId?: string };

// messages we refused to delete, so "Clear" can really delete them later
const kept = new Map<string, Kept>();

let MessageStore: any;
let UserStore: any;
let unpatch: (() => void) | undefined;

/* ------------------------------------------------------------------ */
/* Core logic                                                          */
/* ------------------------------------------------------------------ */

/**
 * The delete event only carries ids, so we look the message up in Discord's
 * own store. If it isn't there (channel never loaded, message too old) there
 * is nothing to keep and the delete goes through as normal.
 */
function shouldKeep(msg: any): boolean {
  if (!msg) return false;
  if (msg.flags & 64) return false; // ephemeral "only you can see this" messages

  const myId = UserStore?.getCurrentUser?.()?.id;
  if (storage.ignoreSelf && myId && msg.author?.id === myId) return false;
  if (storage.ignoreBots && msg.author?.bot) return false;

  return true;
}

/**
 * The message record is left completely untouched, so its attachments,
 * embeds, stickers and GIF previews stay exactly as they were. The only
 * change is an optional extra line of text saying it was deleted.
 */
function keepMessage(msg: any, channelId: string, guildId?: string) {
  kept.set(msg.id, { id: msg.id, channelId, guildId });
  if (!storage.mark) return;

  const content: string = msg.content ?? "";
  if (content.includes(MARKER)) return;

  try {
    FluxDispatcher.dispatch({
      type: "MESSAGE_UPDATE",
      message: {
        id: msg.id,
        channel_id: channelId,
        guild_id: guildId,
        content: content ? `${content}\n${MARKER}` : MARKER,
      },
    });
  } catch (e) {
    console.error("[OkayNoDelete] couldn't mark message", e);
  }
}

function patchDispatch() {
  return instead("dispatch", FluxDispatcher, (args: any[], orig: Function) => {
    const event = args[0];

    // Any failure in here falls through to the normal delete (fail open).
    try {
      if (event?.type === "MESSAGE_DELETE" && !event.__okayBypass) {
        const msg = MessageStore.getMessage(event.channelId, event.id);
        if (shouldKeep(msg)) {
          keepMessage(msg, event.channelId, event.guildId);
          return; // swallow the delete
        }
      } else if (event?.type === "MESSAGE_DELETE_BULK" && Array.isArray(event.ids)) {
        const passThrough: string[] = [];
        for (const id of event.ids) {
          const msg = MessageStore.getMessage(event.channelId, id);
          if (shouldKeep(msg)) keepMessage(msg, event.channelId, event.guildId);
          else passThrough.push(id);
        }

        if (passThrough.length === 0) return; // everything was kept
        if (passThrough.length !== event.ids.length) {
          return orig({ ...event, ids: passThrough }); // delete only the rest
        }
      }
    } catch (e) {
      console.error("[OkayNoDelete]", e);
    }

    return orig(...args);
  });
}

function clearKept(): number {
  const items = [...kept.values()];
  kept.clear();

  for (const m of items) {
    try {
      FluxDispatcher.dispatch({
        type: "MESSAGE_DELETE",
        id: m.id,
        channelId: m.channelId,
        guildId: m.guildId,
        __okayBypass: true, // lets this delete through our own patch
      });
    } catch (e) {
      console.error("[OkayNoDelete] couldn't remove message", e);
    }
  }
  return items.length;
}

/* ------------------------------------------------------------------ */
/* Settings screen                                                     */
/* ------------------------------------------------------------------ */

function Settings() {
  useProxy(storage);
  const [, forceRender] = React.useState(0);

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
    <ScrollView>
      <FormSection title="Behavior">
        {toggle("ignoreSelf", "Ignore my own deletions", "Messages you delete yourself disappear normally")}
        {toggle("ignoreBots", "Ignore bot messages", "Bots delete their own messages a lot")}
        {toggle("mark", "Mark deleted messages", "Adds a 🗑️ deleted line. Turn off if previews ever look wrong")}
      </FormSection>

      <FormSection title="Kept messages">
        <FormRow
          label="Clear kept messages"
          subLabel={`${kept.size} kept right now`}
          trailing={<FormRow.Arrow />}
          onPress={() => {
            const n = clearKept();
            forceRender(x => x + 1);
            showToast(n ? `Cleared ${n} message${n === 1 ? "" : "s"}` : "Nothing to clear");
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
  MessageStore = findByStoreName("MessageStore") ?? findByProps("getMessage", "getMessages");
  UserStore = findByStoreName("UserStore") ?? findByProps("getCurrentUser", "getUser");

  if (!MessageStore?.getMessage) {
    showToast("OkayNoDelete: couldn't find Discord's message store, so it's inactive");
    return;
  }

  unpatch = patchDispatch();
};

export const onUnload = () => {
  unpatch?.();
  unpatch = undefined;
  kept.clear();
};

export const settings = Settings;
                    
