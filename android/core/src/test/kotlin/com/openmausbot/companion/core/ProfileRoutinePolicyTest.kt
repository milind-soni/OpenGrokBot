package com.openmausbot.companion.core

import kotlinx.serialization.decodeFromString
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ProfileRoutinePolicyTest {
    @Test
    fun onlyFutureOneTimeRoutinesCanToggle() {
        val now = 2_000_000.0

        assertTrue(routine(RoutineSchedule.daily("09:00", listOf(1))).canToggle(now))
        assertTrue(routine(RoutineSchedule.once(now + 1_000)).canToggle(now))
        assertFalse(routine(RoutineSchedule.once(now)).canToggle(now))
        assertFalse(routine(RoutineSchedule.once(now - 1_000)).canToggle(now))
        assertFalse(
            routine(RoutineSchedule(RoutineSchedule.Kind.UNKNOWN, at = now + 1_000)).canToggle(now),
            "an unsupported kind stays non-toggleable even when it carries a future at field",
        )
    }

    @Test
    fun cloudRunAvailabilityMatchesDesktopRequirements() {
        val configured = decodeConfig("""{"box":{"configured":true}}""")
        val unconfigured = decodeConfig("""{"box":{"configured":false}}""")
        val available = decodeInstances("available")
        val unavailable = decodeInstances("unavailable")

        assertFalse(RoutineRunAvailability(unconfigured, available).cloudReady)
        assertFalse(RoutineRunAvailability(configured, unavailable).cloudReady)

        val ready = RoutineRunAvailability(configured, available)
        assertTrue(ready.cloudReady)
        assertTrue(ready.canSelect(RoutineRunLocation.CLOUD, preserving = RoutineRunLocation.MAUS))

        val offline = RoutineRunAvailability(configured, unavailable)
        assertFalse(offline.canSelect(RoutineRunLocation.CLOUD, preserving = RoutineRunLocation.MAUS))
        assertTrue(
            offline.canSelect(RoutineRunLocation.CLOUD, preserving = RoutineRunLocation.CLOUD),
            "an existing cloud routine must not silently move",
        )
        assertTrue(offline.canSelect(RoutineRunLocation.MAUS, preserving = RoutineRunLocation.CLOUD))
    }

    @Test
    fun agentVoiceWorksWithoutANonexistentWorkspaceDefault() {
        val keyOnly = decodeConfig(
            """{"tts":{"configured":true,"ready":false,"voice":""}}""",
        )
        assertTrue(keyOnly.isTTSConfigured)
        assertFalse(keyOnly.hasWorkspaceDefaultVoice)
        assertFalse(keyOnly.canSpeak(agentVoice = null))
        assertTrue(keyOnly.canSpeak(agentVoice = "agent-voice"))

        val withDefault = decodeConfig(
            """{"tts":{"configured":true,"ready":true,"voice":"workspace-voice"}}""",
        )
        assertTrue(withDefault.hasWorkspaceDefaultVoice)
        assertTrue(withDefault.canSpeak(agentVoice = null))
    }

    @Test
    fun decodesImageGenerationStatus() {
        val config = decodeConfig("""{"imageGen":{"configured":true}}""")

        assertTrue(config.imageGen?.configured == true)
    }

    private fun routine(schedule: RoutineSchedule): Routine = Routine(
        id = "routine-1",
        name = "Brief",
        prompt = "Summarize",
        botId = "bot-1",
        runOn = "maus",
        enabled = false,
        schedule = schedule,
        durationMinutes = 30,
        nextRunAt = null,
        createdAt = 1.0,
        updatedAt = 1.0,
    )

    private fun decodeConfig(json: String): ConfigStatus = CompanionJson.decodeFromString(json)

    private fun decodeInstances(state: String): List<Instance> = CompanionJson.decodeFromString<InstanceList>(
        """{"instances":[{
          "instanceId":"box-1","driverKind":"boxAgent",
          "snapshot":{"state":"$state"},
          "models":{"default":"model-1","options":[]}
        }]}""",
    ).instances
}
