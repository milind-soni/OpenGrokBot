// Composer attachments: how typed text and host file paths share a prompt.
//
// The picker and the sidecar write live in App/ and companion/. The join
// is the part with a decision in it — the same tagged path the desktop
// composer already sends — and getting the escaping wrong is a path that
// can break out of the attribute.
import XCTest
@testable import CompanionCore

final class AttachmentTests: XCTestCase {
    func testAPhotoWithNoCaptionIsStillAMessage() {
        let file = Attachment.File(path: "/tmp/photo.jpg", name: "photo.jpg", size: 12)
        XCTAssertEqual(
            Attachment.draft(text: "", files: [file]),
            "<attached-file path=\"/tmp/photo.jpg\" />"
        )
    }

    func testTypedTextComesFirst() {
        let file = Attachment.File(path: "/tmp/a.txt", name: "a.txt", size: 1)
        XCTAssertEqual(
            Attachment.draft(text: "please look", files: [file]),
            "please look\n\n<attached-file path=\"/tmp/a.txt\" />"
        )
    }

    func testEmptyEverythingStaysEmpty() {
        XCTAssertEqual(Attachment.draft(text: "  ", files: []), "")
    }

    func testSeveralFilesKeepTheirOrder() {
        let files = [
            Attachment.File(path: "/tmp/a.jpg", name: "a.jpg", size: 1),
            Attachment.File(path: "/tmp/b.pdf", name: "b.pdf", size: 2),
        ]
        XCTAssertEqual(
            Attachment.draft(text: "here", files: files),
            "here\n\n<attached-file path=\"/tmp/a.jpg\" />\n\n<attached-file path=\"/tmp/b.pdf\" />"
        )
    }

    func testAPathWithQuotesCannotLeaveTheAttribute() {
        XCTAssertEqual(
            Attachment.escapeAttribute("/tmp/a\"&<>\t\n.txt"),
            "/tmp/a&quot;&amp;&lt;&gt;&#9;&#10;.txt"
        )
    }
}
