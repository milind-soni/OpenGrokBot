package com.openmausbot.companion.core

import java.net.Inet6Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.net.SocketAddress
import java.net.SocketException
import java.net.URI
import java.util.Collections
import java.util.concurrent.atomic.AtomicReference
import javax.net.SocketFactory
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import okhttp3.Call
import okhttp3.Dns
import okhttp3.EventListener
import okhttp3.OkHttpClient
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class ConnectionTest {
    @Test
    fun parsesHostnamesAndPorts() {
        val implicit = Connection.parse("macbook.tailnet.ts.net")
        assertEquals("macbook.tailnet.ts.net", implicit?.host)
        assertEquals(8810, implicit?.port)
        val explicit = Connection.parse("http://192.168.1.42:9910/")
        assertEquals("192.168.1.42", explicit?.host)
        assertEquals(9910, explicit?.port)
    }

    @Test
    fun normalizesZonesOnlyForNonIpv6Hosts() {
        assertEquals("", Connection.urlHost(""))
        assertEquals("", Connection.urlHost("%"))
        assertEquals("192.168.1.3", Connection.urlHost("192.168.1.3%en0"))
        assertEquals("mac.local", Connection.urlHost("mac.local%en0"))
        assertEquals("[fe80::1%en0]", Connection.urlHost("fe80::1%en0"))
        assertEquals("[fe80::1%en0]", Connection.urlHost("[fe80::1%en0]"))
        assertEquals("192.168.1.3", Connection.urlHost("192.168.1.3"))
        assertEquals("mac.local", Connection.urlHost("mac.local"))
    }

    @Test
    fun parsersNormalizeNonIpv6ZoneSuffixes() {
        val connection = Connection.parse("192.168.1.3%en0:9910")
        assertEquals("192.168.1.3", connection?.host)
        assertEquals(9910, connection?.port)

        val invite = PairingInvite.parse(
            URI("openmausbot://pair?address=192.168.1.3%25en0%3A9910&code=004209"),
        )
        assertEquals("192.168.1.3", invite?.connection?.host)
        assertEquals(9910, invite?.connection?.port)
    }

    @Test
    fun parsesIpv6WithAndWithoutAnExplicitPort() {
        val bare = Connection.parse("2001:db8::1")
        assertEquals("[2001:db8::1]", bare?.host)
        assertEquals(8810, bare?.port)
        assertEquals("http://[2001:db8::1]:8810", bare?.baseUrl.toString())
        val explicit = Connection.parse("[2001:db8::1]:9910")
        assertEquals("[2001:db8::1]", explicit?.host)
        assertEquals(9910, explicit?.port)
        assertEquals("http://[2001:db8::1]:9910", explicit?.baseUrl.toString())
    }

    @Test
    fun retainsTheScopeZoneOnLinkLocalIpv6() {
        val connection = Connection.parse("[fe80::1%en0]:8810")
        assertEquals("[fe80::1%en0]", connection?.host)
        assertEquals("http://[fe80::1%25en0]:8810", connection?.baseUrl.toString())
    }

    @Test
    fun zonedIpv6UsesScopedAddressOnTheRealOkHttpConnectPath() = runBlocking {
        val networkInterface = assertNotNull(
            Collections.list(NetworkInterface.getNetworkInterfaces()).firstOrNull { candidate ->
                Collections.list(candidate.inetAddresses).any { it is Inet6Address }
            },
            "the JVM must expose an IPv6-capable interface",
        )
        var fallbackCalled = false
        val fallback = object : Dns {
            override fun lookup(hostname: String) = emptyList<InetAddress>().also {
                fallbackCalled = true
            }
        }
        val connection = assertNotNull(Connection.parse("[fe80::1%${networkInterface.name}]:8810"))
        val endpoint = assertNotNull(connection.httpEndpoint(fallback))
        assertEquals(SCOPED_IPV6_HTTP_HOST, endpoint.baseUrl.host)

        val route = RecordingRouteListener()
        val sockets = RecordingSocketFactory()
        val okHttp = OkHttpClient.Builder()
            .dns(fallback)
            .eventListener(route)
            .socketFactory(sockets)
            .build()
        assertFailsWith<APIError.Transport> {
            CompanionClient(connection, null, okHttp).health()
        }

        assertEquals(SCOPED_IPV6_HTTP_HOST, route.dnsHost.get())
        val resolved = assertNotNull(route.dnsAddresses.get()?.single() as? Inet6Address)
        assertEquals(networkInterface.index, resolved.scopeId)
        assertEquals(networkInterface.name, resolved.scopedInterface?.name)
        val connectTarget = assertNotNull(sockets.connectTarget.get())
        assertEquals(resolved, connectTarget.address)
        assertFalse(fallbackCalled, "the scoped literal must not fall through to ordinary DNS")
    }

    @Test
    fun olderSavedIpv6ConnectionIsNormalizedWhenUsed() {
        val saved = CompanionJson.decodeFromString<Connection>(
            """{"id":"saved","name":"Mac","host":"::1","port":8810}""",
        )
        assertEquals("http://[::1]:8810", saved.baseUrl.toString())
    }

    @Test
    fun rejectsAmbiguousOrUnsafeAddresses() {
        assertNull(Connection.parse("host:not-a-port"))
        assertNull(Connection.parse("[::1]:not-a-port"))
        assertNull(Connection.parse("[::1]:70000"))
        assertNull(Connection.parse("host/path"))
        assertNull(Connection.parse("host name"))
    }

    @Test
    fun parsesADesktopPairingInvite() {
        val token = "omb_pair_" + "a".repeat(43)
        val invite = PairingInvite.parse(
            URI("openmausbot://pair?address=macbook.tail1234.ts.net%3A8810&token=$token&code=004209&name=Milind%27s%20Mac"),
        )!!
        assertEquals("macbook.tail1234.ts.net", invite.connection.host)
        assertEquals(8810, invite.connection.port)
        assertEquals("Milind's Mac", invite.connection.name)
        assertEquals(token, invite.credential)
    }

    @Test
    fun literalPlusInPairingInviteNameIsPreserved() {
        val invite = PairingInvite.parse(
            URI("openmausbot://pair?address=mac.local&code=004209&name=Ada%27s+Mac"),
        )
        assertEquals("Ada's+Mac", invite?.connection?.name)
    }

    @Test
    fun parsesAnOlderCodeOnlyPairingInvite() {
        val invite = PairingInvite.parse(URI("openmausbot://pair?address=mac.local&code=004209"))
        assertEquals("004209", invite?.credential)
    }

    @Test
    fun carriesFallbackHostsFromTheInvite() {
        val invite = PairingInvite.parse(URI(
            "openmausbot://pair?address=macbook.tail1234.ts.net%3A8810&code=004209" +
                "&hosts=macbook.tail1234.ts.net,192.168.1.42,openmausbot-aa.local",
        ))!!
        assertEquals(
            listOf("macbook.tail1234.ts.net", "192.168.1.42", "openmausbot-aa.local"),
            invite.connection.hosts,
        )
    }

    @Test
    fun dropsUnusableFallbackHostsWithoutRefusingTheInvite() {
        val invite = PairingInvite.parse(URI(
            "openmausbot://pair?address=mac.local&code=004209&hosts=%20192.168.1.42%20,,bad%2Fslash,has%20space",
        ))!!
        assertEquals(listOf("192.168.1.42"), invite.connection.hosts)
        val empty = PairingInvite.parse(
            URI("openmausbot://pair?address=mac.local&code=004209&hosts=bad%2Fslash"),
        )
        assertNull(empty?.connection?.hosts)
    }

    @Test
    fun savedConnectionWithoutFallbacksStillDecodes() {
        val saved = CompanionJson.decodeFromString<Connection>(
            """{"id":"saved","name":"Mac","host":"mac.tail1234.ts.net","port":8810}""",
        )
        assertNull(saved.hosts)
        assertEquals(listOf("mac.tail1234.ts.net"), saved.orderedHosts)
    }

    @Test
    fun pairResponseWithAndWithoutHostsDecodes() {
        val older = CompanionJson.decodeFromString<PairResponse>(
            """{"token":"omb_x","device":{"id":"d","name":"p","createdAt":1,"lastSeenAt":1},"serverName":"Mac"}""",
        )
        assertNull(older.hosts)
        val newer = CompanionJson.decodeFromString<PairResponse>(
            """{"token":"omb_x","device":{"id":"d","name":"p","createdAt":1,"lastSeenAt":1},"serverName":"Mac","hosts":["a.ts.net","192.168.1.42"]}""",
        )
        assertEquals(listOf("a.ts.net", "192.168.1.42"), newer.hosts)
    }

    @Test
    fun rejectsUntrustedOrMalformedPairingInvites() {
        listOf(
            "https://example.com/pair?address=mac.local&code=123456",
            "openmausbot://pair?address=mac.local&code=12345",
            "openmausbot://pair?address=mac.local&token=weak",
            "openmausbot://pair?address=mac.local&token=weak&code=123456",
            "openmausbot://pair?address=host%2Fpath&code=123456",
            "openmausbot://pair?address=one.local&address=two.local&code=123456",
        ).forEach { assertNull(PairingInvite.parse(URI(it)), it) }
    }

    @Test
    fun acceptsOnlyAnHttpsCloudDesktopSession() {
        val valid = CompanionJson.decodeFromString<CloudDesktopSession>(
            """{"joinUrl":"https://desktop.example/session/fresh","state":"ready"}""",
        )
        assertEquals("https://desktop.example/session/fresh", valid.url.toString())
        listOf(
            "http://desktop.example/session",
            "javascript:alert(1)",
            "not a URL",
            "https:///missing-host",
        ).forEach { value ->
            assertFailsWith<SerializationException> {
                CompanionJson.decodeFromString<CloudDesktopSession>("""{"joinUrl":"$value"}""")
            }
        }
    }

    private class RecordingRouteListener : EventListener() {
        val dnsHost = AtomicReference<String>()
        val dnsAddresses = AtomicReference<List<InetAddress>>()

        override fun dnsStart(call: Call, domainName: String) {
            dnsHost.set(domainName)
        }

        override fun dnsEnd(call: Call, domainName: String, inetAddressList: List<InetAddress>) {
            dnsAddresses.set(inetAddressList)
        }
    }

    private class RecordingSocketFactory : SocketFactory() {
        val connectTarget = AtomicReference<InetSocketAddress>()

        override fun createSocket(): Socket = object : Socket() {
            override fun connect(endpoint: SocketAddress, timeout: Int) {
                connectTarget.set(endpoint as InetSocketAddress)
                throw SocketException("connect target recorded")
            }
        }

        override fun createSocket(host: String, port: Int): Socket = unsupported()
        override fun createSocket(host: String, port: Int, localHost: InetAddress, localPort: Int): Socket = unsupported()
        override fun createSocket(host: InetAddress, port: Int): Socket = unsupported()
        override fun createSocket(
            address: InetAddress,
            port: Int,
            localAddress: InetAddress,
            localPort: Int,
        ): Socket = unsupported()

        private fun unsupported(): Nothing = error("OkHttp must use createSocket() before connect")
    }
}
