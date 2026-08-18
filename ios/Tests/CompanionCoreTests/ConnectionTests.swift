import XCTest
@testable import CompanionCore

final class ConnectionTests: XCTestCase {
    func testParsesHostnamesAndPorts() {
        let implicit = Connection.parse("macbook.tailnet.ts.net")
        XCTAssertEqual(implicit?.host, "macbook.tailnet.ts.net")
        XCTAssertEqual(implicit?.port, 8810)

        let explicit = Connection.parse("http://192.168.1.42:9910/")
        XCTAssertEqual(explicit?.host, "192.168.1.42")
        XCTAssertEqual(explicit?.port, 9910)
    }

    func testParsesIPv6WithAndWithoutAnExplicitPort() {
        let bare = Connection.parse("2001:db8::1")
        XCTAssertEqual(bare?.host, "[2001:db8::1]")
        XCTAssertEqual(bare?.port, 8810)
        XCTAssertEqual(bare?.baseURL?.absoluteString, "http://[2001:db8::1]:8810")

        let explicit = Connection.parse("[2001:db8::1]:9910")
        XCTAssertEqual(explicit?.host, "[2001:db8::1]")
        XCTAssertEqual(explicit?.port, 9910)
        XCTAssertEqual(explicit?.baseURL?.absoluteString, "http://[2001:db8::1]:9910")
    }

    func testRetainsTheScopeZoneOnLinkLocalIPv6() {
        let connection = Connection.parse("[fe80::1%en0]:8810")
        XCTAssertEqual(connection?.host, "[fe80::1%en0]")
        XCTAssertEqual(connection?.baseURL?.absoluteString, "http://[fe80::1%25en0]:8810")
    }

    func testAnOlderSavedIPv6ConnectionIsNormalizedWhenUsed() throws {
        let data = Data(#"{"id":"saved","name":"Mac","host":"::1","port":8810}"#.utf8)
        let saved = try JSONDecoder().decode(Connection.self, from: data)
        XCTAssertEqual(saved.baseURL?.absoluteString, "http://[::1]:8810")
    }

    func testRejectsAmbiguousOrUnsafeAddresses() {
        XCTAssertNil(Connection.parse("host:not-a-port"))
        XCTAssertNil(Connection.parse("[::1]:not-a-port"))
        XCTAssertNil(Connection.parse("[::1]:70000"))
        XCTAssertNil(Connection.parse("host/path"))
        XCTAssertNil(Connection.parse("host name"))
    }

    func testParsesADesktopPairingInvite() throws {
        let token = "omb_pair_" + String(repeating: "a", count: 43)
        let url = try XCTUnwrap(URL(string: "openmausbot://pair?address=macbook.tail1234.ts.net%3A8810&token=\(token)&code=004209&name=Milind%27s%20Mac"))
        let invite = try XCTUnwrap(PairingInvite.parse(url))
        XCTAssertEqual(invite.connection.host, "macbook.tail1234.ts.net")
        XCTAssertEqual(invite.connection.port, 8810)
        XCTAssertEqual(invite.connection.name, "Milind's Mac")
        XCTAssertEqual(invite.credential, token)
    }

    func testParsesAnOlderCodeOnlyPairingInvite() throws {
        let url = try XCTUnwrap(URL(string: "openmausbot://pair?address=mac.local&code=004209"))
        XCTAssertEqual(PairingInvite.parse(url)?.credential, "004209")
    }

    func testRejectsAnUntrustedOrMalformedPairingInvite() throws {
        XCTAssertNil(PairingInvite.parse(try XCTUnwrap(URL(string: "https://example.com/pair?address=mac.local&code=123456"))))
        XCTAssertNil(PairingInvite.parse(try XCTUnwrap(URL(string: "openmausbot://pair?address=mac.local&code=12345"))))
        XCTAssertNil(PairingInvite.parse(try XCTUnwrap(URL(string: "openmausbot://pair?address=mac.local&token=weak"))))
        XCTAssertNil(PairingInvite.parse(try XCTUnwrap(URL(string: "openmausbot://pair?address=mac.local&token=weak&code=123456"))))
        XCTAssertNil(PairingInvite.parse(try XCTUnwrap(URL(string: "openmausbot://pair?address=host%2Fpath&code=123456"))))
        XCTAssertNil(PairingInvite.parse(try XCTUnwrap(URL(string: "openmausbot://pair?address=one.local&address=two.local&code=123456"))))
    }

    func testAcceptsOnlyAnHTTPSCloudDesktopSession() throws {
        let valid = Data(#"{"joinUrl":"https://desktop.example/session/fresh","state":"ready"}"#.utf8)
        let session = try JSONDecoder().decode(CloudDesktopSession.self, from: valid)
        XCTAssertEqual(session.url.absoluteString, "https://desktop.example/session/fresh")

        for value in [
            "http://desktop.example/session",
            "javascript:alert(1)",
            "not a URL"
        ] {
            let data = try JSONSerialization.data(withJSONObject: ["joinUrl": value])
            XCTAssertThrowsError(try JSONDecoder().decode(CloudDesktopSession.self, from: data))
        }
    }
}
