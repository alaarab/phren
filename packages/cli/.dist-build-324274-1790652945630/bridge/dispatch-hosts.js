import { hookRequest } from "./client.js";
import { localNames } from "./computer-names.js";
import { peerRequest } from "./peers.js";
/** This computer's own names: its hostname, the hostname's first label and
 * its Bonjour name, plus "local". */
export function isLocalComputer(name, names = localNames()) {
    const wanted = name.trim().toLowerCase();
    if (!wanted)
        return false;
    if (wanted === "local" || wanted === "localhost")
        return true;
    const first = wanted.split(".")[0];
    return names.some(own => {
        const value = own.toLowerCase();
        return value === wanted || value.split(".")[0] === first;
    });
}
export function peerHost(peer, request = peerRequest) {
    return { name: peer.name, server: peer.server, local: false, request: (route, data, timeout) => request(peer, route, data, timeout) };
}
/** This computer. `server` is the Herdr server its Hook reports first. */
export function localHost(server = "default", names = localNames(), request = hookRequest) {
    const name = names.find(value => !value.includes(".")) ?? names[0] ?? "local";
    return { name, server, local: true, names, request: (route, data) => request(route, data) };
}
