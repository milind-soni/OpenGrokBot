// The harness's wire types, in Swift.
//
// These mirror `server/store.ts` and the payloads in `server/index.ts`.
// There is no shared type system across the two languages, so the contract
// is pinned by fixtures instead: `Tests/CompanionCoreTests/Fixtures` holds
// real responses captured from a running server, and the decoding tests
// read them. When the server changes a payload, a test here fails.
//
// Everything the server may omit is optional, and nothing is decoded more
// strictly than it has to be — a phone that refuses to show a conversation
// because one message gained a field is worse than one that ignores it.
import Foundation

// MARK: - Messages

public struct OptionCard: Codable, Hashable, Sendable {
    public var title: String
    public var subtitle: String
    public var options: [String]
    public var answered: String?
    public var dismissed: Bool?
    /// Present when this card is a live provider ask — the thing that makes
    /// it answerable rather than historical.
    public var requestId: String?
    public var tool: String?
    /// Why auto mode stopped to ask anyway.
    public var held: String?
    /// The narrow grant "always allow" would remember, e.g. `Bash:git`.
    public var allowKey: String?

    /// A card is actionable while it is unanswered and still has a request
    /// behind it. Everything else is transcript.
    public var isPending: Bool {
        requestId != nil && answered == nil && dismissed != true
    }

    /// Permission cards carry a tool; questions do not.
    public var isPermission: Bool { tool != nil }
}

public struct ToolActivity: Codable, Hashable, Sendable {
    public var name: String
    public var ok: Bool?
    /// The same chip as a phrase a voice can read.
    public var spoken: String?
    /// Marks an error fixed by installing something, not by retrying.
    public var setup: Bool?
}

public struct Sender: Codable, Hashable, Sendable {
    public var botId: String
    public var name: String
    public var color: String
}

public struct Reaction: Codable, Hashable, Sendable {
    public var emoji: String
    public var by: String
}

public struct CommChip: Codable, Hashable, Sendable {
    public var groupId: String
    public var withBotId: String
    public var withName: String
    public var withColor: String
}

public struct Message: Codable, Hashable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case text, options, activity, screen
        /// A kind this build has never heard of.
        ///
        /// Not decorative. `kind` is not optional, so without this a single
        /// unrecognised message fails the decode of the whole response it
        /// arrived in — the thread does not render one message oddly, it
        /// does not render. The harness gains message kinds on its own
        /// schedule and the phone is updated on the App Store's, so "newer
        /// computer than phone" is the normal state of things, not an edge
        /// case. Degrading to the text a message carries is worth more than
        /// being right about its shape.
        case unknown

        public init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Kind(rawValue: raw) ?? .unknown
        }
    }

    public enum Role: String, Codable, Sendable {
        case bot, user

        /// Same reasoning, and `bot` rather than a third case: an unplaceable
        /// message drawn as yours would be the phone claiming you said
        /// something you did not.
        public init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Role(rawValue: raw) ?? .bot
        }
    }

    public var id: String
    public var role: Role
    public var kind: Kind
    public var at: Double
    public var text: String?
    public var card: OptionCard?
    public var tool: ToolActivity?
    /// The message this one follows; nil at the thread root. Two messages
    /// sharing a parent are a fork.
    public var parentId: String?
    /// Rooms: which member said this.
    public var from: Sender?
    public var reactions: [Reaction]?
    public var comm: CommChip?
    /// Screen messages in the paged shape: the pixels live behind
    /// `/api/threads/:threadId/messages/:id/image` rather than inline.
    public var hasImage: Bool?
    /// Screen messages in the full shape: base64 pixels, inline.
    public var png: String?
    public var mime: String?

    public var date: Date { Date(timeIntervalSince1970: at / 1000) }
}

// MARK: - Bots and rooms

public struct ModelSelection: Codable, Hashable, Sendable {
    public var instanceId: String
    public var model: String
}

public struct BotTask: Codable, Hashable, Sendable {
    public var threadId: String
    public var title: String
    public var createdAt: Double
}

public struct Bot: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var threadId: String
    public var name: String
    public var title: String
    public var description: String
    public var notifications: Bool
    public var color: String
    public var unread: Bool
    public var modelSelection: ModelSelection
    public var createdAt: Double
    public var busy: Bool?
    public var pinned: Bool?
    public var hidden: Bool?
    public var chiefOfStaff: Bool?
    public var autoApprove: Bool?
    public var alwaysAllow: [String]?
    public var computer: String?
    public var speakReplies: Bool?
    public var voice: String?
    public var mascotExpression: String?
    public var tasks: [BotTask]?
    public var messages: [Message]?
    public var activeLeafId: String?
    /// Paged responses only: there is more transcript above what you got.
    public var hasMore: Bool?
}

