package com.openmausbot.companion.core

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.decodeFromString
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

data class SSEEvent(val id: String? = null, val data: String)

/** A line-oriented parser whose empty input line is the SSE event terminator. */
class SSEParser {
    private val fields = mutableListOf<Pair<String, String>>()

    fun line(raw: String): SSEEvent? {
        val line = raw.removeSuffix("\r")
        if (line.isEmpty()) {
            val event = event(fields)
            fields.clear()
            return event
        }
        if (line.startsWith(':')) return null
        val colon = line.indexOf(':')
        if (colon < 0) return null
        var value = line.substring(colon + 1)
        if (value.startsWith(' ')) value = value.drop(1)
        fields += line.substring(0, colon) to value
        return null
    }

    /** Discards an event that never received its terminating blank line. */
    fun reset() {
        fields.clear()
    }

    companion object {
        internal fun event(fields: List<Pair<String, String>>): SSEEvent? {
            var id: String? = null
            val data = mutableListOf<String>()
            fields.forEach { (name, value) ->
                when (name) {
                    "id" -> id = value
                    "data" -> data += value
                }
            }
            return data.takeIf { it.isNotEmpty() }?.let { SSEEvent(id, it.joinToString("\n")) }
        }
    }
}

/**
 * Reads an OkHttp response as raw bytes so consecutive newlines remain visible
 * to [SSEParser]. Malformed JSON drops one frame; unknown frame kinds decode as
 * [Frame.Unknown] and keep the stream alive.
 */
fun eventStream(
    request: Request,
    client: OkHttpClient,
): Flow<StreamFrame> = callbackFlow {
    val call = client.newCall(request)
    val responseRef = AtomicReference<Response?>(null)
    val reader = launch(Dispatchers.IO) {
        try {
            val response = call.execute()
            responseRef.set(response)
            if (response.code != 200) throw APIError.Status(response.code)
            val body = response.body ?: throw APIError.Transport("The computer sent an empty event stream.")
            val input = body.byteStream()
            val parser = SSEParser()
            val line = ByteArrayOutputStream()
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)

            while (isActive) {
                val count = input.read(buffer)
                if (count < 0) break
                for (index in 0 until count) {
                    val byte = buffer[index]
                    if (byte.toInt() != 0x0A) {
                        line.write(byte.toInt())
                        continue
                    }
                    val text = line.toByteArray().toString(Charsets.UTF_8)
                    line.reset()
                    val event = parser.line(text) ?: continue
                    val frame = runCatching {
                        CompanionJson.decodeFromString<StreamFrame>(event.data)
                    }.getOrNull() ?: continue
                    send(frame)
                }
            }
            parser.reset()
            close()
        } catch (_: CancellationException) {
            // A collector leaving the flow deliberately tears down the call.
        } catch (error: APIError) {
            close(error)
        } catch (error: IOException) {
            close(APIError.Transport(error.message ?: "Could not reach the computer.", error))
        } finally {
            responseRef.getAndSet(null)?.close()
        }
    }

    awaitClose {
        responseRef.getAndSet(null)?.close()
        call.cancel()
        reader.cancel()
    }
}
