/// Removes Kitty graphics APCs before the terminal parser can access local
/// files or allocate images. Only a bounded escape prefix is held between
/// chunks; discarded payloads never accumulate in memory.
public struct TerminalGraphicsFilter: Sendable {
    private enum State: Equatable, Sendable { case ground, escape, apc, apc8, dropping, droppingEscape }
    private var state = State.ground
    private var utf8Remaining = 0
    private var prefix: [UInt8] = []
    public init() {}

    public mutating func filter(_ bytes: [UInt8]) -> [UInt8] {
        var output: [UInt8] = []
        output.reserveCapacity(bytes.count)
        func ground(_ byte: UInt8) {
            // A continuation byte in ordinary UTF-8 is not an 8-bit control.
            if utf8Remaining > 0, byte & 0xC0 == 0x80 {
                utf8Remaining -= 1; output.append(byte); state = .ground; return
            }
            utf8Remaining = (0xC2...0xDF).contains(byte) ? 1 : (0xE0...0xEF).contains(byte) ? 2 : (0xF0...0xF4).contains(byte) ? 3 : 0
            switch byte {
            case 0x1B: prefix = [byte]; state = .escape
            case 0x9F: prefix = [byte]; state = .apc8
            default: output.append(byte); state = .ground
            }
        }
        func hold(_ byte: UInt8) {
            // SwiftTerm ignores C0 controls before an APC's command byte.
            // Do not let them disguise G, or build an unbounded prefix.
            if prefix.count < 128 { prefix.append(byte) }
            else { prefix.removeAll(keepingCapacity: true); state = .dropping }
        }
        for byte in bytes {
            switch state {
            case .ground: ground(byte)
            case .escape:
                if byte == 0x5F { state = .apc; hold(byte) }
                else if byte < 0x20, ![0x18, 0x1A, 0x1B].contains(byte) { hold(byte) }
                else { output += prefix; prefix.removeAll(keepingCapacity: true); ground(byte) }
            case .apc, .apc8:
                if byte == 0x47 { prefix.removeAll(keepingCapacity: true); state = .dropping }
                else if byte < 0x20, ![0x07, 0x18, 0x1A, 0x1B].contains(byte) { hold(byte) }
                else {
                    output += prefix; prefix.removeAll(keepingCapacity: true)
                    ground(byte)
                }
            case .dropping:
                if byte == 0x9C { state = .ground }
                else if byte == 0x1B { state = .droppingEscape }
            case .droppingEscape:
                if byte == 0x5C || byte == 0x9C { state = .ground }
                else if byte != 0x1B { state = .dropping }
            }
        }
        return output
    }
}