public struct GroupResponder: Codable, Hashable, Sendable {
    public var kind: String
    public var botId: String?
}

public struct Room: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var threadId: String
    public var name: String
    public var memberIds: [String]
    public var defaultResponder: GroupResponder
    public var bulletin: String
    public var unread: Bool
    public var createdAt: Double
    public var dm: Bool?
    public var busyBotId: String?
    public var messages: [Message]?
    public var hasMore: Bool?
}

// MARK: - Responses

private struct Lossy<Element: Decodable>: Decodable {
    let value: Element?

    init(from decoder: Decoder) throws {
        value = try? Element(from: decoder)
    }
}

public struct Fleet: Decodable, Sendable {
    public var bots: [Bot]
    public var groups: [Room]

    private enum CodingKeys: String, CodingKey { case bots, groups }

    public init(bots: [Bot], groups: [Room]) {
        self.bots = bots
        self.groups = groups
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        bots = try container.decodeIfPresent([Lossy<Bot>].self, forKey: .bots)?.compactMap(\.value) ?? []
        groups = try container.decodeIfPresent([Lossy<Room>].self, forKey: .groups)?.compactMap(\.value) ?? []
    }
}

public struct ThreadPage: Codable, Sendable {
    public var messages: [Message]
    public var hasMore: Bool?
}

public struct SearchHit: Codable, Hashable, Identifiable, Sendable {
    public var threadId: String
    public var messageId: String
    public var at: Double
    public var role: Message.Role
    public var kind: Message.Kind
    public var snippet: String
    public var matchStart: Int
    public var matchLength: Int
    public var botId: String?
    public var groupId: String?
    public var name: String
    public var task: String?
    public var onActivePath: Bool

    public var id: String { "\(threadId):\(messageId)" }
}

public struct TranscriptExport: Sendable {
    public var data: Data
    public var filename: String
    public var contentType: String

    public init(data: Data, filename: String, contentType: String) {
        self.data = data
        self.filename = filename
        self.contentType = contentType
    }
}

public struct PairedDevice: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var createdAt: Double
    public var lastSeenAt: Double
}

public struct PairResponse: Codable, Sendable {
    public var token: String
    public var device: PairedDevice
    /// What the computer calls itself — worth showing so someone with two
    /// paired machines can tell them apart.
    public var serverName: String
}

public struct ProviderSnapshot: Codable, Hashable, Sendable {
    public var state: String
    public var reason: String?
    public var authenticated: Bool?
    public var version: String?

    public var isAvailable: Bool { state == "available" }
}

public struct ModelOption: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var label: String
}

public struct ModelCatalog: Codable, Hashable, Sendable {
    public var `default`: String
    public var options: [ModelOption]
}

public struct Instance: Codable, Hashable, Identifiable, Sendable {
    public var instanceId: String
    public var driverKind: String
    public var displayName: String?
    public var snapshot: ProviderSnapshot
    public var models: ModelCatalog

    public var id: String { instanceId }
}

public struct InstanceList: Codable, Sendable {
    public var instances: [Instance]
}

public struct ConfigFlag: Codable, Hashable, Sendable {
    public var configured: Bool
    public var apiKeyConfigured: Bool?
    public var ready: Bool?
    public var voice: String?
}

public struct Profile: Codable, Hashable, Sendable {
    public var name: String
    public var email: String
}

public struct ConfigStatus: Codable, Sendable {
    public var composio: ConfigFlag?
    public var box: ConfigFlag?
    public var tts: ConfigFlag?
    public var profile: Profile?
}

/// The harness's error body. Every non-2xx response carries one.
public struct APIErrorBody: Codable, Sendable {
    public var error: String
}

/// One frame of a bot's computer, as it arrives on the stream.
public struct ScreenFrame: Hashable, Sendable {
    public var png: String
    public var mime: String

    public init(png: String, mime: String) {
        self.png = png
        self.mime = mime
    }

    /// Decoded pixels, or nil if the base64 was not what it claimed to be.
    /// Returning nil rather than throwing keeps the caller a view.
    public var data: Data? { Data(base64Encoded: png) }
}

/// `POST /api/bots` — the harness answers with the bot it made.
public struct CreatedBot: Codable, Sendable {
    public var bot: Bot
}

struct SearchResponse: Codable, Sendable {
    var hits: [SearchHit]
}

struct MessageResponse: Codable, Sendable {
    var message: Message
}

struct ActiveBranchResponse: Codable, Sendable {
    var activeLeafId: String
}

struct BotResponse: Codable, Sendable {
    var bot: Bot
}
