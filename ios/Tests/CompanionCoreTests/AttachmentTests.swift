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
        XCTAssertEqual(
            Attachment.unescapeAttribute("/tmp/a&quot;&amp;&lt;&gt;&#9;&#10;.txt"),
            "/tmp/a\"&<>\t\n.txt"
        )
    }

    func testDisplayHidesTheTagAndKeepsTheCaption() {
        let shown = Attachment.display(
            "Can create a listing\n\n<attached-file path=\"/Users/me/.openmausbot-companion/inbox/1-ab-photo.jpg\" />"
        )
        XCTAssertEqual(shown.caption, "Can create a listing")
        XCTAssertEqual(shown.files.map(\.name), ["1-ab-photo.jpg"])
        XCTAssertEqual(
            shown.files.first?.path,
            "/Users/me/.openmausbot-companion/inbox/1-ab-photo.jpg"
        )
        XCTAssertTrue(shown.files.first?.isImage == true)
        XCTAssertEqual(shown.files.first?.displayName, "photo.jpg")
    }

    func testAPhotoWithNoCaptionStillDisplaysAsAFile() {
        let shown = Attachment.display("<attached-file path=\"/tmp/photo.jpg\" />")
        XCTAssertEqual(shown.caption, "")
        XCTAssertEqual(shown.files.map(\.name), ["photo.jpg"])
    }

    func testAPlainMessageIsUnchanged() {
        let shown = Attachment.display("just text")
        XCTAssertEqual(shown.caption, "just text")
        XCTAssertEqual(shown.files, [])
    }

    func testDisplayRoundTripsADraft() {
        let files = [
            Attachment.File(path: "/tmp/a.jpg", name: "a.jpg", size: 1),
            Attachment.File(path: "/tmp/notes.txt", name: "notes.txt", size: 2),
        ]
        let shown = Attachment.display(Attachment.draft(text: "please look", files: files))
        XCTAssertEqual(shown.caption, "please look")
        XCTAssertEqual(shown.files.map(\.path), ["/tmp/a.jpg", "/tmp/notes.txt"])
        XCTAssertEqual(shown.files.map(\.name), ["a.jpg", "notes.txt"])
        XCTAssertEqual(shown.files.map(\.isImage), [true, false])
    }

    func testAPdfIsNotAnImage() {
        XCTAssertFalse(Attachment.File(path: "/tmp/a.pdf", name: "a.pdf", size: 1).isImage)
    }

    func testInboxDisplayNameDropsTheUniquenessPrefix() {
        XCTAssertEqual(
            Attachment.File(
                path: "/tmp/1787025214436-54414f70-photo.jpg",
                name: "1787025214436-54414f70-photo.jpg",
                size: 1
            ).displayName,
            "photo.jpg"
        )
        XCTAssertEqual(
            Attachment.File(path: "/tmp/notes.txt", name: "notes.txt", size: 1).displayName,
            "notes.txt"
        )
    }
}
