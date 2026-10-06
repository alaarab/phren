/** Every name this computer answers to: machines.yaml often registers the
 * same Mac as its hostname, the hostname's first label and its Bonjour name.
 * The Hook reports them in /v1/health so a peer can recognize this computer. */
export declare function localNames(): string[];
