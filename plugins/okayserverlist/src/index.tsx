import { findByProps, findByStoreName } from "@vendetta/metro";
import { React, ReactNative } from "@vendetta/metro/common";
import { Forms, General } from "@vendetta/ui/components";
import { showToast } from "@vendetta/ui/toasts";

const { ScrollView } = General;
const { FormSection, FormRow, FormInput } = Forms;
const { View, Pressable, Text } = ReactNative;

const PAGE_SIZE = 50;
const LEAVE_DELAY_MS = 1000;
type Guild = { id: string; name: string };

let GuildStore: any;
let leaveAction: any;

function getGuilds(): Guild[] {
  try {
    const guilds = GuildStore?.getGuilds?.() ?? {};
    return Object.values(guilds)
      .map((guild: any) => ({ id: String(guild.id), name: String(guild.name ?? "Unnamed server") }))
      .filter(guild => guild.id && guild.id !== "undefined")
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    console.error("[OkayServerList] Could not read servers", error);
    return [];
  }
}

function SelectionBox({ checked }: { checked: boolean }) {
  return (
    <View style={{ width: 24, height: 24, borderWidth: 2, borderRadius: 5, borderColor: checked ? "#5865F2" : "#888", backgroundColor: checked ? "#5865F2" : "transparent", alignItems: "center", justifyContent: "center" }}>
      {checked ? <Text style={{ color: "white", fontWeight: "bold" }}>✓</Text> : null}
    </View>
  );
}

function ServerList() {
  const [, refresh] = React.useState(0);
  const [query, setQuery] = React.useState("");
  const [shown, setShown] = React.useState(PAGE_SIZE);
  const [selected, setSelected] = React.useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const guilds = getGuilds();
  const q = query.trim().toLowerCase();
  const filtered = guilds.filter(g => !q || g.name.toLowerCase().includes(q));
  const selectedIds = Object.keys(selected).filter(id => selected[id] && guilds.some(g => g.id === id));

  const toggle = (id: string) => {
    setConfirm(false);
    setSelected(current => ({ ...current, [id]: !current[id] }));
  };

  const toggleAllVisible = () => {
    const visibleIds = filtered.slice(0, shown).map(g => g.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every(id => selected[id]);
    setConfirm(false);
    setSelected(current => {
      const next = { ...current };
      for (const id of visibleIds) {
        if (allSelected) delete next[id];
        else next[id] = true;
      }
      return next;
    });
  };

  const leaveSelected = async () => {
    if (busy) return;
    if (!selectedIds.length) {
      showToast("Select at least one server first");
      return;
    }
    if (!confirm) {
      setConfirm(true);
      return;
    }
    if (typeof leaveAction?.leaveGuild !== "function") {
      showToast("This Discord build does not expose its leave-server action");
      return;
    }

    setConfirm(false);
    setBusy(true);
    let succeeded = 0;
    let failed = 0;
    const leavingIds = [...selectedIds];

    // Deliberately leave sequentially rather than firing a burst of actions.
    for (const id of leavingIds) {
      try {
        await leaveAction.leaveGuild(id);
        succeeded++;
      } catch (error) {
        failed++;
        console.error(`[OkayServerList] Could not leave server ${id}`, error);
      }
      if (leavingIds.indexOf(id) !== leavingIds.length - 1) {
        await new Promise(resolve => setTimeout(resolve, LEAVE_DELAY_MS));
      }
    }

    setSelected({});
    setBusy(false);
    refresh(value => value + 1);
    showToast(failed ? `Left ${succeeded}; ${failed} failed` : `Left ${succeeded} server${succeeded === 1 ? "" : "s"}`);
  };

  return (
    <ScrollView keyboardShouldPersistTaps="handled">
      <FormSection title={`Servers (${guilds.length})`}>
        <FormInput
          title="Search servers"
          placeholder="Type a server name"
          value={query}
          onChange={(value: string) => {
            setQuery(value);
            setShown(PAGE_SIZE);
          }}
        />
        <FormRow
          label="Select / deselect visible"
          subLabel={`Affects the ${Math.min(filtered.length, shown)} servers currently shown`}
          trailing={<FormRow.Arrow />}
          onPress={toggleAllVisible}
        />
        {filtered.slice(0, shown).map(guild => (
          <Pressable key={guild.id} onPress={() => toggle(guild.id)}>
            <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: "#fff", fontSize: 16 }}>{guild.name}</Text>
                <Text style={{ color: "#aaa", fontSize: 12 }}>{selected[guild.id] ? "Selected" : "Tap to select"}</Text>
              </View>
              <SelectionBox checked={!!selected[guild.id]} />
            </View>
          </Pressable>
        ))}
        {!filtered.length && <FormRow label="No servers found" />}
        {filtered.length > shown && (
          <FormRow
            label="Show more"
            subLabel={`${filtered.length - shown} remaining`}
            trailing={<FormRow.Arrow />}
            onPress={() => setShown(count => count + PAGE_SIZE)}
          />
        )}
      </FormSection>
      <FormSection title="Leave servers">
        <FormRow
          label={busy ? "Leaving servers…" : confirm ? `Tap again to leave ${selectedIds.length} servers` : `Leave selected (${selectedIds.length})`}
          subLabel={confirm ? "This cannot be undone. Tap a server to cancel confirmation." : "You will be asked to confirm before any server is left."}
          trailing={<FormRow.Arrow />}
          onPress={leaveSelected}
        />
        <FormRow
          label="Clear selection"
          subLabel="Unselect every server"
          onPress={() => {
            setSelected({});
            setConfirm(false);
          }}
        />
      </FormSection>
    </ScrollView>
  );
}

export const onLoad = () => {
  GuildStore = findByStoreName("GuildStore") ?? findByProps("getGuilds", "getGuild");
  // Use Discord's own client action; do not make a direct authenticated API request.
  leaveAction = findByProps("leaveGuild");
};

export const onUnload = () => {
  GuildStore = undefined;
  leaveAction = undefined;
};

export const settings = ServerList;
