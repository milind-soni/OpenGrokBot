package com.openmausbot.companion.core

import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException
import kotlin.coroutines.cancellation.CancellationException

class CandidateRotation(val hosts: List<String>) {
    private var index = 0

    val current: String get() = hosts.getOrNull(index).orEmpty()
    val count: Int get() = hosts.size

    fun advance(): String {
        if (hosts.isEmpty()) return ""
        index = (index + 1) % hosts.size
        return current
    }

    fun promoted(): List<String> {
        val winner = hosts.getOrNull(index) ?: return hosts
        return listOf(winner) + hosts.filterIndexed { candidateIndex, _ -> candidateIndex != index }
    }
}

enum class ConnectionFailure {
    CANNOT_FIND_HOST,
    CANNOT_CONNECT_TO_HOST,
    TIMED_OUT,
    SECURE_CONNECTION_FAILED,
    NOT_CONNECTED_TO_INTERNET,
    CANCELLED,
    NETWORK_CONNECTION_LOST,
    OTHER,
}

object ConnectionAdvice {
    fun shouldTryAnotherHost(failure: ConnectionFailure): Boolean = failure in setOf(
        ConnectionFailure.CANNOT_FIND_HOST,
        ConnectionFailure.CANNOT_CONNECT_TO_HOST,
        ConnectionFailure.TIMED_OUT,
        ConnectionFailure.SECURE_CONNECTION_FAILED,
    )

    fun shouldTryAnotherHost(error: Throwable): Boolean =
        shouldTryAnotherHost(classify(error))

    /** Map a transport failure to the URLError-shaped categories Session walks on. */
    fun classify(error: Throwable): ConnectionFailure {
        val chain = generateSequence(error) { it.cause }.toList()
        for (candidate in chain) {
            when (candidate) {
                is CancellationException -> return ConnectionFailure.CANCELLED
                is UnknownHostException -> return ConnectionFailure.CANNOT_FIND_HOST
                is ConnectException -> return ConnectionFailure.CANNOT_CONNECT_TO_HOST
                is SocketTimeoutException -> return ConnectionFailure.TIMED_OUT
                is SSLException -> return ConnectionFailure.SECURE_CONNECTION_FAILED
                is java.net.NoRouteToHostException -> return ConnectionFailure.TIMED_OUT
                is java.net.SocketException -> {
                    val detail = candidate.message.orEmpty().lowercase()
                    if ("network is unreachable" in detail || "no route" in detail) {
                        return ConnectionFailure.TIMED_OUT
                    }
                    if ("connection refused" in detail) {
                        return ConnectionFailure.CANNOT_CONNECT_TO_HOST
                    }
                    if ("reset" in detail || "broken pipe" in detail || "connection abort" in detail) {
                        return ConnectionFailure.NETWORK_CONNECTION_LOST
                    }
                }
            }
        }
        val detail = chain.joinToString(" ") { it.message.orEmpty() }.lowercase()
        return when {
            "unable to resolve host" in detail || "unknown host" in detail ->
                ConnectionFailure.CANNOT_FIND_HOST
            "failed to connect" in detail || "connection refused" in detail ->
                ConnectionFailure.CANNOT_CONNECT_TO_HOST
            "timeout" in detail || "timed out" in detail ->
                ConnectionFailure.TIMED_OUT
            "cleartext" in detail || "ssl" in detail || "tls" in detail ->
                ConnectionFailure.SECURE_CONNECTION_FAILED
            "offline" in detail || "no address associated" in detail ->
                ConnectionFailure.NOT_CONNECTED_TO_INTERNET
            else -> ConnectionFailure.OTHER
        }
    }

    fun message(
        failure: ConnectionFailure,
        host: String,
        port: Int,
        tryingNext: String? = null,
    ): String {
        val advice = when (failure) {
            ConnectionFailure.CANNOT_FIND_HOST ->
                "“$host” didn't resolve. If that's a Tailscale name, this phone may not be on the tailnet."
            ConnectionFailure.CANNOT_CONNECT_TO_HOST ->
                "Reached your computer, but the companion isn't answering on port $port — open OpenMausBot → Settings → Companion."
            ConnectionFailure.TIMED_OUT ->
                "No route to your computer at $host — different network, or a firewall."
            ConnectionFailure.NOT_CONNECTED_TO_INTERNET -> "You're offline."
            else -> "Could not reach $host."
        }
        val fallback = tryingNext?.let { " Trying $it next." }.orEmpty()
        return advice + fallback + " The app keeps retrying automatically."
    }

    fun message(
        error: Throwable,
        host: String,
        port: Int,
        tryingNext: String? = null,
    ): String {
        val failure = classify(error)
        return if (failure == ConnectionFailure.OTHER) {
            error.message?.takeIf { it.isNotBlank() } ?: message(failure, host, port, tryingNext)
        } else {
            message(failure, host, port, tryingNext)
        }
    }
}
