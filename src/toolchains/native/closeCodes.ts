/**
 * WebSocket close codes, as libuvcpp's C ABI reports them.
 *
 * The C ABI's `on_close` documents its codes as matching `enum uvcpp_c_ws_close_code`
 * (RFC 6455 §7.4's set), and two of those values are not codes a peer can send:
 * §7.1.5 reserves 1005 to mean "the Close frame carried no status" and 1006 to
 * mean "the connection closed abnormally, i.e. without a Close frame". A peer
 * that sends either one is violating the protocol, so a stack reporting one is
 * telling you about the *ending*, not quoting the far end.
 *
 * That distinction is the whole reason this module exists: it is the only way to
 * answer "was this a closing handshake or a connection that died" on a stack
 * that reports the ending and not the frame. This lives beside the code that
 * interprets the stack's reports rather than in `domain`, because it is an
 * interpretation of one stack's vocabulary — the Node client in
 * `application/websocketClient.ts` sees close frames directly and needs none of
 * this.
 */

/** RFC 6455 §7.1.5: the connection closed without a Close frame. */
const CLOSE_ABNORMAL = 1006;

/**
 * Whether a reported code means a Close frame arrived.
 *
 * Only 1006 says otherwise, and it says it definitively: it is defined as the
 * code for a close that had no frame. 1005 is the opposite case — a Close frame
 * that arrived without a status — so this is a rule about one value rather than
 * about codes that look odd, and 1005 must fall on the "a frame arrived" side
 * rather than be treated as a missing code.
 */
export const closeFrameReceived = (code: number): boolean => code !== CLOSE_ABNORMAL;
