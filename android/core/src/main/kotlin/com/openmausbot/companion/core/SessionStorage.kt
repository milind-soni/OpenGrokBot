package com.openmausbot.companion.core

/**
 * Connection record store — UserDefaults analogue. Safe to back up; holds no token.
 */
interface ConnectionStore {
    suspend fun load(): Connection?
    suspend fun save(connection: Connection)
    suspend fun clear()
}

/**
 * Device-token store — Keychain analogue. Must not appear in any backup path.
 *
 * Distinguishes "no token" from "cannot read yet" the same way iOS Keychain does:
 * a locked/unavailable store is offline, never unpaired.
 */
interface TokenStore {
    sealed class ReadResult {
        data class Found(val token: String) : ReadResult()
        data object Missing : ReadResult()
        data class Unavailable(val locked: Boolean, val message: String) : ReadResult()
    }

    suspend fun save(connectionId: String, token: String)
    suspend fun read(connectionId: String): ReadResult
    suspend fun remove(connectionId: String)
}

/** Local notification surface fed by live/replayed notify frames. */
interface NotificationSink {
    fun deliver(notification: NotificationFrame, sequence: Int?)
    fun setBadge(count: Int)
}

object NoOpNotificationSink : NotificationSink {
    override fun deliver(notification: NotificationFrame, sequence: Int?) = Unit
    override fun setBadge(count: Int) = Unit
}

data class ExportedTranscript(
    val data: ByteArray,
    val filename: String,
    val contentType: String,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is ExportedTranscript) return false
        return filename == other.filename &&
            contentType == other.contentType &&
            data.contentEquals(other.data)
    }

    override fun hashCode(): Int {
        var result = data.contentHashCode()
        result = 31 * result + filename.hashCode()
        result = 31 * result + contentType.hashCode()
        return result
    }
}
