// Composer attachments, the half that has no photo library.
//
// The phone picks a file; the sidecar writes it onto this computer; the
// message the bot receives is the same tagged path the desktop composer
// already sends (`src/lib/composer-attachments.ts`). Drivers never see
// bytes from the phone — they open a path that now exists on the host.
import Foundation

public enum Attachment {
    public struct File: Equatable, Sendable {
        public var path: String
        public var name: String
        public var size: Int

        public init(path: String, name: String, size: Int) {
            self.path = path
            self.name = name
            self.size = size
        }
    }

    /// Combine typed composer text with host paths for attached files.
    ///
    /// Empty text is allowed when there is at least one file — a photo with
    /// no caption is still a message. Empty everything stays empty so the
    /// caller can refuse to send.
    public static func draft(text: String, files: [File]) -> String {
        var parts: [String] = []
        let typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !typed.isEmpty { parts.append(typed) }
        for file in files {
            parts.append("<attached-file path=\"\(escapeAttribute(file.path))\" />")
        }
        return parts.joined(separator: "\n\n")
    }

    /// File paths are untrusted prompt content. Keep them inside the quoted
    /// attribute even when a filename contains XML characters or line breaks.
    public static func escapeAttribute(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\t", with: "&#9;")
            .replacingOccurrences(of: "\r", with: "&#13;")
            .replacingOccurrences(of: "\n", with: "&#10;")
    }
}
