package com.openmausbot.companion.core

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.UUID
import kotlinx.serialization.Serializable

@Serializable
data class Connection(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val host: String,
    val port: Int,
    val hosts: List<String>? = null,
) {
    val baseUrl: URI?
        get() = runCatching {
            val normalized = urlHost(host).replace("%", "%25")
            URI("http://$normalized:$port")
        }.getOrNull()

    val orderedHosts: List<String>
        get() = buildList {
            val seen = mutableSetOf<String>()
            for (candidate in listOf(host) + hosts.orEmpty()) {
                val normalized = urlHost(candidate)
                if (seen.add(normalized)) add(normalized)
            }
        }

    fun dialing(candidate: String): Connection = copy(host = urlHost(candidate))

    fun promoting(winner: String): Connection {
        val normalized = urlHost(winner)
        val rest = orderedHosts.filterNot { it == normalized }
        return copy(host = normalized, hosts = listOf(normalized) + rest)
    }

    companion object {
        fun urlHost(host: String): String {
            val bare = if (host.startsWith("[") && host.endsWith("]")) {
                host.substring(1, host.length - 1)
            } else {
                host
            }
            return if (':' in bare) "[$bare]" else bare.substringBefore('%')
        }

        fun parse(text: String, defaultPort: Int = 8810): Connection? {
            var trimmed = text.trim()
            for (prefix in listOf("http://", "https://")) {
                if (trimmed.startsWith(prefix, ignoreCase = true)) {
                    trimmed = trimmed.drop(prefix.length)
                    break
                }
            }
            trimmed = trimmed.trimEnd('/')
            if (trimmed.isEmpty()) return null

            var parsedHost = trimmed
            var parsedPort = defaultPort
            if (trimmed.startsWith("[")) {
                val close = trimmed.indexOf(']')
                if (close < 0) return null
                parsedHost = trimmed.substring(1, close)
                val rest = trimmed.substring(close + 1)
                if (rest.isNotEmpty()) {
                    if (!rest.startsWith(":")) return null
                    parsedPort = rest.drop(1).toIntOrNull() ?: return null
                }
            } else if (trimmed.count { it == ':' } == 1) {
                val colon = trimmed.lastIndexOf(':')
                parsedHost = trimmed.substring(0, colon)
                parsedPort = trimmed.substring(colon + 1).toIntOrNull() ?: return null
            }

            if (parsedHost.isEmpty() || parsedHost.any { it.isWhitespace() || it in "/?#[]" }) return null
            if (parsedPort !in 1..65535) return null
            return Connection(name = parsedHost, host = urlHost(parsedHost), port = parsedPort)
        }
    }
}

data class PairingInvite(val connection: Connection, val credential: String) {
    companion object {
        fun parse(url: URI): PairingInvite? {
            if (!url.scheme.equals("openmausbot", ignoreCase = true) ||
                !url.host.equals("pair", ignoreCase = true)
            ) {
                return null
            }

            val values = linkedMapOf<String, String>()
            val query = url.rawQuery.orEmpty()
            if (query.isNotEmpty()) {
                for (item in query.split('&')) {
                    val equals = item.indexOf('=')
                    if (equals < 0) return null
                    val name = decodeQuery(item.substring(0, equals)) ?: return null
                    val value = decodeQuery(item.substring(equals + 1)) ?: return null
                    if (values.put(name, value) != null) return null
                }
            }

            val address = values["address"] ?: return null
            val credential = credential(values) ?: return null
            var connection = Connection.parse(address) ?: return null

            values["name"]?.trim()?.takeIf { it.isNotEmpty() }?.let { candidate ->
                val clean = candidate.filter { character ->
                    character != '\n' && character != '\r' &&
                        (character.code > 127 || (character.code >= 32 && character.code != 127))
                }
                if (clean.isNotEmpty()) connection = connection.copy(name = clean.take(80))
            }

            values["hosts"]?.let { list ->
                val candidates = list.split(',')
                    .map { it.trim(' ', '\t') }
                    .filter { candidate ->
                        candidate.isNotEmpty() &&
                            candidate.toByteArray(StandardCharsets.UTF_8).size <= 253 &&
                            candidate.none { it.isWhitespace() || it in "/?#" }
                    }
                    .take(8)
                if (candidates.isNotEmpty()) connection = connection.copy(hosts = candidates)
            }

            return PairingInvite(connection, credential)
        }

        fun parse(url: String): PairingInvite? = runCatching { URI(url) }.getOrNull()?.let(::parse)

        private fun credential(values: Map<String, String>): String? {
            values["token"]?.let { token ->
                val suffix = token.removePrefix("omb_pair_")
                if (!token.startsWith("omb_pair_") || token.toByteArray().size != 52 || suffix.length != 43) {
                    return null
                }
                if (suffix.all { it.isLetterOrDigit() && it.code < 128 || it == '-' || it == '_' }) return token
                return null
            }
            return values["code"]?.takeIf { code -> code.length == 6 && code.all { it in '0'..'9' } }
        }

        /** Percent-decode a URI query component without form-url-decoding '+'. */
        private fun decodeQuery(value: String): String? = runCatching {
            val bytes = ByteArrayOutputStream(value.length)
            var index = 0
            while (index < value.length) {
                if (value[index] == '%') {
                    if (index + 2 >= value.length) return null
                    val high = value[index + 1].digitToIntOrNull(16) ?: return null
                    val low = value[index + 2].digitToIntOrNull(16) ?: return null
                    bytes.write((high shl 4) or low)
                    index += 3
                } else {
                    val codePoint = value.codePointAt(index)
                    bytes.write(String(Character.toChars(codePoint)).toByteArray(StandardCharsets.UTF_8))
                    index += Character.charCount(codePoint)
                }
            }
            StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes.toByteArray()))
                .toString()
        }.getOrNull()
    }
}

sealed class APIError(message: String, cause: Throwable? = null) : IOException(message, cause) {
    class Status(val code: Int, val serverMessage: String? = null) :
        APIError(serverMessage ?: defaultMessage(code))

    class Transport(val detail: String, cause: Throwable? = null) : APIError(detail, cause)

    data object BadUrl : APIError("That address doesn't look right.")

    val isUnauthorized: Boolean get() = this is Status && code == 401

    companion object {
        private fun defaultMessage(code: Int): String = when (code) {
            401 -> "This phone is not paired with that computer."
            403 -> "That can only be done on the computer itself."
            404 -> "That is no longer there."
            409 -> "The bot is busy — stop it first."
            else -> "The computer answered with an error ($code)."
        }
    }
}
