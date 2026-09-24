import Foundation

/// Claude's spinner line as the Hook reads it from the pane: the verb, the
/// turn's elapsed seconds, the token count and its direction, and whether it
/// is thinking. Anything malformed drops the whole value.
public struct AgentChatSpinner: Equatable, Sendable {
    public enum Direction: String, Sendable { case up, down }
    public let verb: String
    public let elapsed: Int?
    public let tokens: Int?
    public let direction: Direction?
    public let thinking: Bool
    /// "thought for 4s": how long the finished thinking took.
    public let thoughtFor: Int?

    public init(verb: String, elapsed: Int? = nil, tokens: Int? = nil, direction: Direction? = nil,
                thinking: Bool = false, thoughtFor: Int? = nil) {
        self.verb = verb; self.elapsed = elapsed; self.tokens = tokens; self.direction = direction
        self.thinking = thinking; self.thoughtFor = thoughtFor
    }

    /// The frame's `activity` object. Optional fields may be absent; a field
    /// that is present must be well formed.
    public init?(_ value: Any?) {
        guard let value = value as? [String: Any], let verb = Self.verb(value["verb"]) else { return nil }
        guard let elapsed = Self.count(value["elapsed"], limit: 1_000_000),
              let thoughtFor = Self.count(value["thoughtFor"], limit: 1_000_000) else { return nil }
        var tokens: Int?, direction: Direction?
        if let raw = value["tokens"] {
            guard let object = raw as? [String: Any], let parsed = Self.count(object["count"], limit: 1_000_000_000), let parsed,
                  let way = (object["direction"] as? String).flatMap(Direction.init(rawValue:)) else { return nil }
            tokens = parsed; direction = way
        }
        var thinking = false
        if let raw = value["thinking"] {
            guard let flag = raw as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID() else { return nil }
            thinking = flag.boolValue
        }
        self.init(verb: verb, elapsed: elapsed, tokens: tokens, direction: direction, thinking: thinking, thoughtFor: thoughtFor)
    }

    /// Absent is `.some(nil)`; malformed is `nil`.
    private static func count(_ raw: Any?, limit: Int) -> Int?? {
        guard let raw else { return .some(nil) }
        guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              let int = Int(exactly: number.doubleValue), (0...limit).contains(int) else { return nil }
        return .some(int)
    }

    /// One capitalized word, as a spinner shows it.
    public static func verb(_ value: Any?) -> String? {
        guard let verb = value as? String,
              verb.range(of: #"^[A-Z][\p{L}'-]{1,30}$"#, options: .regularExpression) != nil else { return nil }
        return verb
    }

    /// "↓ 3.1k tokens", as Claude writes it.
    public var tokenText: String? {
        guard let tokens else { return nil }
        let arrow = direction == .up ? "↑" : "↓"
        let amount = tokens < 1_000 ? "\(tokens)" : String(format: "%.1fk", Double(tokens) / 1_000)
        return "\(arrow) \(amount) tokens"
    }

    /// What follows the time inside the parenthesis: tokens, then thinking.
    public var details: [String] {
        var parts: [String] = []
        if let tokenText { parts.append(tokenText) }
        if thinking { parts.append("thinking") } else if let thoughtFor { parts.append("thought for \(thoughtFor)s") }
        return parts
    }

    /// The finished line's verb: Claude's own word in the past tense
    /// ("Brewed for"), or nil when this is not a form we know.
    public static func pastTense(_ verb: String) -> String? { pastTenses[verb] }

    private static let pastTenses: [String: String] = [
        "Accomplishing": "Accomplished", "Actioning": "Actioned", "Actualizing": "Actualized", "Baking": "Baked",
        "Booping": "Booped", "Brewing": "Brewed", "Calculating": "Calculated", "Cerebrating": "Cerebrated",
        "Channelling": "Channelled", "Churning": "Churned", "Clauding": "Clauded", "Coalescing": "Coalesced",
        "Cogitating": "Cogitated", "Combobulating": "Combobulated", "Computing": "Computed", "Concocting": "Concocted",
        "Conjuring": "Conjured", "Considering": "Considered", "Contemplating": "Contemplated", "Cooking": "Cooked",
        "Crafting": "Crafted", "Creating": "Created", "Crunching": "Crunched", "Deciphering": "Deciphered",
        "Deliberating": "Deliberated", "Determining": "Determined", "Discombobulating": "Discombobulated",
        "Divining": "Divined", "Doing": "Did", "Effecting": "Effected", "Elucidating": "Elucidated",
        "Enchanting": "Enchanted", "Envisioning": "Envisioned", "Finagling": "Finagled", "Flibbertigibbeting": "Flibbertigibbeted",
        "Forging": "Forged", "Forming": "Formed", "Frolicking": "Frolicked", "Generating": "Generated",
        "Germinating": "Germinated", "Hatching": "Hatched", "Herding": "Herded", "Honking": "Honked",
        "Hustling": "Hustled", "Ideating": "Ideated", "Imagining": "Imagined", "Incubating": "Incubated",
        "Inferring": "Inferred", "Jiving": "Jived", "Manifesting": "Manifested", "Marinating": "Marinated",
        "Meandering": "Meandered", "Moseying": "Moseyed", "Mulling": "Mulled", "Mustering": "Mustered",
        "Musing": "Mused", "Noodling": "Noodled", "Percolating": "Percolated", "Perusing": "Perused",
        "Philosophising": "Philosophised", "Pondering": "Pondered", "Pontificating": "Pontificated",
        "Precipitating": "Precipitated", "Processing": "Processed", "Puttering": "Puttered", "Puzzling": "Puzzled",
        "Reticulating": "Reticulated", "Ruminating": "Ruminated", "Sautéing": "Sautéed", "Schlepping": "Schlepped",
        "Shimmying": "Shimmied", "Shucking": "Shucked", "Simmering": "Simmered", "Smooshing": "Smooshed",
        "Spelunking": "Spelunked", "Spinning": "Spun", "Stewing": "Stewed", "Sussing": "Sussed",
        "Synthesizing": "Synthesized", "Thinking": "Thought", "Tinkering": "Tinkered", "Transmuting": "Transmuted",
        "Unfurling": "Unfurled", "Unravelling": "Unravelled", "Vibing": "Vibed", "Wandering": "Wandered",
        "Whirlpooling": "Whirlpooled", "Whirring": "Whirred", "Wibbling": "Wibbled", "Wizarding": "Wizarded",
        "Working": "Worked", "Wrangling": "Wrangled",
    ]
}
