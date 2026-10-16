import { React, ReactNative as RN } from "@vendetta/metro/common";
import { findByProps } from "@vendetta/metro";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { getAssetIDByName } from "@vendetta/ui/assets";

/* ------------------------------------------------------------------ */
/* Gateway socket patching                                            */
/* ------------------------------------------------------------------ */

const socketModule = findByProps("getSocket", "isConnected");

// `os` is the field Discord's backend keys session type off.
// `browser` alone is cosmetic (badge icon). Both are patched here.
const SPOOF_PROPERTIES: Record<string, Record<string, string>> = {
    desktop: { browser: "Discord Client",   os: "Windows",       device: "" },
    web:     { browser: "Chrome",           os: "Windows",       device: "" },
    meta:    { browser: "Discord VR",       os: "Android",       device: "Quest" },
    console: { browser: "Discord Embedded", os: "PlayStation 5", device: "" },
};

const IDENTIFY = 2;

let activeIntervals: Array<ReturnType<typeof setInterval>> = [];
let patchedSocket: any = null;
let origSend: any = null;
let origHandleIdentify: any = null;
const patchedTransports = new WeakMap<object, any>();

function getPlatform() {
    return storage.platform || "off";
}

function applySpoof(data: any) {
    const currentPlatform = getPlatform();
    if (currentPlatform === "off" || !SPOOF_PROPERTIES[currentPlatform]) return;
    if (data && data.properties) {
        Object.assign(data.properties, SPOOF_PROPERTIES[currentPlatform]);
    }
}

function patchTransport(socket: any) {
    const ws = socket?.webSocket;
    if (!ws || typeof ws.send !== "function" || patchedTransports.has(ws)) return;

    const origWsSend = ws.send.bind(ws);
    patchedTransports.set(ws, origWsSend);

    ws.send = function (data: any) {
        try {
            if (typeof data === "string") {
                const parsed = JSON.parse(data);
                if (parsed?.op === IDENTIFY && parsed.d?.properties) {
                    applySpoof(parsed.d);
                    data = JSON.stringify(parsed);
                }
            }
        } catch {}
        return origWsSend(data);
    };
}

function unpatchTransport(socket: any) {
    const ws = socket?.webSocket;
    if (ws && patchedTransports.has(ws)) {
        ws.send = patchedTransports.get(ws);
        patchedTransports.delete(ws);
    }
}

function patchSocket(socket: any) {
    if (!socket) return;
    patchTransport(socket);
    if (socket.__psPatched) return;

    origSend = socket.send.bind(socket);
    socket.send = function (op: number, data: any, flag: any) {
        if (op === IDENTIFY && data) applySpoof(data);
        return origSend.call(this, op, data, flag);
    };

    socket.__psPatched = true;
    patchedSocket = socket;

    if (typeof socket.handleIdentify === "function") {
        origHandleIdentify = socket.handleIdentify.bind(socket);
        socket.handleIdentify = function (...args: any[]) {
            const result = origHandleIdentify.apply(this, args);
            patchTransport(socket);
            return result;
        };
    }
}

function startSocketWatcher() {
    let lastSocket: any = null;
    let attempts = 0;

    const id = setInterval(() => {
        attempts++;
        const liveSocket = socketModule?.getSocket();
        if (liveSocket) {
            if (liveSocket !== lastSocket || !liveSocket.__psPatched) {
                lastSocket = liveSocket;
                patchSocket(liveSocket);
                if (getPlatform() !== "off" && attempts <= 5) reconnectGateway();
            } else {
                patchTransport(liveSocket);
            }
        }
    }, 250);

    activeIntervals.push(id);
}

export function reconnectGateway() {
    const socket = socketModule?.getSocket();
    if (!socket) return;
    socket.sessionId = null;
    socket.seq = 0;
    if (socket.webSocket) socket.webSocket.close();
    else if (typeof socket.close === "function") socket.close();
}

function teardown() {
    activeIntervals.forEach(clearInterval);
    activeIntervals = [];

    if (patchedSocket) {
        unpatchTransport(patchedSocket);
        if (origSend) patchedSocket.send = origSend;
        if (origHandleIdentify) patchedSocket.handleIdentify = origHandleIdentify;
        delete patchedSocket.__psPatched;
    }

    patchedSocket = null;
    origSend = null;
    origHandleIdentify = null;
}

/* ------------------------------------------------------------------ */
/* Settings UI                                                        */
/* ------------------------------------------------------------------ */

const { ScrollView } = findByProps("ScrollView");
const { TableRadioGroup, TableRadioRow, Stack } = findByProps(
    "TableRadioGroup",
    "TableRadioRow",
    "Stack"
);

function renderIcon(name: string, tintColor?: string) {
    const assetId = getAssetIDByName(name);
    if (!assetId) return null;
    return (
        <RN.Image
            source={assetId}
            style={{ width: 24, height: 24, ...(tintColor ? { tintColor } : {}) }}
        />
    );
}

const PLATFORMS = [
    { label: "Off",         value: "off",     subLabel: "Default mobile status",                          icon: () => renderIcon("MobilePhoneIcon") },
    { label: "Desktop",     value: "desktop", subLabel: "Spoofs os=Windows in IDENTIFY (quest-relevant)",  icon: () => renderIcon("ic_monitor", "#ffffff") },
    { label: "Web / Browser", value: "web",   subLabel: "Spoofs os=Windows + Chrome badge",                icon: () => renderIcon("GlobeEarthIcon") },
    { label: "VR",          value: "meta",    subLabel: "Shows VR Icon (os=Android, device=Quest)",        icon: () => renderIcon("ic_vr_headset_24px") },
    { label: "PlayStation", value: "console", subLabel: "Shows PlayStation Icon",                          icon: () => renderIcon("ic_playstation_device_ps5_32px") },
];

function SettingsScreen() {
    useProxy(storage);
    const selected = storage.platform || "off";

    const handleSelect = (value: string) => {
        storage.platform = value;
        reconnectGateway();
    };

    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
            <Stack spacing={16}>
                <TableRadioGroup
                    title="select a platform to spoof"
                    value={selected}
                    onChange={(val: string) => handleSelect(val)}
                >
                    {PLATFORMS.map((opt) => (
                        <TableRadioRow
                            key={opt.value}
                            label={opt.label}
                            subLabel={opt.subLabel}
                            value={opt.value}
                            selected={selected === opt.value}
                            icon={opt.icon ? opt.icon() : undefined}
                            onPress={() => handleSelect(opt.value)}
                        />
                    ))}
                </TableRadioGroup>
            </Stack>
        </ScrollView>
    );
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                          */
/* ------------------------------------------------------------------ */

export default {
    onLoad: () => {
        if (!storage.platform) storage.platform = "off";
        startSocketWatcher();
    },
    onUnload: () => {
        teardown();
    },
    settings: SettingsScreen,
};